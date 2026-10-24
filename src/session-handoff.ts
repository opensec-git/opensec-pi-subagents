/**
 * session-handoff.ts — keep background agents running across a session switch.
 *
 * ## The problem
 *
 * Pi tears an extension instance down with its session: `/new`, `/resume`,
 * `/fork` and `/reload` emit `session_shutdown` (reason `new`, `resume`, `fork`
 * or `reload`), invalidate the instance's `pi` and every ctx, and load the
 * extension again — a fresh module, since Pi's loader does not cache modules —
 * for the next session, which then gets `session_start`. Before this, the
 * manager stopped every running agent at that shutdown, so a background agent
 * died whenever the user looked at another session.
 *
 * ## What happens instead
 *
 * On a switch (never on `quit`, which also covers `/quit` and SIGTERM/SIGHUP),
 * an instance with background agents still running parks its manager here, in
 * a process-global slot keyed by package name. The next instance adopts it at
 * `session_start` when the slot names the session it is starting (Pi passes the
 * target file with the shutdown) and was parked by the same version of this
 * package; a different version cannot share the manager's code, so it asks the
 * parked one to stop its agents itself, with its own code, as a quit would.
 *
 * While parked — between the old instance's shutdown and the new one's start —
 * completions are queued in the slot and handed to the adopter. An agent's
 * results always belong to the session that started it (`ownerSession`, its
 * session file): the index records them there, and delivers the notification
 * when that session is active again.
 *
 * ## The protocol between versions
 *
 * Only `protocol`, `version`, `targetSessionFile`, `sessionFile` and `stop` are
 * read across versions; keep their meaning stable. Everything else is read only
 * after `version` and `protocol` matched.
 */

import { existsSync } from "node:fs";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

/** The package version this code ships in. `test/session-handoff.test.ts` keeps it equal to package.json. */
export const PACKAGE_VERSION = "0.20.8";

/** Bumped when the shape of a parked entry changes within one version (never in a release). */
export const HANDOFF_PROTOCOL = 1;

const HANDOFF_KEY = Symbol.for("pi-subagents:handoff:@kushalkhemka/opensec-pi-subagents");

/** Writes an entry into the session `owner` if the caller can (it is the active one there); false otherwise. */
export type EntryWriter = (owner: string | undefined, customType: string, data: unknown) => boolean;

export interface ParkedSubagents {
  protocol: number;
  version: string;
  /** Why the session ended: `new`, `resume`, `fork` or `reload`. */
  reason: string;
  /** The session the parking instance belonged to. */
  sessionFile?: string;
  /** The session Pi is switching to, from the shutdown event. */
  targetSessionFile?: string;
  /** The live `AgentManager`, for a same-version adopter only. */
  manager: unknown;
  /** The parking instance's activity trackers of running agents, by id. */
  activity: Map<string, unknown>;
  /** Records that settled while parked, for the adopter's completion handler. */
  completed: unknown[];
  /**
   * Stop every agent with the parking instance's own code and record them in
   * their sessions, as a quit would. `write` lets the caller take entries for
   * the session it has open (a file append would fork that session's branch).
   */
  stop(write?: EntryWriter): Promise<void>;
  /** Removes the process-exit fallback; set by {@link parkSubagents}. */
  release?: () => void;
}

/** Whether a `session_shutdown` reason replaces the session within this process (as opposed to quitting). */
export function isSessionSwitch(reason: unknown): reason is "new" | "resume" | "fork" | "reload" {
  return reason === "new" || reason === "resume" || reason === "fork" || reason === "reload";
}

function slot(): Record<symbol, ParkedSubagents | undefined> {
  return globalThis as unknown as Record<symbol, ParkedSubagents | undefined>;
}

/**
 * Park a manager for the next instance. `onExit` runs synchronously if the
 * process exits while still parked (nothing adopted it): the only chance left
 * to record the agents as stopped.
 */
export function parkSubagents(entry: ParkedSubagents, onExit: () => void): void {
  // Something parked earlier and never adopted (an instance that did not
  // start): its agents are not reachable any more, so stop them.
  const stale = slot()[HANDOFF_KEY];
  if (stale && stale !== entry) {
    stale.release?.();
    void stale.stop().catch(() => {});
  }
  const exit = () => {
    if (slot()[HANDOFF_KEY] !== entry) return;
    try { onExit(); } catch { /* exiting */ }
  };
  process.once("exit", exit);
  entry.release = () => { process.off("exit", exit); };
  slot()[HANDOFF_KEY] = entry;
}

/**
 * Take the parked entry meant for the session that is starting, if any: the
 * one whose switch targeted `sessionFile` (or, for `/reload`, that left it).
 * Leaves an entry for another session in place.
 */
export function takeParkedSubagents(sessionFile: string | undefined): ParkedSubagents | undefined {
  const entry = slot()[HANDOFF_KEY];
  if (!entry || sessionFile === undefined) return undefined;
  const target = entry.reason === "reload" ? entry.sessionFile : entry.targetSessionFile;
  if (target !== sessionFile) return undefined;
  delete slot()[HANDOFF_KEY];
  entry.release?.();
  return entry;
}

/** Whether a parked entry was made by this very code, so its manager can be adopted. */
export function isCompatible(entry: ParkedSubagents): boolean {
  return entry.version === PACKAGE_VERSION && entry.protocol === HANDOFF_PROTOCOL;
}

/** The session an agent spawned from `ctx` belongs to: its session file, or undefined in memory. */
export function sessionFileOf(ctx: ExtensionContext | undefined): string | undefined {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    return typeof file === "string" ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a session can receive entries while it is not open: it has a file on disk. */
export function isSessionOnDisk(file: string | undefined): file is string {
  try {
    return file !== undefined && existsSync(file);
  } catch {
    return false;
  }
}

/**
 * Append a custom entry to a session that is NOT open in this process, on its
 * current leaf, as Pi's own `appendEntry` would. Pi reads the file when the
 * session is opened again. Returns whether it was written.
 *
 * Never for the open session: Pi keeps that one in memory and would put its
 * next entry beside this one rather than after it, leaving it off the branch.
 */
export function appendToSessionFile(file: string | undefined, customType: string, data: unknown): boolean {
  if (!isSessionOnDisk(file)) return false;
  try {
    SessionManager.open(file).appendCustomEntry(customType, data);
    return true;
  } catch {
    return false;
  }
}

/**
 * A frozen copy of a context, for work that starts after its session is gone:
 * an agent that was queued (or still creating its worktree) when the session
 * switched. A live ctx throws on every read once Pi invalidates it; this holds
 * the values it had at the switch, which is what the agent was spawned under.
 */
export function snapshotContext(ctx: ExtensionContext): ExtensionContext {
  const read = <T>(get: () => T): T | undefined => {
    try { return get(); } catch { return undefined; }
  };
  const systemPrompt = read(() => ctx.getSystemPrompt()) ?? "";
  const trusted = read(() => (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted?.());
  const snapshot = {
    cwd: read(() => ctx.cwd),
    model: read(() => ctx.model),
    modelRegistry: read(() => ctx.modelRegistry),
    thinkingLevel: read(() => (ctx as { thinkingLevel?: unknown }).thinkingLevel),
    sessionManager: read(() => ctx.sessionManager),
    mode: read(() => (ctx as { mode?: unknown }).mode),
    hasUI: false,
    getSystemPrompt: () => systemPrompt,
    ...(trusted !== undefined ? { isProjectTrusted: () => trusted } : {}),
  };
  return snapshot as unknown as ExtensionContext;
}
