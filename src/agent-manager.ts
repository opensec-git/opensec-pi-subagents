/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * There are two independent concurrency pools, never one:
 *
 * - Background (`maxConcurrent`, default 10) bounds detached agents.
 * - Foreground (`maxConcurrentForeground`, default 0 = unlimited) bounds
 *   agents a caller is blocking on inline — `spawnAndWait`.
 *
 * Independent by design: a foreground agent blocks the parent anyway, so
 * charging it to the background pool would let a saturated pool starve the main
 * session of work it could have done itself. Excess agents in either pool are
 * queued and auto-started as slots free up. Nested children take no slot in
 * either — see `occupiesPoolSlot` / `occupiesForegroundSlot`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { extractText } from "./context.js";
import { assignHandle, handleBase } from "./mention.js";
import { describeModel } from "./model-resolver.js";
import { sessionFileProblem } from "./session-file.js";
import { sessionFileOf, snapshotContext } from "./session-handoff.js";
import type { AgentInvocation, AgentRecord, AgentResumeState, AgentTombstone, IsolationMode, MentionResolution, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import type { CompiledSchema } from "./workflow/json-schema.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, restoreWorktree } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for EVERY agent this manager owns —
 * top-level and nested alike, spawns and resumes. The one place where each
 * message is seen exactly once: `AgentRecord.lifetimeUsage` is deliberately
 * double-booked into ancestors (see `nested-tools.ts`) so a hidden child's spend
 * shows up on the record a human can see, which makes those records useless as
 * a basis for anything that must not count a message twice — parent-session
 * accounting above all.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** What the extension instance observes of the manager's agents. */
export interface ManagerObservers {
  onComplete?: OnAgentComplete;
  onStart?: OnAgentStart;
  onCompact?: OnAgentCompact;
  onUsage?: OnAgentUsage;
}

/**
 * The module functions the manager runs agents and worktrees with. Pi loads a
 * fresh copy of this extension's modules for every session, and a manager kept
 * across a session switch (session-handoff.ts) was built by an older copy: the
 * adopting instance hands it its own, so new spawns see the current session's
 * agent registry and settings. Runs already going keep the ones they started
 * with. Unset, the manager uses its own module's imports.
 */
export interface ManagerServices {
  runAgent: typeof runAgent;
  resumeAgent: typeof resumeAgent;
  createWorktree: typeof createWorktree;
  cleanupWorktree: typeof cleanupWorktree;
  restoreWorktree: typeof restoreWorktree;
  isWorktreeIsolationEnabled: typeof isWorktreeIsolationEnabled;
  pruneWorktrees: typeof pruneWorktrees;
  sessionFileProblem: typeof sessionFileProblem;
  /** The agent registry the current session loaded (an agent file's `isolation:`). */
  getAgentConfig: typeof getAgentConfig;
}

/**
 * This module's {@link ManagerServices}, for an instance adopting a manager
 * built by another copy. Getters, so each import is read only when used.
 */
export function managerServices(): ManagerServices {
  return {
    get runAgent() { return runAgent; },
    get resumeAgent() { return resumeAgent; },
    get createWorktree() { return createWorktree; },
    get cleanupWorktree() { return cleanupWorktree; },
    get restoreWorktree() { return restoreWorktree; },
    get isWorktreeIsolationEnabled() { return isWorktreeIsolationEnabled; },
    get pruneWorktrees() { return pruneWorktrees; },
    get sessionFileProblem() { return sessionFileProblem; },
    get getAgentConfig() { return getAgentConfig; },
  };
}

/**
 * Default max concurrent background agents.
 *
 * Raised from 4 when top-level spawns started defaulting to background
 * (`backgroundByDefault`): foreground agents bypass this pool entirely, so
 * while foreground was the default a fan-out of six ran six. With background
 * as the default every top-level agent takes a slot, and a limit of 4 would
 * have silently queued the tail of exactly the parallel fan-outs the `Agent`
 * tool description tells the model to send.
 */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * Default max concurrent foreground (blocking) agents — `0` = unlimited, the
 * extension's existing convention for "no ceiling" (`defaultMaxTurns`).
 *
 * Off by default because nothing here ever bounded foreground work, and pi
 * dispatches a message's tool calls through `Promise.all`, so an unqualified
 * fan-out of blocking `Agent` calls has always run all at once. Users who want
 * it bounded — chiefly local models, where parallel agents thrash the prompt
 * cache (#253) — opt in; everyone else keeps today's behaviour exactly.
 */
const DEFAULT_MAX_CONCURRENT_FOREGROUND = 0;

/**
 * How many evicted agents stay addressable — by name, by resume, and by
 * get_subagent_result, which reads a released agent's result from its saved
 * session. Only a bound on memory: an entry is a few hundred bytes of ids and
 * paths (about 450 B, 700 B with a worktree), never the conversation, so 2000
 * cost about 1 MB. High because a session that spawns hundreds of agents
 * should still be able to read the result of any of them.
 */
const MAX_TOMBSTONES = 2000;

/**
 * The same bound for owned children — nested agents and workflow children —
 * counted apart, so a large workflow cannot push the session's own agents out.
 */
const MAX_OWNED_TOMBSTONES = 4000;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.isBackground && isTopLevelAgent(record);
}

/**
 * Whether a record is one of the session's own agents, rather than something
 * another agent or a workflow owns.
 *
 * The single definition behind every user-facing surface — the fleet list, the
 * widget, the `/agents` menus, `@handle` resolution, and the completion events
 * and session entries. An owned child reports through its owner, so surfacing
 * it separately would double-count the same work in the places a person reads.
 */
export function isTopLevelAgent(
  record: Pick<AgentRecord, "parentAgentId" | "workflowId">,
): boolean {
  return record.parentAgentId === undefined && record.workflowId === undefined;
}

/**
 * Whether a record occupies one of the `maxConcurrentForeground` slots.
 *
 * Keyed on `blocking` — a caller awaiting this record inline — rather than on
 * `isBackground === false`, because `spawn()` is also the funnel for DETACHED
 * starts (cross-extension RPC, `@handle` mentions, the registry) that may pass
 * `isBackground: false` and are documented to run immediately regardless. Those
 * block nobody, so bounding them buys nothing and would park a record with no
 * one waiting to release it.
 *
 * Nested children are excluded for the same reason as `occupiesPoolSlot`, and
 * more sharply: their parent is blocked *awaiting them*, so queueing a child
 * behind its own parent is a guaranteed deadlock rather than a possible one.
 * Enforced here rather than at the call site so no caller can reintroduce it.
 *
 * A workflow's children go out through `spawnAndWait` and so are `blocking`
 * too, and are excluded on the same `isTopLevelAgent` test as the background
 * pool: the run already caps how many of its agents run at once, and charging
 * them here as well would let one fan-out queue behind a limit meant for the
 * session's own work.
 *
 * Like the background pool this bounds width at the top level only — a parent's
 * own fan-out is limited by nothing but its turn budget.
 */
function occupiesForegroundSlot(
  record: Pick<AgentRecord, "blocking" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.blocking && isTopLevelAgent(record);
}

/** Which concurrency pool a spawn is charged to, if any. */
type Pool = "background" | "foreground";

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  /**
   * Optional memorable name for this instance, becoming a second handle
   * (`@auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * mention of an evicted agent continues where it left off. The agent's
   * definition is still resolved from its type, so the continuation runs under
   * the type's CURRENT config.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps the handle the user just typed —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because tombstoned names are excluded from allocation
   * (`takenHandles`), so nothing live can be holding them.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   */
  reclaim?: { handle: string; alias?: string };
  /**
   * Reopen under this id instead of a fresh one, so an evicted agent the model
   * resumes by id keeps that id. Internal, like `reclaim`: only the manager's
   * own reopen path sets it, from a tombstone, and only when no live record
   * holds the id.
   */
  reuseId?: string;
  /**
   * Lifetime figures to continue from — a loaded agent reopened from its file
   * keeps counting where its record left off. Internal, like `reuseId`.
   */
  carry?: Pick<AgentRecord, "lifetimeUsage" | "toolUses" | "compactionCount">;
  /**
   * Restore this worktree (at its path, from its branch) instead of creating a
   * fresh one — the reopen of an evicted worktree agent. Internal.
   */
  restoreWorktree?: {
    worktree: { path: string; branch: string; baseSha: string; workPath: string };
    prior?: { hasChanges: boolean; branch?: string; path?: string };
  };
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip whichever pool's queue check applies to this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Used by the scheduler, so a fired job can't be deferred past its trigger
   * window, and by the `/agents` agent-file generator, which has no way to
   * cancel a wait (see its call site).
   */
  bypassQueue?: boolean;
  /**
   * A caller is awaiting this record inline (`spawnAndWait`) — what
   * `maxConcurrentForeground` bounds. Set only by `spawnAndWait`; stripped from
   * caller-supplied options by `spawnTopLevel`, since a forged `blocking` would
   * defer a detached start behind a queue its caller cannot see or release.
   */
  blocking?: boolean;
  /**
   * The workflow run this child belongs to, when a workflow spawned it.
   *
   * Ownership, not decoration. A workflow's children are the workflow's — they
   * report through its card, its notification and its dialog, so they are
   * filtered out of every top-level surface exactly as nested children are, and
   * they take no `maxConcurrent` slot: the run has its own concurrency cap, and
   * counting them twice would let one workflow starve the whole session.
   */
  workflowId?: string;
  /**
   * Make the child report through a `StructuredOutput` tool built from this
   * compiled schema. Set only by the workflow host, for `agent({ schema })`.
   */
  structuredOutput?: CompiledSchema;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /**
   * Last chance to look at an isolated agent's worktree, awaited after the
   * agent's changes are committed and before the worktree is removed. Whatever
   * it changes in the tree is discarded, so it never reaches the branch.
   *
   * Exists because that removal happens inside the settle path, before
   * `spawnAndWait` resolves: by the time a caller has the finished record, the
   * directory the child actually wrote in is gone. Anything that must inspect
   * or verify that tree — a workflow `gate` is the motivating case — has to run
   * here or it silently inspects the main tree instead.
   *
   * Fires only on the normal settle path, and only when a worktree was created.
   * Not on the error path and not on the stop-during-copy guard: those are
   * already failing, and delaying cleanup there would leak a copy for no gain.
   * A rejection is swallowed — the hook can never keep the worktree alive.
   */
  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called synchronously once the record is in the map and its promise is set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options rather than parked on the manager for the duration
   * of a spawn: with a foreground queue, `startAgent` can run at drain time,
   * long after any such field would have been restored, and the callback would
   * silently never fire (or fire into an unrelated caller's closure).
   */
  onSpawned?: (id: string) => void;
  /**
   * Called synchronously when the spawn is queued instead of started, with how
   * many entries in its own pool are ahead of it. The foreground UI uses it to
   * say so while it waits; nothing else needs it.
   */
  onQueued?: (id: string, ahead: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
}

interface ResumeOptions {
  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  /**
   * Turn limit for the resumed run. Default: the limit the agent's first run
   * enforced (`record.maxTurns`), counted afresh — with the same grace turns
   * and tool watchdog as a first run.
   */
  maxTurns?: number;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Called at the end of each agentic turn with the run's turn count. */
  onTurnEnd?: (turnCount: number) => void;
  /** The extension API for git calls (restoring a worktree). Default: the latest spawn's. */
  pi?: ExtensionAPI;
  /**
   * The session context to reopen an evicted agent in. Without it, only an
   * agent still in memory can be resumed.
   */
  ctx?: ExtensionContext;
  /**
   * Refuse to reopen an evicted agent whose type no longer resolves to itself
   * (deleted, disabled): its conversation must not continue under another
   * agent's prompt and tools. Returns the reason, or undefined to allow.
   */
  checkType?: (type: SubagentType) => string | undefined;
  /**
   * Called synchronously with the record that will run, before its run starts:
   * the live record, or the one a reopen creates. Where callers attach the
   * transcript file and per-run fields.
   */
  onRecord?: (record: AgentRecord) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
}

/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * How long a stopped run gets to end on its own before it is abandoned.
 *
 * Every stop ends in `session.abort()`, and pi's agent loop awaits a running
 * tool unconditionally: a tool that ignores its AbortSignal (an extension or
 * MCP tool, a hung `session_start`) keeps the run alive forever. Past this
 * grace the manager stops waiting for it: the slot is freed, the record is
 * settled as stopped and the completion fires, and anything queued proceeds.
 */
const DEFAULT_STOP_GRACE_MS = 20_000;

/**
 * How long an inline caller (a foreground `Agent` call, a nested or workflow
 * child) keeps waiting after a stop for the run to settle, before it returns
 * the stopped record anyway. Long enough for an ordinary stop to commit its
 * worktree; short enough that Esc never leaves the parent stuck on a run that
 * will not end.
 */
const INLINE_STOP_WAIT_MS = 3_000;

/**
 * How long a finished agent keeps its live session before it is released.
 *
 * A finished child's session still holds everything its extensions armed in
 * `session_start` (MCP clients, watchers, timers) until the record is evicted
 * ten minutes later — per agent, so a fan-out multiplies it. Past this delay a
 * saved session is shut down and disposed; its messages and stats stay
 * readable for the viewer and the result tools, and a resume reopens the
 * conversation from the session file instead. A resume within the delay
 * reuses the live session, which is faster.
 */
const DEFAULT_SESSION_RELEASE_MS = 60_000;

/**
 * A run the manager is still responsible for: from the moment it takes its
 * slot until it settles, normally or by abandonment. One per record at a time.
 */
interface LiveRun {
  id: string;
  record: AgentRecord;
  /** The pool charged when the run started, released exactly once. */
  pool: Pool | undefined;
  slotReleased: boolean;
  /** Settled: slot free, completion fired. Any later settle is a no-op. */
  settled: boolean;
  /**
   * Settled by abandonment: the real run may still be going and must not touch
   * the record, the worktree or the completion when it finally ends.
   */
  abandoned: boolean;
  /** Resolves once settled, normally or by abandonment. */
  done: Promise<void>;
  resolveDone: () => void;
  /** Resolves only on abandonment — raced against the run for every waiter. */
  whenAbandoned: Promise<void>;
  resolveAbandoned: () => void;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** Path-specific cleanup an abandoned run still owes (transcript, worktree, owned children). */
  onAbandon: () => Promise<void>;
}

/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi emits the event
 * itself in `AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds
 * extensions onto a session without going through that path. Without the emit, everything an
 * extension armed in `session_start` leaks once per spawn, and its next tick throws
 * `assertActive()` from a bare timer callback — an uncaughtException that kills pi (#242).
 */
async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    // Optional all the way down: on a pi without the getter, or a stubbed session from a
    // partial `onSessionCreated`, skip the emit — the same degrade as before this fix.
    if (runner?.hasHandlers?.("session_shutdown")) {
      // Raced, not awaited outright. `emit` runs every handler serially with no timeout of
      // its own, and dispose() is reached from pi's own `session_shutdown` with the TUI
      // already torn down — one hung handler would leave a dead terminal.
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
    }
  } catch { /* a partial session must degrade, not take the teardown down with it */ }
  // Always, even on timeout: disposal is what this function ultimately exists to do.
  try { session?.dispose?.(); } catch { /* ignore */ }
}

/**
 * The note telling the caller where an isolated agent's changes went: a branch
 * to merge, or a worktree kept on disk because they could not be committed (or
 * its state could not be read). Empty when the worktree held nothing.
 */
function worktreeNote(
  wtResult: { hasChanges: boolean; branch?: string; path?: string; kept?: boolean; notes?: string[] },
  baseCwd: string,
  customCwd: boolean,
): string {
  const lines: string[] = [];
  if (wtResult.hasChanges && wtResult.branch) {
    // With a caller-supplied cwd the branch lives in THAT repo, not the
    // parent session's — say so, or the orchestrator merges in the wrong repo.
    const repoNote = customCwd ? ` in \`${baseCwd}\`` : "";
    lines.push(`Changes saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd ? ` (run in \`${baseCwd}\`)` : ""}`);
  }
  // `kept` comes with its reasons in `notes`: the branch alone would lose them.
  if (wtResult.hasChanges && wtResult.path && (wtResult.kept || !wtResult.branch)) {
    lines.push(wtResult.kept
      ? `The worktree was kept at \`${wtResult.path}\` because removing it would delete work:`
      : `Changes could not be saved to a branch; the worktree was kept at \`${wtResult.path}\`.`);
  }
  for (const note of wtResult.notes ?? []) lines.push(`- ${note}`);
  return lines.length > 0 ? `\n\n---\n${lines.join("\n")}` : "";
}

