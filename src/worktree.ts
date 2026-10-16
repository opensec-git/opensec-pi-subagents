/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 *
 * Every git call goes through `pi.exec` (async) rather than `execFileSync`: a
 * worktree copy can take seconds, and a session that spawns several isolated
 * agents at once would otherwise serialize them all on the TUI's event loop.
 */

import { existsSync, mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /**
   * The worktree path. With a branch, where the work was (the worktree itself
   * is removed); without one, a worktree that was KEPT because its state could
   * not be read or its changes could not be committed to a branch.
   */
  path?: string;
}

/** Author used only when the repository has no git identity configured. */
const FALLBACK_IDENTITY = ["-c", "user.name=pi-agent", "-c", "user.email=pi-agent@localhost"];

/**
 * Run git and return its trimmed stdout, throwing on failure so callers keep
 * the try/catch control flow `execFileSync` gave them.
 *
 * `pi.exec` never rejects — it reports failure in the result — and a command
 * killed by its timeout comes back as `killed` with an exit code of 0, so both
 * have to be checked to reproduce `execFileSync`'s "throws on anything but a
 * clean exit".
 */
async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout: number): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
): Promise<WorktreeInfo | undefined> {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000);
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000);
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  // A private (0700, mkdtemp) parent, so other local users cannot read the
  // copied repository the way they could a worktree made directly in $TMPDIR.
  let parent: string;
  try {
    parent = mkdtempSync(join(tmpdir(), `pi-agent-${agentId}-`));
  } catch {
    return undefined;
  }
  const worktreePath = join(parent, branch);

  try {
    // Create detached worktree at HEAD
    await git(pi, cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30000);
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    removeParentDir(worktreePath);
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) {
    removeParentDir(worktree.path);
    return { hasChanges: false };
  }

  // The worktree is removed only when it provably holds nothing: status read
  // and empty, and HEAD read and still at the base commit. Any failure along
  // the way (a timeout, a commit or branch error) keeps it and reports where
  // it is, since removing it with --force would discard the agent's work while
  // reporting that it made none.
  const kept: WorktreeCleanupResult = { hasChanges: true, path: worktree.path };
  try {
    // Check for uncommitted changes in the worktree
    const status = await git(pi, worktree.path, ["status", "--porcelain"], 10000);

    if (status) {
      // Changes exist — stage, commit, and create a branch
      await git(pi, worktree.path, ["add", "-A"], 10000);
      // Truncate description for commit message (no shell sanitization needed — pi.exec uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      // No signing: a gpg/ssh signing setup that needs a passphrase or agent
      // would fail (or hang) this unattended commit.
      const commitArgs = ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", `pi-agent: ${safeDesc}`];
      try {
        await git(pi, worktree.path, commitArgs, 10000);
      } catch {
        // Most often "Please tell me who you are": no user.name/user.email on
        // this machine. Commit as a placeholder author rather than lose the work.
        await git(pi, worktree.path, [...FALLBACK_IDENTITY, ...commitArgs], 10000);
      }
    } else {
      const currentSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree
        await removeWorktree(pi, cwd, worktree.path);
        return { hasChanges: false };
      }
      // The agent committed on its own; those commits live only here.
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    try {
      await git(pi, worktree.path, ["branch", branchName], 5000);
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(pi, worktree.path, ["branch", branchName], 5000);
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;
  } catch {
    return kept;
  }

  // Remove the worktree (branch persists in main repo)
  await removeWorktree(pi, cwd, worktree.path);

  return {
    hasChanges: true,
    branch: worktree.branch,
    path: worktree.path,
  };
}

/** Remove the private parent createWorktree made, once the worktree is gone. */
function removeParentDir(worktreePath: string): void {
  try { rmdirSync(dirname(worktreePath)); } catch { /* not empty or already gone */ }
}

/**
 * Force-remove a worktree.
 */
async function removeWorktree(pi: ExtensionAPI, cwd: string, worktreePath: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000);
  } catch {
    // If git worktree remove fails, try pruning
    try {
      await git(pi, cwd, ["worktree", "prune"], 5000);
    } catch { /* ignore */ }
  }
  removeParentDir(worktreePath);
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000);
  } catch { /* ignore */ }
}
