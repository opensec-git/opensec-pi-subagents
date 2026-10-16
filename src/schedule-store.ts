/**
 * schedule-store.ts — File-backed store for scheduled subagents.
 *
 * Session-scoped: each pi session owns its own schedules at
 * `<cwd>/.pi/subagent-schedules/<sessionId>.json`. `/new` starts a fresh
 * empty store; `/resume` reloads.
 *
 * Concurrency model lifted from pi-chonky-tasks/src/task-store.ts: every
 * mutation acquires a PID-based exclusion lock, re-reads the latest state
 * from disk, applies the change, atomic-writes via temp+rename, releases.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScheduledSubagent, ScheduleStoreData } from "./types.js";

const LOCK_RETRY_MS = 50;
/** How long the async path keeps retrying a held lock, without blocking the event loop. */
const DEFAULT_LOCK_WAIT_MS = 5_000;
/**
 * A lock older than this is stale whoever it names. Holders keep it for the
 * milliseconds a read-modify-write takes, so an old lock means its holder died
 * — and its pid may since have been reused by an unrelated live process, which
 * would otherwise make the lock permanent.
 */
const LOCK_STALE_MS = 30_000;

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else — alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the lock if it is free (or stale), without waiting. Never blocks: the
 * store runs on pi's event loop, and a synchronous wait froze the whole TUI.
 * Returns false while another live process holds it.
 */
function tryAcquireLock(lockPath: string): boolean {
  // A few passes: one to clear a stale lock, one to take it, one for a race.
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (!pid || !isProcessRunning(pid) || age > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // vanished between the write and the read — try again
      }
      return false;
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/** Resolve the storage path for a session-scoped store. */
export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${sessionId}.json`);
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private lockWaitMs: number;
  private jobs = new Map<string, ScheduledSubagent>();
  /** Async writes waiting for the lock, and the last of them (for ordering). */
  private queuedWrites = 0;
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, options: { lockWaitMs?: number } = {}) {
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.load();
  }

  /** Create the backing directory lazily — only when we're about to persist. */
  private ensureDir(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /**
   * Load from disk into the in-memory cache. A file that does not parse is
   * moved aside to `<file>.corrupt` (with a warning) before the next save
   * replaces it, so a hand-edit gone wrong can be recovered.
   */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    let data: ScheduleStoreData;
    try {
      data = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch (err) {
      const backup = `${this.filePath}.corrupt`;
      try {
        renameSync(this.filePath, backup);
        console.warn(
          `[pi-subagents] Schedule file ${this.filePath} is not valid JSON (${err instanceof Error ? err.message : String(err)}); moved it to ${backup}.`,
        );
      } catch (moveErr) {
        console.warn(`[pi-subagents] Schedule file ${this.filePath} is not valid JSON and could not be moved aside:`, moveErr);
      }
      return;
    }
    this.jobs.clear();
    for (const j of Array.isArray(data?.jobs) ? data.jobs : []) this.jobs.set(j.id, j);
  }

  /** Atomic write via temp file + rename (POSIX-atomic). */
  private save(): void {
    const data: ScheduleStoreData = { version: 1, jobs: [...this.jobs.values()] };
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** Reload → mutate → save → release, with the lock already held. */
  private underLock<T>(fn: () => T): T {
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  /**
   * Acquire lock → reload → mutate → save → release. Fails at once, rather
   * than blocking pi's event loop, when another process holds the lock: the
   * callers are interactive (the Agent tool, the menu) and can say so.
   */
  private withLock<T>(fn: () => T): T {
    this.ensureDir();
    if (!tryAcquireLock(this.lockPath)) {
      throw new Error(`The schedule store is busy (locked by another pi process): ${this.lockPath}`);
    }
    return this.underLock(fn);
  }

  /**
   * As `withLock`, but waits for a held lock — asynchronously, never blocking
   * the event loop. Writes are applied in call order: one that finds the lock
   * free and nothing queued applies at once (synchronously), anything else
   * queues behind the writes before it.
   */
  private withLockAsync<T>(fn: () => T): Promise<T> {
    try {
      this.ensureDir();
      if (this.queuedWrites === 0 && tryAcquireLock(this.lockPath)) return Promise.resolve(this.underLock(fn));
    } catch (err) {
      return Promise.reject(err);
    }
    this.queuedWrites++;
    const write = this.writeTail.then(async () => {
      const deadline = Date.now() + this.lockWaitMs;
      while (!tryAcquireLock(this.lockPath)) {
        if (Date.now() >= deadline) throw new Error(`Failed to acquire schedule lock: ${this.lockPath}`);
        await new Promise<void>(resolve => setTimeout(resolve, LOCK_RETRY_MS));
      }
      return this.underLock(fn);
    }).finally(() => { this.queuedWrites--; });
    this.writeTail = write.catch(() => {});
    return write;
  }

  /** Read-only — returns a snapshot of the in-memory cache. */
  list(): ScheduledSubagent[] {
    return [...this.jobs.values()];
  }

  /** Read-only check — uses the cache. */
  hasName(name: string, exceptId?: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.id !== exceptId && j.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    return this.jobs.get(id);
  }

  add(job: ScheduledSubagent): void {
    this.withLock(() => {
      this.jobs.set(job.id, job);
    });
  }

  update(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    // No-op fast path — an unknown id changes nothing, so don't lock or touch
    // disk (which would otherwise lazily create the backing directory).
    if (!this.jobs.has(id)) return undefined;
    return this.withLock(() => this.applyPatch(id, patch));
  }

  /** `update` for timer-driven callers: waits for a held lock without blocking. */
  async updateAsync(id: string, patch: Partial<ScheduledSubagent>): Promise<ScheduledSubagent | undefined> {
    if (!this.jobs.has(id)) return undefined;
    return this.withLockAsync(() => this.applyPatch(id, patch));
  }

  private applyPatch(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.jobs.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    // No-op fast path — see update().
    if (!this.jobs.has(id)) return false;
    return this.withLock(() => this.jobs.delete(id));
  }

  /** Delete the backing file (used when no jobs remain, optional cleanup). */
  deleteFileIfEmpty(): void {
    if (this.jobs.size === 0 && existsSync(this.filePath)) {
      try { unlinkSync(this.filePath); } catch { /* ignore */ }
    }
  }
}