/** How many messages a session holds — where a run's own turns begin. 0 for a stub. */
function messageCount(session: AgentSession | undefined): number {
  try {
    return session?.messages?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The last assistant text a session holds from message `start` on: what a run
 * that threw or was abandoned had produced. Bounded like the runner's own
 * fallback, so a failed resume never surfaces the previous run's answer
 * (#144). "" for none, or for a session that cannot be read.
 */
function salvageText(session: AgentSession | undefined, start: number): string {
  try {
    const messages = session?.messages ?? [];
    for (let i = messages.length - 1; i >= start; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      const text = extractText(msg.content).trim();
      if (text) return text;
    }
  } catch { /* a disposed or partial session has nothing to give */ }
  return "";
}

/** Keep what a failed run produced on its record, unless the run already reported text. */
function salvagePartial(record: AgentRecord, start: number): void {
  if (record.result?.trim()) return;
  const text = salvageText(record.session, start);
  if (text) record.result = text;
}

/**
 * Record the model and thinking level a run actually runs with, from its
 * session. Both are only knowable once pi has resolved its defaults and clamped
 * the level to what the model supports. Writing them back makes the record
 * authoritative, so every surface (the widget, the notification, the result
 * tools) reads one place instead of each re-deriving "session, else the
 * request" for itself. Called at the start of every run, so a resumed run
 * records its own.
 */
function recordRunModel(record: AgentRecord, session: AgentSession): void {
  if (!session.model) return;
  record.invocation ??= {};
  // Read the kept request first: a caller's level survives being clamped
  // AND, one line later, being replaced by the effective one.
  const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
  Object.assign(record.invocation, describeModel(session.model));
  // Guarded: a session that reports no level keeps the request rather than
  // losing it. Overwriting unconditionally would turn an older or stubbed
  // session into a blank `thinking:` tag, which is worse than the
  // stale-but-true value it replaced.
  if (session.thinkingLevel) {
    record.invocation.thinking = session.thinkingLevel;
    if (requested && requested !== session.thinkingLevel) {
      record.invocation.requestedThinking = requested;
    }
  }
}

/**
 * Whether a run is in flight or waiting for a slot. A function rather than an
 * inline test so TypeScript does not narrow `status` across an `await` that
 * can change it.
 */
function isBusy(record: AgentRecord): boolean {
  return record.status === "running" || record.status === "queued";
}

/**
 * Terminal status of a resumed run, with the spawn path's precedence: an
 * external stop stays "stopped", a hard abort at the turn limit is "aborted",
 * then a failed final turn is an honest "error" (#144) — the resumed text stays
 * available — then "steered" or "completed".
 */
function settleResumeStatus(
  record: AgentRecord,
  run: { failure?: string; aborted?: boolean; steered?: boolean },
): void {
  if (record.status === "stopped") return;
  if (run.aborted) record.status = "aborted";
  else if (run.failure) {
    record.status = "error";
    record.error = run.failure;
  } else record.status = run.steered ? "steered" : "completed";
}

function isTopLevelTombstone(entry: AgentResumeState): entry is AgentTombstone {
  return entry.handle !== undefined && isTopLevelAgent(entry);
}

/**
 * Everything needed to reopen a record's conversation and run it as it ran,
 * or undefined when there is no session file to reopen.
 */
export function resumeStateOf(record: AgentRecord): AgentResumeState | undefined {
  if (!record.sessionFile) return undefined;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    sessionFile: record.sessionFile,
    completedAt: record.completedAt ?? Date.now(),
    status: record.status,
    handle: record.handle,
    alias: record.alias,
    parentAgentId: record.parentAgentId,
    workflowId: record.workflowId,
    depth: record.depth,
    maxSubagentDepth: record.maxSubagentDepth,
    rootSessionId: record.rootSessionId,
    model: record.invocation?.modelId,
    thinking: record.invocation?.thinking,
    cwd: record.cwd,
    baseCwd: record.baseCwd,
    isolated: record.isolated,
    // Absent when no run settled to report one: the type's default applies.
    maxTurns: "maxTurns" in record ? (record.maxTurns ?? 0) : undefined,
    worktree: record.worktree ? { ...record.worktree } : undefined,
    worktreeResult: record.worktreeResult ? { ...record.worktreeResult } : undefined,
  };
}

/** Session entry a top-level agent's final record goes into (with its resume state). */
export const RECORD_ENTRY_TYPE = "subagents:record";
/**
 * Session entry an owned child's resume state goes into: a nested agent's or a
 * workflow's. Kept apart from {@link RECORD_ENTRY_TYPE}, which other extensions
 * read as the session's own agents, while an owned child reports only through
 * its owner. Carries the resume state alone, so it stays small.
 */
export const RESUME_ENTRY_TYPE = "subagents:resume";

/**
 * The resume states a session's `subagents:record` and `subagents:resume`
 * entries carry, oldest first. Entries written before they carried one, or
 * malformed ones, are skipped: there is nothing to reopen them from.
 */
export function resumeStatesFromEntries(entries: readonly unknown[]): AgentResumeState[] {
  const out: AgentResumeState[] = [];
  for (const entry of entries) {
    const e = entry as { type?: unknown; customType?: unknown; data?: { resume?: unknown } } | null;
    if (e?.type !== "custom" || (e.customType !== RECORD_ENTRY_TYPE && e.customType !== RESUME_ENTRY_TYPE)) continue;
    const state = e.data?.resume as Partial<AgentResumeState> | undefined;
    if (
      typeof state?.id !== "string" || typeof state.type !== "string"
      || typeof state.sessionFile !== "string" || typeof state.description !== "string"
    ) continue;
    out.push({ ...state, completedAt: typeof state.completedAt === "number" ? state.completedAt : 0 } as AgentResumeState);
  }
  return out;
}

/** The manager's own module functions, read lazily (see {@link managerServices}). */
const DEFAULT_SERVICES = managerServices();

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private maxConcurrent: number;
  private maxConcurrentForeground = DEFAULT_MAX_CONCURRENT_FOREGROUND;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();
  /** The extension API of the latest spawn, for git calls a resume makes. */
  private pi?: ExtensionAPI;

  /**
   * Startup phases, keyed by agent id. `spawn()` still returns synchronously,
   * but an agent using worktree isolation is not running yet when it does —
   * copying the repo is an awaited git call. This is what `awaitStartup` hands
   * callers that must fail their tool call on a startup failure, and what
   * `waitForAll` waits on while a record is "running" with no `promise` yet.
   * Entries are dropped once the run is underway, and kept (rejected) after a
   * startup failure so a late `awaitStartup` still sees it.
   */
  private startups = new Map<string, Promise<void>>();

  /**
   * Evicted agents that can still be resumed, keyed by id: by the model through
   * their id and, for top-level agents, by `@handle`. Outlives the 10-minute
   * record cleanup — that timer exists to bound memory, not to expire a
   * conversation that may still be continued — and is bounded by
   * MAX_TOMBSTONES. Rebuilt from the parent session on session start.
   */
  private tombstones = new Map<string, AgentResumeState>();

  /**
   * Agents waiting to start, tagged with the pool they wait on. One queue for
   * both pools: `drainQueue` picks the earliest entry whose own pool has room,
   * so neither can head-of-line-block the other, and every removal path
   * (`abort`, `abortAll`, `dispose`) stays a single filter.
   *
   * `release` wakes a caller blocked in `spawnAndWait`, and is fired once the
   * entry's `start` has SETTLED rather than at drain time: startup is async
   * now, so releasing earlier would wake the caller before `record.promise`
   * exists and it would read a still-starting agent as one that never ran.
   * Removing an entry from this array MUST release it — a queued record has no
   * promise to await, and pi has no tool-execution timeout to bail the caller
   * out.
   */
  private queue: { id: string; pool: Pool; start: () => Promise<void>; release: () => void }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Number of currently running foreground (blocking) agents. */
  private runningForeground = 0;
  /** Runs that have not settled yet, by agent id — including stopped ones still winding down. */
  private runs = new Map<string, LiveRun>();
  private stopGraceMs = DEFAULT_STOP_GRACE_MS;
  /** Records whose finished session was released (shut down and disposed). */
  private released = new WeakSet<AgentRecord>();
  /** Pending releases, by record. */
  private releaseTimers = new Map<AgentRecord, ReturnType<typeof setTimeout>>();
  private sessionReleaseMs = DEFAULT_SESSION_RELEASE_MS;
  /** Set by an instance that adopted this manager; see {@link ManagerServices}. */
  private services?: ManagerServices;
  /**
   * The session whose agents the top-level surfaces show (`listAgents`,
   * `resolveMention`, `hasRunning`, `waitForAll`). `null`: every agent — the
   * default, and the only mode before a session has started.
   */
  private visibleOwner: string | undefined | null = null;
  /**
   * Arguments of spawns that have not reached `runAgent` yet (queued, or still
   * creating their worktree), so a session switch can swap their context for a
   * frozen copy before Pi invalidates it.
   */
  private pendingArgs = new Map<string, SpawnArgs>();

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Replace what the extension observes of this manager's agents (an adopting instance, or parking). */
  setObservers(observers: ManagerObservers): void {
    this.onComplete = observers.onComplete;
    this.onStart = observers.onStart;
    this.onCompact = observers.onCompact;
    this.onUsage = observers.onUsage;
  }

  /** Run new work with these module functions; see {@link ManagerServices}. */
  useServices(services: ManagerServices): void {
    this.services = services;
  }

  private svc(): ManagerServices {
    return this.services ?? DEFAULT_SERVICES;
  }

  /**
   * Show only the agents of this session (its file; undefined for one in
   * memory) on the top-level surfaces, or every agent with `null`. Agents of
   * other sessions keep running and are reachable by id internally — their
   * nested tools, the workflow host — just not listed or addressable here.
   */
  setVisibleOwner(owner: string | undefined | null): void {
    this.visibleOwner = owner;
  }

  /** Whether the record belongs to the session the surfaces show. */
  isVisible(record: Pick<AgentRecord, "ownerSession">): boolean {
    return this.visibleOwner === null || record.ownerSession === this.visibleOwner;
  }

  /**
   * Before a session switch: give every spawn that has not started its run yet
   * a frozen copy of its context, since Pi invalidates the live one (every read
   * throws) and the spawn reads it when it starts.
   */
  detachPendingContexts(): void {
    for (const args of this.pendingArgs.values()) args.ctx = snapshotContext(args.ctx);
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Update the max concurrent foreground (blocking) agents limit. 0 = unlimited. */
  setMaxConcurrentForeground(n: number) {
    // Floor 0, not 1: unlimited is a meaningful value here and the default.
    this.maxConcurrentForeground = Math.max(0, n);
    // Start queued agents if the new limit allows — including everything, when
    // the limit is cleared back to unlimited mid-run.
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

  /** How long a stopped run may take to end before it is abandoned (see DEFAULT_STOP_GRACE_MS). */
  setStopGraceMs(ms: number) {
    this.stopGraceMs = Math.max(0, ms);
  }

  /** How long a finished agent keeps its live session (see DEFAULT_SESSION_RELEASE_MS). */
  setSessionReleaseMs(ms: number) {
    this.sessionReleaseMs = Math.max(0, ms);
  }

  /**
   * After a run settles, schedule the release of its session. Only a saved
   * session (it has a file to reopen from) that is idle: an in-memory one is
   * the only copy of the conversation, and a stuck one is handled by resume.
   */
  private scheduleRelease(record: AgentRecord): void {
    this.cancelRelease(record);
    if (!record.session || !record.sessionFile) return;
    const timer = setTimeout(() => {
      this.releaseTimers.delete(record);
      this.releaseSession(record);
    }, this.sessionReleaseMs);
    (timer as { unref?: () => void }).unref?.();
    this.releaseTimers.set(record, timer);
  }

  private cancelRelease(record: AgentRecord): void {
    const timer = this.releaseTimers.get(record);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.releaseTimers.delete(record);
  }

  /** Shut down and dispose a finished agent's session, keeping it readable. */
  private releaseSession(record: AgentRecord): void {
    const session = record.session;
    if (!session || this.released.has(record)) return;
    if (this.agents.get(record.id) !== record || this.isRunActive(record.id) || session.isStreaming === true) return;
    this.released.add(record);
    void shutdownChildSession(session);
  }

  /** Whether resuming must reopen the conversation from its file: the live session is gone or stuck. */
  private needsReopen(record: AgentRecord): boolean {
    return this.released.has(record) || record.session?.isStreaming === true;
  }

  /**
   * Take a run's slot and start tracking it until it settles. The single place
   * a pool counter goes up; `releaseRunSlot` is the single place it comes down.
   */
  private beginRun(id: string, record: AgentRecord, pool: Pool | undefined): LiveRun {
    let resolveDone!: () => void;
    let resolveAbandoned!: () => void;
    const run: LiveRun = {
      id,
      record,
      pool,
      slotReleased: false,
      settled: false,
      abandoned: false,
      done: new Promise<void>(resolve => { resolveDone = resolve; }),
      resolveDone: () => resolveDone(),
      whenAbandoned: new Promise<void>(resolve => { resolveAbandoned = resolve; }),
      resolveAbandoned: () => resolveAbandoned(),
      onAbandon: async () => {},
    };
    if (pool === "background") this.runningBackground++;
    else if (pool === "foreground") this.runningForeground++;
    this.runs.set(id, run);
    return run;
  }

  /** Give back the run's slot. Idempotent: a slot is released exactly once. */
  private releaseRunSlot(run: LiveRun): void {
    if (run.slotReleased) return;
    run.slotReleased = true;
    if (run.pool === "background") this.runningBackground--;
    else if (run.pool === "foreground") this.runningForeground--;
  }

  /** Stop tracking a run that never got going (a startup failure): no completion. */
  private discardRun(run: LiveRun): void {
    this.releaseRunSlot(run);
    run.settled = true;
    if (run.graceTimer) clearTimeout(run.graceTimer);
    if (this.runs.get(run.id) === run) this.runs.delete(run.id);
    run.resolveDone();
  }

  /**
   * The shared tail of every settle path, normal or abandoned: release the
   * slot, notify, and let the queue drain into it. Idempotent, so a run that
   * was abandoned and then ends after all settles only once.
   */
  private endRun(run: LiveRun): void {
    if (run.settled) return;
    run.settled = true;
    // Nobody waits on a settled run; a later foreground resume must not look
    // like a spawn `sendToBackground` could hand off.
    run.record.blocking = false;
    if (run.graceTimer) clearTimeout(run.graceTimer);
    if (this.runs.get(run.id) === run) this.runs.delete(run.id);
    this.releaseRunSlot(run);
    this.notifyComplete(run.record);
    this.drainQueue();
    run.resolveDone();
    if (!run.abandoned) this.scheduleRelease(run.record);
  }

  /** Fire onComplete. Never throws: a completion side effect must not take a run (or pi) down. */
  private notifyComplete(record: AgentRecord): void {
    try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
  }

  /** After a stop: give the run the grace period to end, then abandon it. */
  private armStopGrace(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.settled || run.graceTimer) return;
    run.graceTimer = setTimeout(() => { void this.abandonRun(run); }, this.stopGraceMs);
    (run.graceTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Settle a stopped run that did not end within the grace period. Its record
   * stays "stopped" — and resumable: a resume reopens the conversation from its
   * session file, since the in-memory session is still stuck in the tool.
   */
  private async abandonRun(run: LiveRun): Promise<void> {
    if (run.settled || run.abandoned) return;
    run.abandoned = true;
    const record = run.record;
    record.error ??= `The run did not end within ${Math.round(this.stopGraceMs / 1000)}s of the stop request `
      + "(a tool ignored it), so it was abandoned.";
    record.completedAt ??= Date.now();
    // Release waiters first: the cleanup below may run git.
    run.resolveAbandoned();
    try { await run.onAbandon(); } catch { /* best effort, like every settle path */ }
    this.endRun(run);
  }

  /**
   * Await a run inline, returning once it settles — or, after a stop, once it
   * has had INLINE_STOP_WAIT_MS to settle. What keeps Esc from stranding a
   * foreground call on a child whose tool ignores the abort.
   */
  private async waitInline(record: AgentRecord, promise: Promise<unknown>): Promise<void> {
    const signal = record.abortController?.signal;
    const settled = promise.then(() => {}, () => {});
    if (!signal) return settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<void>(resolve => {
      onAbort = () => { timer = setTimeout(resolve, INLINE_STOP_WAIT_MS); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([settled, stopped]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Whether the agent still has a run in flight: running or queued, or stopped
   * but not yet settled (still committing its worktree, or a tool ignoring the
   * stop). What callers that must not treat "stopped" as "over" check.
   */
  isRunActive(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    return isBusy(record) || this.runs.has(id);
  }

  /**
   * Which pool a spawn is charged to, or undefined for one that is charged to
   * neither (nested children, detached non-background spawns).
   *
   * Nothing here queues when the limit is unset — `poolHasRoom` reports an
   * unlimited pool as always having room, so that alone is what keeps the
   * default path identical. The `> 0` guard is belt and braces on top: it also
   * keeps the counter from churning and the settle path from calling a drain
   * that would find nothing to do. Both are unobservable, which is why no test
   * pins them; the observable half — that the default start stays synchronous —
   * is pinned in `test/foreground-concurrency.test.ts`.
   */
  private poolFor(record: AgentRecord): Pool | undefined {
    if (occupiesPoolSlot(record)) return "background";
    if (this.maxConcurrentForeground > 0 && occupiesForegroundSlot(record)) return "foreground";
    return undefined;
  }

  private poolHasRoom(pool: Pool): boolean {
    return pool === "background"
      ? this.runningBackground < this.maxConcurrent
      : this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * The id comes back synchronously, but with `isolation: "worktree"` the agent
   * is not running yet when it does — the repo copy is an awaited git call.
   * Callers that must fail a tool call on a startup failure await
   * `awaitStartup(id)`; everyone else sees it on the record (status "error").
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    if (options.reuseId !== undefined && this.agents.has(options.reuseId)) {
      throw new Error(`Agent ${options.reuseId} is already loaded.`);
    }
    const id = options.reuseId ?? randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      // Owned children — nested, or a workflow's — are filtered out of every
      // top-level surface, so no handle: nothing can address them and they must
      // not consume a name a top-level sibling could otherwise take.
      handle: !isTopLevelAgent(options)
        ? undefined
        // A reclaimed handle is used as-is: it belongs to the conversation this
        // spawn is reopening, and re-deriving it would lose the numbering.
        : options.reclaim?.handle ?? assignHandle(handleBase(type), this.takenHandles()),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias: isTopLevelAgent(options) ? options.reclaim?.alias : undefined,
      // Overwritten below when the spawn is actually queued; a foreground spawn
      // that queues flips to "queued" there rather than being guessed at here,
      // since the pool decision needs the finished record.
      status: options.isBackground ? "queued" : "running",
      toolUses: options.carry?.toolUses ?? 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: options.carry ? { ...options.carry.lifetimeUsage } : { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: options.carry?.compactionCount ?? 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      // Whether anyone is awaiting this agent is a property of the agent, not
      // of the call that made it — and both settle paths need it long after
      // `options` has stopped being the interesting object.
      blocking: options.blocking,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      workflowId: options.workflowId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
      isolated: options.isolated,
      // An owned child belongs where its root does: its ctx is its parent
      // agent's own session, not the user's.
      ownerSession: options.parentAgentId !== undefined
        ? this.agents.get(options.parentAgentId)?.ownerSession
        : sessionFileOf(ctx),
    };
    this.agents.set(id, record);
    // After the insert, so `takenHandles()` already counts this record's own
    // handle — a spawn named after its own type gets `explore-2`, not a
    // duplicate `explore` that would make resolution ambiguous.
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      record.alias = assignHandle(handleBase(options.name), this.takenHandles());
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options };
    this.pendingArgs.set(id, args);

    const pool = this.poolFor(record);
    if (pool !== undefined && !options.bypassQueue && !this.poolHasRoom(pool)) {
      // Queue it — started when a running agent in the same pool completes.
      // Idempotent for background (already "queued"); the flip that matters is
      // a blocking foreground spawn, optimistically marked "running" above.
      record.status = "queued";
      // A queued record never reaches startAgent's signal wiring, so arm the
      // parent abort here or Esc could not release the position.
      if (!this.armQueuedAbort(id, options.signal)) return id;
      let release!: () => void;
      record.startGate = new Promise<void>(resolve => { release = resolve; });
      this.queue.push({
        id,
        pool,
        start: () => this.launch(id, record, args, pool),
        release: () => release(),
      });
      options.onQueued?.(id, this.queue.filter(e => e.pool === pool).length - 1);
      return id;
    }

    this.launch(id, record, args, undefined);
    return id;
  }

  /**
   * Wire a parent abort signal for a record that is about to be QUEUED.
   * `startAgent` does this for running agents, and a queued record never gets
   * there, so without this Esc could not release a queue position.
   *
   * Returns false when the signal is ALREADY aborted, in which case the record
   * is stopped here and must not be enqueued: `addEventListener` never fires on
   * an aborted signal, so a `spawnAndWait` on it would wait forever — pi has no
   * tool-execution timeout to bail it out.
   *
   * The listener is removable (`record.detachParentAbort`): `startAgent`
   * replaces it with its own, and `sendToBackground` must be able to take it
   * off, or the caller that armed it could stop a run it no longer owns.
   */
  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    if (signal === undefined) return true;
    const record = this.agents.get(id);
    if (signal.aborted) {
      if (record) this.stopQueued(record);
      return false;
    }
    if (record) this.armParentAbort(record, signal);
    return true;
  }

  /**
   * Stop `record` when its caller's `signal` aborts, replacing any listener an
   * earlier stage armed — at most one is live per record, so one call to
   * `detachParentAbort` cuts the run loose from its caller.
   */
  private armParentAbort(record: AgentRecord, signal: AbortSignal | undefined): void {
    this.detachParentAbort(record);
    if (signal === undefined) return;
    const onParentAbort = () => this.abort(record.id);
    signal.addEventListener("abort", onParentAbort, { once: true });
    record.detachParentAbort = () => signal.removeEventListener("abort", onParentAbort);
  }

  private detachParentAbort(record: AgentRecord): void {
    record.detachParentAbort?.();
    record.detachParentAbort = undefined;
  }

  /**
   * Kick off an agent's startup and register it under `startups`. The returned
   * promise never rejects — the failure is delivered through `awaitStartup`,
   * and to the record.
   *
   * @param queuedPool - The pool this start was QUEUED on, or undefined for an
   *   immediate start. A queue drain can be minutes after `spawn()` returned,
   *   and nobody is awaiting `awaitStartup` by then, so a failure has to live
   *   on the record as status "error" — what drainQueue did when the throw was
   *   still synchronous. An immediate start instead drops the record, exactly
   *   as the throw out of `spawn()` did: no orphan in `listAgents()`, and the
   *   handle goes back.
   */
  private launch(id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined): Promise<void> {
    const startup = this.startAgent(id, record, args).then(
      () => { this.startups.delete(id); this.dropPendingArgs(id, args); },
      (err) => {
        this.startups.delete(id);
        this.dropPendingArgs(id, args);
        if (queuedPool !== undefined) {
          // Mirrors endRun: an inline caller gets this failure as a throw
          // out of spawnAndWait, so an unconsumed record would ALSO nudge the
          // session about it — the same failure reported twice.
          if (queuedPool === "foreground") record.resultConsumed = true;
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
          this.notifyComplete(record);
        } else {
          this.agents.delete(id);
        }
        // The agent never kept its slot (startAgent gives it back on failure),
        // so anything queued behind it can go now.
        this.drainQueue();
        throw err;
      },
    );
    this.startups.set(id, startup);
    // Nothing is obliged to await `startups` — swallow the rejection once here
    // so an unawaited startup can't take the process down, and hand callers
    // (drainQueue) that swallowed promise.
    return startup.catch(() => {});
  }

  private dropPendingArgs(id: string, args: SpawnArgs): void {
    if (this.pendingArgs.get(id) === args) this.pendingArgs.delete(id);
  }

  /**
   * Resolves once the agent is actually running, and rejects with the startup
   * failure (strict worktree isolation) that `spawn()` used to throw before the
   * repo copy became async. Resolves immediately for an agent that is already
   * running, still queued, or unknown — so callers can await it unconditionally.
   *
   * Call it in the same tick as the `spawn()` it belongs to: a failed startup
   * takes its record (and this entry) with it, exactly as the throw did.
   */
  awaitStartup(id: string): Promise<void> {
    return this.startups.get(id) ?? Promise.resolve();
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private async startAgent(
    id: string,
    record: AgentRecord,
    args: SpawnArgs,
  ) {
    // `args.ctx` is read again where the run starts, not destructured here: a
    // session switch during the worktree copy swaps it for a frozen copy.
    const { pi, type, prompt, options } = args;
    const ctx = args.ctx;
    // The functions this run starts and settles with, fixed for its lifetime.
    const svc = this.svc();
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const sessionCwd = ctx.cwd;
    const baseCwd = customCwd ?? sessionCwd;

    // Take the running state — and with it the concurrency slot — BEFORE the
    // first await. Creating a worktree is an awaited git call, and drainQueue
    // reads the pool counters synchronously in a loop: incrementing after the
    // await would let it start every queued agent at once while the first is
    // still copying its repo. Claiming "running" here also keeps abort() and
    // abortAll() able to reach an agent whose worktree is still being created.
    //
    // The pool is resolved ONCE, here, and carried on the run to `endRun`:
    // `poolFor` reads `maxConcurrentForeground`, which the user can change from
    // `/agents → Settings` mid-run, so recomputing it at settle time would
    // decrement a pool this run never charged (counter underflow, limit
    // silently lifted) or skip the decrement for one it did (leaked slot —
    // every later blocking spawn queues forever). The release is idempotent
    // (`releaseRunSlot`), so a run that is abandoned and then ends after all,
    // or a stop during startup, can never free the slot twice. Foreground runs
    // set `resultConsumed` before settling, so onComplete skips notifications
    // the inline result already delivered.
    const pool = this.poolFor(record);
    record.status = "running";
    record.startedAt = Date.now();
    record.startGate = undefined;
    record.cwd = customCwd;
    record.baseCwd = baseCwd;
    this.pi = pi;
    const run = this.beginRun(id, record, pool);
    // A stop that lands while the worktree is still being made ends the run
    // there: discard the fresh copy, then settle as stopped, completion and all.
    const stopDuringStartup = async (wt: { path: string; branch: string; baseSha: string; workPath: string }) => {
      if (record.status === "running") {
        record.status = "stopped";
        record.completedAt = Date.now();
      }
      // Free the slot before the git cleanup, so the queue need not wait on it.
      this.releaseRunSlot(run);
      this.drainQueue();
      try {
        record.worktreeResult = await svc.cleanupWorktree(pi, baseCwd, wt, options.description);
      } catch { /* best effort */ }
      this.endRun(run);
    };

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done BEFORE
    // the run is kicked off so a failure doesn't leave a half-running agent.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    // The agent file's `isolation:` is resolved here too, not by each caller:
    // mentions pass none, and RPC forwards only its caller's value. Workflow
    // children are the exception, as in Claude Code, whose workflow agent()
    // reads only the script's option and ignores the definition's. So is an
    // agent reopened from its session file: it continues where it ran, and a
    // worktree it ran in comes back through `restoreWorktree` below.
    const isolation = options.workflowId !== undefined || options.resumeSessionFile !== undefined
      ? options.isolation
      : svc.getAgentConfig(type)?.isolation ?? options.isolation;
    let worktreeCwd: string | undefined;
    // What an earlier run of a reopened agent left on its branch. A resumed
    // run that changes nothing keeps reporting that, not "no changes".
    const priorWorktreeResult = options.restoreWorktree?.prior;
    if (options.restoreWorktree) {
      if (!svc.isWorktreeIsolationEnabled()) {
        this.discardRun(run);
        throw new Error(`Cannot resume agent ${id}: it ran in a git worktree, and worktree isolation is turned off in this project.`);
      }
      const wt = { ...options.restoreWorktree.worktree };
      const error = await svc.restoreWorktree(pi, baseCwd, wt, priorWorktreeResult);
      if (error) {
        this.discardRun(run);
        throw new Error(`Cannot resume agent ${id} in its git worktree: ${error}. Nothing was run.`);
      }
      record.worktree = wt;
      record.worktreeResult = priorWorktreeResult;
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
      if (record.status !== "running" || options.signal?.aborted) {
        await stopDuringStartup(wt);
        return;
      }
    } else if (isolation === "worktree" && svc.isWorktreeIsolationEnabled()) {
      const wt = await svc.createWorktree(pi, baseCwd, id);
      if (!wt) {
        this.discardRun(run);
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
      // The widget's "worktree" tag reads this; only callers that resolve the
      // agent file themselves seed it.
      record.invocation ??= {};
      record.invocation.isolation = "worktree";

      // No longer "running" means a stop landed while the copy was being made
      // (abort(), abortAll()) — a window that did not exist when creation was
      // synchronous. The record is already terminal, so launching the run would
      // burn tokens on work nobody is waiting for: discard the fresh (and by
      // definition unchanged) worktree instead. A parent signal that fired
      // meanwhile is the same stop, arriving by the other route.
      if (record.status !== "running" || options.signal?.aborted) {
        await stopDuringStartup(wt);
        return;
      }
    }

    try { this.onStart?.(record); } catch { /* a start observer must not fail the run */ }

    // Where this run's turns begin in its session: past the history of a
    // reopened conversation. Set once the session exists.
    let runStart = 0;

    // Wire parent abort signal to stop the subagent when the parent is interrupted.
    // A queued spawn can start minutes after the caller handed us its signal,
    // by which time it may already be aborted — and `addEventListener` would
    // never fire, leaving a child the parent can no longer reach.
    if (options.signal?.aborted) this.abort(id);
    else this.armParentAbort(record, options.signal);
    const detach = () => this.detachParentAbort(record);

    const promise = svc.runAgent(args.ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      structuredOutput: options.structuredOutput,
      resumeSessionFile: options.resumeSessionFile,
      nested: options.parentAgentId !== undefined,
      workflow: options.workflowId !== undefined,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Set iff a worktree was created (see above) — names the directory the
      // copy came from, so the prompt can tell the agent not to work there.
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: options.configCwd ?? (customCwd !== undefined ? sessionCwd : undefined),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        // Abandoned before its session even existed (a hung extension
        // startup): nobody will use this session, so release it now.
        if (run.abandoned) {
          void shutdownChildSession(session);
          return;
        }
        record.session = session;
        runStart = messageCount(session);
        // Capture now, while the session object exists: after eviction this
        // path is the only thing that can reopen the conversation, and an
        // in-memory session reports undefined, which correctly means
        // "nothing to come back to".
        // Optional chaining, not defensiveness for its own sake: this is the
        // only field read off the session at creation, so an older pi or a
        // stubbed session must degrade to "not resumable" rather than throw
        // and take the whole spawn down with it.
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        recordRunModel(record, session);
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        // A caller's wiring must not fail the run (it may read a ctx a session
        // switch has since invalidated).
        try { options.onSessionCreated?.(session); } catch { /* ignore caller wiring errors */ }
      },
    })
      .then(async ({ responseText, session, aborted, steered, failure, structuredJson, structuredRetried, maxTurns }) => {
        // Abandoned after a stop it ignored: the record was settled without
        // this run, and may already belong to a newer one.
        if (run.abandoned) return responseText;
        record.maxTurns = maxTurns;
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        // Kept beside `result`, never inside it: `result` is prose meant for a
        // reader — it is previewed, transcribed, and appended to below — while
        // this is a machine-readable payload one caller asked for by schema.
        record.structuredJson = structuredJson;
        record.structuredRetried = structuredRetried;
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          // The hook runs inside cleanup: after the child's changes are
          // committed and while its tree still exists; what it changes is
          // discarded, so a gate's output never lands on the branch.
          const wtResult = await svc.cleanupWorktree(pi, baseCwd, record.worktree, options.description, options.onBeforeWorktreeCleanup);
          record.worktreeResult = wtResult.hasChanges || !priorWorktreeResult ? wtResult : priorWorktreeResult;
          // Appended to the prose only. A structured child's caller parses
          // `structuredJson`, which stays untouched — but `result` is also
          // what a human reads, so the note still belongs on it.
          const note = worktreeNote(record.worktreeResult, baseCwd, customCwd !== undefined);
          if (note) record.result = (record.result ?? "") + note;
        }

        this.abortOwnedChildren(id);

        if (record.isBackground === false) record.resultConsumed = true;
        this.endRun(run);
        return responseText;
      })
      .catch(async (err) => {
        if (run.abandoned) return "";
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
        // A run that threw reported no text; keep what its turns produced.
        salvagePartial(record, runStart);

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = await svc.cleanupWorktree(pi, baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult.hasChanges || !priorWorktreeResult ? wtResult : priorWorktreeResult;
            // A failed run can still have changed files: say where they went,
            // on the error every failure surface shows.
            const note = worktreeNote(record.worktreeResult, baseCwd, customCwd !== undefined);
            if (note) record.error = (record.error ?? "") + note;
          } catch { /* ignore cleanup errors */ }
        }

        this.abortOwnedChildren(id);

        if (record.isBackground === false) record.resultConsumed = true;
        this.endRun(run);
        return "";
      });

    // What an abandoned run still owes: what the settle paths above would have
    // done, minus the result it never produced.
    run.onAbandon = async () => {
      detach();
      salvagePartial(record, runStart);
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      if (record.worktree) {
        try {
          const wtResult = await svc.cleanupWorktree(pi, baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult.hasChanges || !priorWorktreeResult ? wtResult : priorWorktreeResult;
          const note = worktreeNote(record.worktreeResult, baseCwd, customCwd !== undefined);
          if (note) record.result = (record.result ?? "") + note;
        } catch { /* ignore cleanup errors */ }
      }
      this.abortOwnedChildren(id);
      if (record.isBackground === false) record.resultConsumed = true;
    };

    // Every waiter (spawnAndWait, waitForAll, result tools, resume) joins the
    // run — or its abandonment, whichever comes first.
    record.promise = Promise.race([promise, run.whenAbandoned.then(() => record.result ?? "")]);

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming
    // starts. Read off the options, so a spawn that started from a queue drain
    // still reaches the caller that queued it.
    options.onSpawned?.(id);
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  /**
   * Start queued agents up to each pool's concurrency limit.
   *
   * `findIndex` on the entry's OWN pool rather than `shift`: with one queue
   * serving two independent limits, a saturated foreground pool at the head
   * would otherwise stall every background agent behind it. Taking the earliest
   * eligible entry keeps FIFO within each pool, which is what callers see.
   */
  private drainQueue() {
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = this.agents.get(next.id);
      // Stale entries (aborted while queued) are not started — but are still
      // released, since nothing else will.
      if (!record || record.status !== "queued") { next.release(); continue; }
      // Detached, and never rejects: a late failure (e.g. strict worktree
      // isolation) lands on the record inside `launch`, exactly as the
      // synchronous throw did here before, and draining continues either way.
      //
      // The release waits for that startup to SETTLE rather than firing here.
      // Startup is async now, so a release at drain time would wake a blocked
      // `spawnAndWait` while `record.promise` was still undefined, and it would
      // read a perfectly healthy agent as one that never ran.
      void next.start().then(() => next.release(), () => next.release());
    }
  }

  /**
   * Remove queued entries and wake anyone blocked on them. The single point
   * that enforces "leaving the queue releases the waiter" — a missed release is
   * an unbounded hang, not a failed call.
   */
  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Charged to the foreground pool (`maxConcurrentForeground`), which is
   * unlimited by default; never to the background one.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously once the run is kicked off, before
   *   onSessionCreated fires. Use this to set record.outputFile so
   *   streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // `blocking` is what maxConcurrentForeground bounds, and this is its only
    // source. onSpawned rides on the options rather than on a field of this
    // manager: a queued spawn starts at drain time, long after any install/
    // restore pair around this call would have put the field back — and it now
    // fires after an await (worktree creation) even on the immediate path.
    const id = this.spawn(pi, ctx, type, prompt, {
      ...options,
      isBackground: false,
      blocking: true,
      onSpawned,
    });
    const record = this.agents.get(id)!;

    // Queued: nothing to await yet — the promise appears when the drain starts
    // it. The gate resolves (never rejects) on every path out of the queue,
    // start and abort alike, so a rejection can never escape into the caller's
    // tool `execute` and take down pi's whole Promise.all tool batch.
    if (record.status === "queued") await record.startGate;

    // The run promise only exists once startup is past its awaited repo copy —
    // without this the call would return before the agent had started at all.
    // A startup failure (strict worktree isolation) rejects here, which is what
    // the immediate path owes its caller: pi only marks a tool result failed
    // when `execute` throws. A queued spawn's failure landed on the record
    // instead (nobody was awaiting `startups` at drain time) and is rethrown
    // below, so the contract is the same either way.
    await this.awaitStartup(id);

    // undefined when it was aborted while queued, or stopped mid-copy, and so
    // never ran — the record is already terminal with a completedAt, which is
    // what the caller renders. After a stop, returns within INLINE_STOP_WAIT_MS
    // even if the run is still winding down (or never will).
    if (record.promise) await this.waitInline(record, record.promise);

    // A record that ended "error" without ever getting a promise never ran: the
    // same startup failure spawn() rethrows on the immediate path (#179). Keep
    // one contract rather than letting queue pressure decide whether a strict
    // worktree failure throws or returns as a result.
    if (record.promise === undefined && record.status === "error") {
      throw new Error(record.error ?? "Agent failed to start");
    }
    return { id, record };
  }

  /**
   * Hand a live run to the background without restarting it. The session,
   * promise, in-flight turn, transcript and worktree all continue under the
   * same id; what changes is who answers for it. The caller's parent-abort
   * listener comes off (its Esc no longer reaches the run — `abort()` and
   * `/agents` still do), the slot moves to the background pool, and the run
   * then settles through the ordinary background path: `endRun` releases the
   * run's live pool, and the settle reads the live `isBackground`, so the
   * result is delivered as a background completion.
   *
   * Releasing the caller is the caller's job — the `Agent` tool races its own
   * wake-up against `spawnAndWait`. This only refuses what it can see: a run
   * nobody is blocking on (a background or detached spawn, one already handed
   * off, or a foreground resume — `blocking` is cleared when the spawned run
   * settles), one that reports through something other than the session (a
   * nested child, a workflow's agent), and one that is stopped or queued.
   *
   * The background slot is taken even when the pool is full: suspending a
   * live run is not an option, so it runs over the limit and queued
   * background work waits for the count to drop, as with `bypassQueue`.
   */
  sendToBackground(id: string): boolean {
    const record = this.agents.get(id);
    const run = this.runs.get(id);
    if (!record?.blocking || !isTopLevelAgent(record) || record.status !== "running" || !record.promise) return false;
    if (!run || run.settled || run.record !== record) return false;

    this.detachParentAbort(record);
    if (!run.slotReleased) {
      if (run.pool === "foreground") this.runningForeground--;
      else if (run.pool === "background") this.runningBackground--;
      this.runningBackground++;
    }
    run.pool = "background";
    record.blocking = false;
    record.isBackground = true;
    record.resultConsumed = false;
    // A freed foreground slot may have unblocked a queued blocking spawn.
    this.drainQueue();
    return true;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    // Evicted: reopen its conversation from the session file, as `@handle`
    // does, so the model can resume an agent for as long as that file exists
    // — not only in the ten minutes its record stays in memory.
    if (!record) {
      const entry = this.tombstones.get(id);
      return entry ? this.reopen(entry, prompt, signal, options) : undefined;
    }
    if (!record.session) return undefined;
    if (isBusy(record)) return undefined;

    // `abort()` marks a record "stopped" at once, while its run is still
    // winding down: pi may still be streaming, and the settle path may still
    // be committing the worktree. Resuming before that settles fails with
    // "Agent is already processing", or lets the old settle path overwrite the
    // new run's status, append its worktree note to the new result and remove
    // the worktree under it. Wait for it, then check again: another resume may
    // have claimed the record meanwhile.
    await this.waitForSettle(record);
    if (isBusy(record)) return undefined;

    // Its last run settled, but the session is still inside it: a tool that
    // ignored the stop (the run was abandoned) or the watchdog. Prompting it
    // would fail with "Agent is already processing", so reopen the
    // conversation from its session file instead, as for an evicted agent.
    // Removing the record disposes the stuck session first, which also stops
    // it from writing to the file the reopened run continues.
    // The same when its finished session was released to free its resources.
    if (this.needsReopen(record)) {
      const state = resumeStateOf(record);
      if (!state) {
        throw new Error(
          `Cannot resume agent ${id}: its last run is stuck in a tool call that ignored the stop request, `
          + "and it has no saved session to reopen.",
        );
      }
      this.removeRecord(id, record);
      // The agent's lifetime figures continue on the reopened record.
      return this.reopen(state, prompt, signal, options, {
        lifetimeUsage: { ...record.lifetimeUsage },
        toolUses: record.toolUses,
        compactionCount: record.compactionCount,
      });
    }
    this.cancelRelease(record);

    // Claimed before the awaited preparation, so a concurrent resume is refused
    // rather than preparing (and running) the same agent twice. A failed
    // preparation hands the record back as it was: the agent did not fail,
    // the resume never started.
    const before = { status: record.status, completedAt: record.completedAt };
    record.status = "queued";
    const preparation = this.prepareResume(record, options);
    // Visible to waitForAll and to a concurrent resume's waitForSettle, which
    // would otherwise see a "queued" record with nothing to wait on.
    record.promise = preparation.then(() => record.result ?? "", () => record.result ?? "");
    try {
      await preparation;
    } catch (err) {
      if (record.status === "queued") {
        record.status = before.status;
        record.completedAt = before.completedAt;
      }
      throw err;
    }
    // Stopped while it was being prepared.
    if (record.status !== "queued") return record;
    options?.onRecord?.(record);

    // Background resume: settle asynchronously and notify on completion exactly
    // like a background spawn, returning immediately with the record still
    // "running" — or "queued" when at the concurrency limit. Previously
    // run_in_background was ignored on resume (the Agent tool's resume branch
    // returned before its background branch, and resume() only ever awaited
    // inline), so a resumed agent always blocked the caller until it finished.
    if (options?.isBackground) {
      // A run still in flight was refused above. Detaching means the caller
      // gets control back while the record stays "running", so nothing stops the
      // model from resuming the same agent again. Starting a second run would
      // overwrite record.abortController — orphaning the live run beyond the
      // reach of `/agents` stop and abortAll() — double-count the pool slot, and
      // then reject from session.prompt() with "Agent is already processing",
      // whose settle path would abort the LIVE run's children and report a
      // failure for a run that is still going.
      record.isBackground = true;
      record.resultConsumed = false;
      record.result = undefined;
      record.error = undefined;
      record.completedAt = undefined;
      record.status = "queued";

      const start = () => this.startResume(id, record, prompt, signal, options);
      if (occupiesPoolSlot(record) && !this.poolHasRoom("background")) {
        // At the concurrency limit — queue it, drains when a slot frees. A
        // detached resume has no inline caller, hence nothing to release. The
        // queue is shared with spawns, whose startup is async, so entries are
        // promise-shaped even though a resume starts synchronously; failures
        // land on the record here, since drainQueue no longer catches.
        this.queue.push({
          id,
          pool: "background",
          start: async () => {
            try {
              start();
            } catch (err) {
              record.status = "error";
              record.error = err instanceof Error ? err.message : String(err);
              record.completedAt = Date.now();
              this.notifyComplete(record);
            }
          },
          release: () => {},
        });
      } else {
        start();
      }
      return record;
    }

    // Foreground resume returns its result inline, but still participates in
    // lifecycle observers (widget, fleet list) like every other run.
    record.isBackground = false;
    record.resultConsumed = true;
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    const session = record.session;
    recordRunModel(record, session);
    const runStart = messageCount(session);
    const abortController = new AbortController();
    record.abortController = abortController;
    const onParentAbort = () => this.abort(id);
    const run = this.beginRun(id, record, undefined);
    // Keep the promise on the record as well as awaiting it inline: result
    // tools and waitForAll must join this run, not the already settled spawn.
    const promise = (async () => {
      try {
        try { this.onStart?.(record); } catch { /* a start observer must not fail the run */ }
        if (signal?.aborted) this.abort(id);
        else signal?.addEventListener("abort", onParentAbort, { once: true });
        const { text, failure, aborted, steered } = abortController.signal.aborted ? { text: "" } : await this.svc().resumeAgent(session, prompt, {
          maxTurns: options?.maxTurns ?? record.maxTurns,
          onTurnEnd: options?.onTurnEnd,
          onToolActivity: (activity) => {
            if (activity.type === "end") record.toolUses++;
            options?.onToolActivity?.(activity);
          },
          onAssistantUsage: (usage) => {
            addUsage(record.lifetimeUsage, usage);
            this.onUsage?.(record, usage);
            options?.onAssistantUsage?.(usage);
          },
          onCompaction: (info) => {
            record.compactionCount++;
            this.onCompact?.(record, info);
            options?.onCompaction?.(info);
          },
          signal: abortController.signal,
        });
        if (run.abandoned) return record.result ?? "";
        settleResumeStatus(record, { failure, aborted, steered });
        record.result = text;
        record.completedAt ??= Date.now();
      } catch (err) {
        if (run.abandoned) return record.result ?? "";
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt ??= Date.now();
        salvagePartial(record, runStart);
      }
      signal?.removeEventListener("abort", onParentAbort);
      this.abortOwnedChildren(id);
      await this.finishResumedWorktree(record);
      // Completion observers never replace the inline result: endRun guards them.
      this.endRun(run);
      return record.result ?? "";
    })();
    run.onAbandon = async () => {
      salvagePartial(record, runStart);
      signal?.removeEventListener("abort", onParentAbort);
      this.abortOwnedChildren(id);
      await this.finishResumedWorktree(record);
    };
    record.promise = Promise.race([promise, run.whenAbandoned.then(() => record.result ?? "")]);
    await this.waitInline(record, record.promise);
    return record;
  }

  /**
   * Resume an evicted agent: an ordinary spawn under the same id, reopening
   * its session file, with what it ran with — its model, working directory,
   * worktree (restored from its branch), extension isolation and turn limit —
   * rather than the parent's current settings. The spawn path then gives the
   * run everything a first run gets: turn limits, worktree cleanup, the
   * transcript, the completion notification.
   *
   * The tombstone stays: a live record holding the same id and names takes
   * precedence everywhere, and if this run dies before its session exists the
   * original transcript is still the one to reopen. Its eviction overwrites
   * the entry in place.
   */
  private async reopen(
    entry: AgentResumeState,
    prompt: string,
    signal: AbortSignal | undefined,
    options: ResumeOptions | undefined,
    carry?: Pick<AgentRecord, "lifetimeUsage" | "toolUses" | "compactionCount">,
  ): Promise<AgentRecord> {
    const pi = options?.pi ?? this.pi;
    const ctx = options?.ctx;
    if (!pi || !ctx) {
      throw new Error(`Agent ${entry.id} has finished and is no longer in memory, and it cannot be reopened from here.`);
    }
    const problem = this.svc().sessionFileProblem(entry.sessionFile);
    if (problem) {
      // Gone for good: a row that can only ever fail is worse than none.
      if (!existsSync(entry.sessionFile)) this.tombstones.delete(entry.id);
      throw new Error(`Cannot resume agent ${entry.id}: ${problem}.`);
    }
    const typeProblem = options?.checkType?.(entry.type);
    if (typeProblem) throw new Error(`Cannot resume agent ${entry.id}: ${typeProblem}`);

    // The model the session ran on, when this session can still reach it;
    // otherwise the type's/parent's, as for a fresh spawn.
    const slash = entry.model?.indexOf("/") ?? -1;
    const model = entry.model && slash > 0
      ? ctx.modelRegistry.find(entry.model.slice(0, slash), entry.model.slice(slash + 1))
      : undefined;
    // A parent session in another directory (`/resume` of an older session)
    // must not move the agent: keep the directory it ran in.
    const cwd = entry.cwd ?? (entry.baseCwd !== undefined && entry.baseCwd !== ctx.cwd ? entry.baseCwd : undefined);

    const spawnOptions: SpawnOptions = {
      description: entry.description,
      reuseId: entry.id,
      carry,
      reclaim: entry.handle !== undefined ? { handle: entry.handle, alias: entry.alias } : undefined,
      resumeSessionFile: entry.sessionFile,
      model,
      maxTurns: options?.maxTurns ?? entry.maxTurns,
      isolated: entry.isolated,
      cwd,
      restoreWorktree: entry.worktree ? { worktree: entry.worktree, prior: entry.worktreeResult } : undefined,
      parentAgentId: entry.parentAgentId,
      workflowId: entry.workflowId,
      depth: entry.depth,
      maxSubagentDepth: entry.maxSubagentDepth,
      rootSessionId: entry.rootSessionId,
      invocation: {
        ...(entry.thinking ? { thinking: entry.thinking } : {}),
        ...(entry.isolated ? { isolated: true } : {}),
        ...(entry.worktree ? { isolation: "worktree" as const } : {}),
      },
      onToolActivity: options?.onToolActivity,
      onAssistantUsage: options?.onAssistantUsage,
      onTurnEnd: options?.onTurnEnd,
      onCompaction: options?.onCompaction,
      // The session exists and the prompt is not sent yet — the same moment a
      // live resume calls it.
      onSessionCreated: () => { try { options?.onStarted?.(); } catch { /* ignore caller wiring errors */ } },
      onSpawned: (spawnedId) => {
        const rec = this.agents.get(spawnedId);
        if (rec) options?.onRecord?.(rec);
      },
    };
    if (options?.isBackground) {
      const newId = this.spawn(pi, ctx, entry.type, prompt, { ...spawnOptions, isBackground: true, signal });
      // A startup failure (the worktree cannot be restored, the directory is
      // gone) rejects here and drops the record; the tombstone stays.
      await this.awaitStartup(newId);
      const rec = this.agents.get(newId);
      if (!rec) throw new Error(`Agent ${entry.id} could not be reopened.`);
      return rec;
    }
    const { record } = await this.spawnAndWait(pi, ctx, entry.type, prompt, { ...spawnOptions, signal });
    return record;
  }

  /**
   * Everything a resume needs before its prompt is sent. Throws, with the
   * reason, when the agent cannot be resumed; nothing has run by then.
   *
   * A worktree agent's worktree was committed to its branch and removed when
   * its run settled, but its session's tools still point there — and Pi's
   * write tool creates missing directories, so a resume would write into an
   * orphaned temp directory outside the repo. Put the worktree back first.
   */
  private async prepareResume(record: AgentRecord, options: ResumeOptions | undefined): Promise<void> {
    const worktree = record.worktree;
    if (worktree?.path && !existsSync(worktree.path)) {
      if (!this.svc().isWorktreeIsolationEnabled()) {
        throw new Error(
          `Cannot resume agent ${record.id}: it ran in a git worktree, and worktree isolation is turned off in this project.`,
        );
      }
      const pi = options?.pi ?? this.pi;
      const repo = record.baseCwd;
      const error = pi && repo
        ? await this.svc().restoreWorktree(pi, repo, worktree, record.worktreeResult)
        : "the repository it ran in is unknown";
      if (error) {
        throw new Error(`Cannot resume agent ${record.id} in its git worktree: ${error}. Nothing was run.`);
      }
      if (repo) this.worktreeRepos.add(repo);
    }
  }

  /**
   * After a resumed run of a worktree agent: commit what it changed, remove the
   * worktree again, and tell the caller where the work is — exactly as a first
   * run's settle path does. A run that changed nothing keeps the earlier
   * result, so the note still names the branch the first run's work is on.
   */
  private async finishResumedWorktree(record: AgentRecord): Promise<void> {
    const pi = this.pi;
    const repo = record.baseCwd;
    if (!record.worktree?.path || !pi || !repo || !existsSync(record.worktree.path)) return;
    const prior = record.worktreeResult;
    try {
      const wtResult = await this.svc().cleanupWorktree(pi, repo, record.worktree, record.description);
      record.worktreeResult = wtResult.hasChanges || !prior ? wtResult : prior;
      const note = worktreeNote(record.worktreeResult, repo, record.cwd !== undefined);
      if (!note) return;
      if (record.status === "error") record.error = (record.error ?? "") + note;
      else record.result = (record.result ?? "") + note;
    } catch { /* ignore cleanup errors, like the spawn path */ }
  }

  /** Resolve once the record's previous run, including its startup, has fully settled. */
  private async waitForSettle(record: AgentRecord): Promise<void> {
    await this.startups.get(record.id)?.catch(() => {});
    await record.promise?.catch(() => {});
  }

  /**
   * Start a background resume run: detached, settling and notifying like
   * startAgent's background path. Invoked immediately, or from drainQueue when
   * a concurrency slot frees. The session already exists (resume reuses it), so
   * there is no onSessionCreated to hang per-run wiring off — callers use
   * `options.onStarted`, which fires on both the immediate and the drained path.
   */
  private startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    options: ResumeOptions,
  ) {
    if (!record.session) return;

    record.status = "running";
    record.startedAt = Date.now();
    const runStart = messageCount(record.session);
    recordRunModel(record, record.session);
    const run = this.beginRun(id, record, occupiesPoolSlot(record) ? "background" : undefined);
    try { this.onStart?.(record); } catch { /* a start observer must not fail the run */ }

    // Fresh abort controller so /agents stop and steering target THIS run rather
    // than the previous one's settled controller.
    const abortController = new AbortController();
    record.abortController = abortController;
    // Optional, and NOT what the Agent tool passes for a detached resume: a
    // parent signal aborts on the parent's own interrupt (user Esc), which is
    // right for a foreground run whose result the caller is awaiting, and wrong
    // for a detached one — background spawns omit it for exactly this reason.
    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      const onParentAbort = () => this.abort(id);
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
    }

    // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
    // After the record is in its running shape, before the run is kicked off.
    try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }

    // Everything but the completion — shared by the normal settle and an
    // abandonment, which settles without the run's result.
    const windDown = async () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
      // What a run that threw or was abandoned had produced; a settled run's
      // own text is already on the record.
      if (record.status === "error" || record.status === "stopped") salvagePartial(record, runStart);
      // Final flush of streaming output file
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      // Children spawned during the resumed turn must not outlive it.
      this.abortOwnedChildren(id);
      await this.finishResumedWorktree(record);
    };
    run.onAbandon = windDown;
    const settle = async () => {
      await windDown();
      this.endRun(run);
    };

    const promise = this.svc().resumeAgent(record.session, prompt, {
      maxTurns: options.maxTurns ?? record.maxTurns,
      onTurnEnd: options.onTurnEnd,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      signal: abortController.signal,
    })
      .then(async ({ text, failure, aborted, steered }) => {
        if (run.abandoned) return text;
        settleResumeStatus(record, { failure, aborted, steered });
        record.result = text;
        record.completedAt ??= Date.now();
        await settle();
        return text;
      })
      .catch(async (err) => {
        if (run.abandoned) return "";
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt ??= Date.now();
        await settle();
        return "";
      });

    record.promise = Promise.race([promise, run.whenAbandoned.then(() => record.result ?? "")]);
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  private takenHandles(): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record.alias) taken.add(record.alias);
    }
    // Tombstones hold their names too: an evicted `@explore` is still
    // resurrectable, so a later Explore must become `explore-2` rather than
    // shadowing a conversation the user can still reach.
    for (const entry of this.tombstones.values()) {
      if (entry.handle) taken.add(entry.handle);
      if (entry.alias) taken.add(entry.alias);
    }
    return taken;
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (record.parentAgentId !== undefined || !this.isVisible(record)) continue;
      // Handle and alias share one namespace, so at most one agent answers a
      // name and it makes no difference which of the two matched.
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
      if (record.status === "running" || record.status === "queued") return { kind: "live", record };
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId?.parentAgentId === undefined && byId !== undefined && this.isVisible(byId)) return { kind: "live", record: byId };
    // Only once nothing live answers: a tombstone is a conversation to reopen,
    // and reopening one while its record still exists would fork the session.
    for (const entry of this.tombstones.values()) {
      if (!isTopLevelTombstone(entry)) continue;
      if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
        return { kind: "tombstone", entry };
      }
    }
    return undefined;
  }

  /** The resume state of an evicted agent, by id. */
  findTombstone(id: string): AgentResumeState | undefined {
    return this.tombstones.get(id);
  }

  /**
   * Forget an evicted agent, by handle. For the case where its session file has
   * gone: the entry can then only ever fail, while still holding the name
   * against the type that would otherwise start a fresh agent under it.
   *
   * A *successful* resume does not drop its tombstone — the live record it
   * creates already wins in `resolveMention`, and overwrites the entry in place
   * when it is itself evicted.
   */
  dropTombstone(idOrHandle: string): void {
    if (this.tombstones.delete(idOrHandle)) return;
    for (const [id, entry] of this.tombstones) {
      if (entry.handle === idOrHandle) this.tombstones.delete(id);
    }
  }

  /** Evicted top-level agents whose conversation can still be reopened, newest first. */
  listTombstones(): AgentTombstone[] {
    return [...this.tombstones.values()].filter(isTopLevelTombstone).sort((a, b) => b.completedAt - a.completedAt);
  }

  /** The agents of the session the surfaces show (see {@link setVisibleOwner}), newest first. */
  listAgents(): AgentRecord[] {
    return this.listAllAgents().filter(record => this.isVisible(record));
  }

  /** Every agent this manager holds, whichever session it belongs to, newest first. */
  listAllAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued. No decrement — the slot was never taken.
    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      this.stopQueued(record);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    // "stopped" is what the user sees at once; the run itself settles when it
    // has wound down — or is abandoned if a tool ignores the abort.
    this.armStopGrace(id);
    return true;
  }

  /**
   * Settle a record that never left the queue as stopped. It still reaches
   * onComplete, like every other stop: the `subagents:failed` event, the
   * session's `subagents:record` entry and the UI's activity cleanup all hang
   * off it. A blocking caller learns of the stop from its own tool result.
   */
  private stopQueued(record: AgentRecord): void {
    this.pendingArgs.delete(record.id);
    record.status = "stopped";
    record.completedAt = Date.now();
    if (record.isBackground === false) record.resultConsumed = true;
    this.notifyComplete(record);
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.tombstone(record);
    this.cancelRelease(record);
    // Already shut down and disposed: once is all a session's extensions get.
    const session = this.released.has(record) ? undefined : record.session;
    // Detached before the shutdown starts, so the record leaves the map at once and
    // nothing can observe a session that is half torn down.
    record.session = undefined;
    this.agents.delete(id);
    // A failed startup keeps its (rejected) entry so a late awaitStartup still
    // sees it; drop it with the record so the map can't grow unbounded.
    this.startups.delete(id);
    // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
    // and from `clearCompleted()` on session boundaries, with the process staying alive,
    // so handlers get their full window. The quit path awaits instead — see dispose().
    void shutdownChildSession(session);
  }

  /**
   * Preserve enough of a departing record to reopen its conversation later.
   * Nothing to keep without a session file — an in-memory session leaves no
   * transcript, so a resume would have nothing to continue from.
   */
  private tombstone(record: AgentRecord): void {
    const state = resumeStateOf(record);
    if (state) this.keepTombstone(state);
  }

  private keepTombstone(state: AgentResumeState): void {
    this.tombstones.set(state.id, state);
    this.trimTombstones();
  }

  /**
   * Bound the memory a long session can accumulate, per kind (top-level or
   * owned). Oldest first, since the agent someone still wants to reach is the
   * one they used most recently. One counting pass; the sort runs only for a
   * kind that is over its cap.
   */
  private trimTombstones(): void {
    let topLevel = 0;
    for (const entry of this.tombstones.values()) if (isTopLevelAgent(entry)) topLevel++;
    const owned = this.tombstones.size - topLevel;
    for (const [kindIsTopLevel, excessCount] of [[true, topLevel - MAX_TOMBSTONES], [false, owned - MAX_OWNED_TOMBSTONES]] as const) {
      if (excessCount <= 0) continue;
      const sameKind = [...this.tombstones.values()].filter(entry => isTopLevelAgent(entry) === kindIsTopLevel);
      sameKind.sort((a, b) => a.completedAt - b.completedAt);
      for (const entry of sameKind.slice(0, excessCount)) this.tombstones.delete(entry.id);
    }
  }

  /**
   * Make agents of an earlier activation (before a restart, `/resume`,
   * `/fork` or `/reload`) resumable again, from what was persisted in the
   * parent session. Later entries for the same id win. A live record keeps
   * precedence: it is the newer state of the same agent. Trimmed once at the
   * end rather than per entry, so a session with thousands of entries restores
   * in one pass.
   */
  restoreTombstones(states: readonly AgentResumeState[]): void {
    for (const state of states) {
      if (this.agents.has(state.id)) continue;
      // In entry order, so a later entry for the same id (a later run) wins.
      const current = this.tombstones.get(state.id);
      if (current && current.completedAt > state.completedAt) continue;
      this.tombstones.set(state.id, state);
    }
    this.trimTombstones();
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      // A stopped record whose run has not settled still owns its session.
      if (this.isRunActive(id)) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (this.isRunActive(id)) continue;
      // Kept too: another session's agent that finished while that session was
      // closed, until it is opened again and told (or the cleanup evicts it).
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // Unconditional: both callers are session boundaries (`session_start` and
    // `session_before_switch`), and `skipUnconsumed` only spares records whose
    // results the LLM has yet to read — it does not make the sweep partial in
    // the sense that matters here. A new session means new handles, or
    // `@explore` would silently reach an agent the user never started. Claude
    // Code resets its registry on `/clear` for the same reason.
    this.tombstones.clear();
  }

  /**
   * Whether any agents are still running or queued — including a stopped one
   * whose run has not settled yet, which still holds its slot.
   */
  hasRunning(): boolean {
    for (const run of this.runs.values()) if (this.isVisible(run.record)) return true;
    return [...this.agents.values()].some(record => isBusy(record) && this.isVisible(record));
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    const queued = this.queue
      .map(entry => this.agents.get(entry.id))
      .filter((record): record is AgentRecord => record?.status === "queued");
    this.dequeue(() => true);
    for (const record of queued) {
      this.stopQueued(record);
      count++;
    }
    // Abort running agents
    for (const [id, record] of this.agents) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        this.armStopGrace(id);
        count++;
      }
    }
    return count;
  }

  /**
   * After abortAll() on quit: wait, at most `timeoutMs`, for runs that own a
   * worktree (or may still be creating one) to settle, so their cleanup — the
   * commit and branch that preserve the agent's changes — finishes before the
   * process exits instead of racing it.
   */
  async awaitWorktreeCleanup(timeoutMs: number, ids?: ReadonlySet<string>): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const record of this.agents.values()) {
      if (ids !== undefined && !ids.has(record.id)) continue;
      const startup = this.startups.get(record.id);
      if (!record.worktree && !startup) continue;
      // Re-checked after startup: only a run that ended up with a worktree has
      // cleanup worth waiting for.
      pending.push((startup ?? Promise.resolve()).catch(() => {}).then(() => record.worktree ? record.promise : undefined));
    }
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending: Promise<unknown>[] = [];
      for (const record of this.agents.values()) {
        if (record.status !== "running" && record.status !== "queued") continue;
        // Another session's agents keep running; this session does not wait on them.
        if (!this.isVisible(record)) continue;
        // An agent whose worktree is still being created is "running" with no
        // `promise` yet — without its startup the wait would return too early.
        const startup = this.startups.get(record.id);
        if (startup) pending.push(startup);
        if (record.promise) pending.push(record.promise);
      }
      // A stopped run still winding down holds its slot, and whatever is queued
      // behind it starts only once it settles (or is abandoned).
      for (const run of this.runs.values()) if (this.isVisible(run.record)) pending.push(run.done);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * @param pi - Needed to run `git worktree prune`, which is async now and so
   *   cannot be reached through a stored spawn argument at shutdown. Omitting
   *   it (tests, teardown of a manager that never spawned) skips the prune.
   */
  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    // Clear queue — via dequeue, so anyone blocked in spawnAndWait is woken
    // rather than left awaiting a gate nothing will ever resolve.
    this.dequeue(() => true);
    // Release anyone waiting on a run, and stop the grace timers: the runs
    // themselves are stopped by their sessions' disposal below.
    for (const run of this.runs.values()) {
      if (run.graceTimer) clearTimeout(run.graceTimer);
      run.settled = true;
      run.resolveDone();
    }
    this.runs.clear();
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    const sessions = [...this.agents.values()].filter(record => !this.released.has(record)).map(record => record.session);
    this.agents.clear();
    this.startups.clear();
    this.pendingArgs.clear();
    if (pi) {
      // Prune any orphaned git worktrees (crash recovery). Detached: dispose runs
      // on the shutdown path, which cannot wait for git. Started before the awaited
      // shutdown below rather than after it, so the git calls have that window to
      // finish in instead of racing the process exit that follows.
      const prune = (repo: string) => { this.svc().pruneWorktrees(pi, repo).catch(() => {}); };
      prune(process.cwd());
      // Also prune repos that caller-supplied cwds created worktrees in — a clean
      // exit with in-flight agents would otherwise leave stale registrations there.
      for (const repo of this.worktreeRepos) prune(repo);
    }
    // Awaited, unlike the eviction path: pi awaits this extension's `session_shutdown`
    // handler and the process exits right after it returns, so anything left unawaited
    // here never runs at all. Bounded — each call carries its own ceiling, concurrently.
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
