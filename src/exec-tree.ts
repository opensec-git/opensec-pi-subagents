/**
 * exec-tree.ts — run a command so that a timeout or an abort ends everything it
 * started.
 *
 * Pi's `pi.exec` sends SIGTERM to the direct child only, and its SIGKILL
 * fallback never fires: it checks `proc.killed`, which is already true once
 * SIGTERM has been delivered. So a gate's `sh -c "npm test"` that times out
 * leaves the test runner and its workers running, in a worktree that is about
 * to be deleted, and a command that ignores SIGTERM holds the call open past
 * its limit. Git calls go the same way (hooks, filters).
 *
 * `execTree` starts the command in its own process group (POSIX) and signals
 * the whole group: SIGTERM first, SIGKILL after a grace period. On Windows it
 * uses `taskkill /T /F`, which ends the process and its descendants.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** How long a group gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5_000;
/** How long to keep reading after the command exits, for output still in the pipes. */
const EXIT_DRAIN_MS = 250;

export interface ExecTreeOptions extends ExecOptions {
  /** Override {@link KILL_GRACE_MS}. */
  killGraceMs?: number;
  /**
   * Also end the group once the command exits by itself. For gates: a test run
   * that leaves a server or watcher behind would otherwise outlive the
   * worktree it ran in.
   */
  killTreeOnExit?: boolean;
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Signal `pid` and everything in its process group (POSIX) or tree (Windows).
 * `leaderAlive` allows falling back to the pid alone when the group signal
 * fails; once the leader has exited its pid may belong to someone else.
 */
function signalTree(pid: number, signal: NodeJS.Signals, leaderAlive: boolean): void {
  if (IS_WINDOWS) {
    // The System32 path, so cleanup does not depend on PATH; /F because console
    // programs ignore the polite form. Both signals map to the same thing.
    try {
      const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {});
    } catch { /* nothing left to kill */ }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    if (!leaderAlive) return;
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

/** Like `pi.exec`, but a timeout or abort ends the command's whole process tree. */
export function execTree(command: string, args: string[], options: ExecTreeOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so the group can be signalled as a whole.
        detached: !IS_WINDOWS,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ stdout: "", stderr: err instanceof Error ? err.message : String(err), code: 1, killed: false });
      return;
    }

    const pid = proc.pid;
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let drainId: ReturnType<typeof setTimeout> | undefined;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    /** SIGTERM the tree now, SIGKILL it after the grace period whatever happens meanwhile. */
    const endTree = () => {
      if (pid === undefined) return;
      signalTree(pid, "SIGTERM", !exited);
      const escalate = setTimeout(() => signalTree(pid, "SIGKILL", !exited), options.killGraceMs ?? KILL_GRACE_MS);
      escalate.unref?.();
    };
    const kill = () => {
      if (killed || settled) return;
      killed = true;
      endTree();
    };
    const onAbort = () => kill();

    const finish = (code: number, extraStderr?: string) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (drainId) clearTimeout(drainId);
      options.signal?.removeEventListener("abort", onAbort);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      resolve({ stdout, stderr: extraStderr ? `${stderr}${extraStderr}` : stderr, code, killed });
    };
    const exitStatus = () => exitCode ?? (exitSignal ? 1 : 0);

    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    // A command that cannot start (ENOENT) never emits `exit`.
    proc.once("error", (err) => finish(1, err.message));
    proc.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (options.killTreeOnExit && !killed) endTree();
      // A descendant may hold the pipes open; stop waiting for it shortly.
      drainId = setTimeout(() => finish(exitStatus()), EXIT_DRAIN_MS);
    });
    proc.once("close", () => finish(exitStatus()));

    if (options.signal) {
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeout && options.timeout > 0) timeoutId = setTimeout(kill, options.timeout);
  });
}

/** The API objects whose commands run through {@link execTree}. */
const treeKillingApis = new WeakSet<object>();

/**
 * Run this API object's gate and git commands through {@link execTree}.
 *
 * Called once, with the API the extension was activated with. Everything else
 * that reaches the worktree and gate code — test doubles in particular — keeps
 * its own `exec`, which is the seam those tests inject results through.
 */
export function useTreeKillingExec(pi: object): void {
  treeKillingApis.add(pi);
}

/** The `exec` to run gate and git commands with for `pi`. */
export function commandExec(pi: Pick<ExtensionAPI, "exec">): (command: string, args: string[], options?: ExecTreeOptions) => Promise<ExecResult> {
  return treeKillingApis.has(pi) ? execTree : (command, args, options) => pi.exec(command, args, options);
}
