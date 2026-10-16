/**
 * schedule.ts — `SubagentScheduler`: timer-driven dispatcher of scheduled subagents.
 *
 * Mirrors the engine shape of pi-cron-schedule/src/scheduler.ts:
 *   - two-Map split (jobs = croner Cron, intervals = setInterval/setTimeout)
 *   - addJob/removeJob/updateJob/scheduleJob/unscheduleJob/executeJob
 *   - static parsers for cron / "+10m" / "5m" / ISO formats
 *
 * Differences vs pi-cron-schedule:
 *   - Persistence is via ScheduleStore (PID-locked, session-scoped, atomic).
 *   - `executeJob` calls `manager.spawn(..., { bypassQueue: true })` instead
 *     of dispatching a user message — schedule fires bypass maxConcurrent so
 *     a 5-minute interval can't be deferred behind 4 long-running agents.
 *   - Result delivery is implicit: spawn → background completion → existing
 *     `subagent-notification` path. No new delivery code.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { AgentManager } from "./agent-manager.js";
import { normalizeMaxTurns } from "./agent-runner.js";
import { resolveSpawnType } from "./agent-types.js";
import { isModelOverrideAllowed } from "./invocation-config.js";
import { type LongTimer, setLongTimeout } from "./long-timer.js";
import { resolveModel } from "./model-resolver.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { IsolationMode, ScheduledSubagent, SubagentType, ThinkingLevel } from "./types.js";

/**
 * Shortest interval a job may repeat at. Every fire spawns an agent outside the
 * concurrency queue, so a seconds-scale interval would flood the session.
 */
export const MIN_INTERVAL_MS = 60_000;

/** Longest interval or relative delay accepted ("3650d", about ten years). */
export const MAX_SCHEDULE_MS = 3650 * 86_400_000;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Event emitted on `pi.events` for cross-extension consumers. */
export type ScheduleChangeEvent =
  | { type: "added"; job: ScheduledSubagent }
  | { type: "removed"; jobId: string }
  | { type: "updated"; job: ScheduledSubagent }
  | { type: "fired"; jobId: string; agentId: string; name: string }
  | { type: "skipped"; jobId: string; agentId: string; reason: string }
  | { type: "error"; jobId: string; error: string };

/** Params accepted at job creation — ID, timestamps, and state are derived. */
export interface NewJobInput {
  name: string;
  description: string;
  schedule: string;
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;
}

export class SubagentScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, LongTimer>();
  /** Agent spawned by each job's latest fire, for the overlap guard. */
  private lastAgent = new Map<string, string>();
  /**
   * When each armed interval or one-shot timer fires next (epoch ms). The
   * interval timer is re-armed from the FIRE time, so the next run is that,
   * not the previous run's completion plus the interval.
   */
  private nextFire = new Map<string, number>();

  /** `minIntervalMs` lowers the interval floor for stored jobs (tests only). */
  constructor(private readonly minIntervalMs = MIN_INTERVAL_MS) {}
  private store: ScheduleStore | undefined;
  private pi: ExtensionAPI | undefined;
  private ctx: ExtensionContext | undefined;
  private manager: AgentManager | undefined;

  /** Start the scheduler: bind to a session's store and arm enabled jobs. */
  start(pi: ExtensionAPI, ctx: ExtensionContext, manager: AgentManager, store: ScheduleStore): void {
    this.pi = pi;
    this.ctx = ctx;
    this.manager = manager;
    this.store = store;

    for (const job of store.list()) {
      if (job.enabled) this.scheduleJob(job);
    }
  }

  /** Stop all timers; drop refs. Safe to call repeatedly. */
  stop(): void {
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const t of this.intervals.values()) t.cancel();
    this.intervals.clear();
    this.nextFire.clear();
    this.store = undefined;
    this.pi = undefined;
    this.ctx = undefined;
    this.manager = undefined;
  }

  /** True if start() has bound a store and the scheduler is active. */
  isActive(): boolean {
    return this.store !== undefined;
  }

  list(): ScheduledSubagent[] {
    return this.store?.list() ?? [];
  }

  /**
   * Build a `ScheduledSubagent` from user input. Validates the schedule
   * format and tags `scheduleType`. Throws on invalid input.
   */
  buildJob(input: NewJobInput): ScheduledSubagent {
    const detected = SubagentScheduler.detectSchedule(input.schedule);
    return {
      id: nanoid(10),
      name: input.name,
      description: input.description,
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      model: input.model,
      thinking: input.thinking,
      max_turns: input.max_turns,
      isolated: input.isolated,
      isolation: input.isolation,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
  }

  /** Add a job, persist, and arm if enabled. Returns the stored job. */
  addJob(input: NewJobInput): ScheduledSubagent {
    const store = this.requireStore();
    if (store.hasName(input.name)) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }
    const job = this.buildJob(input);
    store.add(job);
    if (job.enabled) this.scheduleJob(job);
    this.emit({ type: "added", job });
    return job;
  }

  removeJob(id: string): boolean {
    const store = this.requireStore();
    if (!store.get(id)) return false;
    this.unscheduleJob(id);
    this.lastAgent.delete(id);
    const ok = store.remove(id);
    if (ok) this.emit({ type: "removed", jobId: id });
    return ok;
  }

  /** Toggle / mutate a job. Re-arms based on the new `enabled` state. */
  updateJob(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    const store = this.requireStore();
    const updated = store.update(id, patch);
    if (!updated) return undefined;
    this.unscheduleJob(id);
    if (updated.enabled) this.scheduleJob(updated);
    this.emit({ type: "updated", job: updated });
    return updated;
  }

  /** Next-run time as ISO, or undefined if not currently armed. */
  getNextRun(jobId: string): string | undefined {
    const cron = this.jobs.get(jobId);
    if (cron) return cron.nextRun()?.toISOString();
    const job = this.store?.get(jobId);
    if (!job?.enabled) return undefined;
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) {
      // The armed timer's own target when there is one. Otherwise (not armed
      // in this process) an estimate from the last run.
      const armed = this.nextFire.get(jobId);
      if (armed !== undefined) return new Date(armed).toISOString();
      const base = job.lastRun ? new Date(job.lastRun).getTime() : Date.now();
      return new Date(base + job.intervalMs).toISOString();
    }
    return undefined;
  }

  // ── Scheduling primitives ────────────────────────────────────────────

  private scheduleJob(job: ScheduledSubagent): void {
    const store = this.store;
    if (!store) return;
    try {
      if (job.scheduleType === "interval" && job.intervalMs) {
        // Chained long timers, not setInterval: a delay above 2^31-1 ms is
        // clamped to 1 ms, which turned "30d" into a fire every millisecond.
        // The floor also covers jobs stored before the minimum existed.
        const every = Math.min(Math.max(job.intervalMs, this.minIntervalMs), MAX_SCHEDULE_MS);
        const arm = () => {
          this.nextFire.set(job.id, Date.now() + every);
          this.intervals.set(job.id, setLongTimeout(() => {
            arm();
            void this.executeJob(job.id);
          }, every));
        };
        arm();
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule).getTime();
        const delay = target - Date.now();
        if (delay > 0) {
          this.nextFire.set(job.id, target);
          const t = setLongTimeout(() => {
            this.intervals.delete(job.id);
            this.nextFire.delete(job.id);
            this.fireOnce(job.id, store);
          }, delay);
          this.intervals.set(job.id, t);
        } else {
          // Past timestamp — disable, mark error, never fire
          store.update(job.id, { enabled: false, lastStatus: "error" });
          this.emit({ type: "error", jobId: job.id, error: `Scheduled time ${job.schedule} is in the past` });
        }
      } else {
        // `catch: true` as a backstop: executeJob never rejects, but croner
        // runs the callback in an async trigger that would otherwise turn a
        // throw into an unhandled rejection — which ends pi.
        const cron = new Cron(job.schedule, { catch: true }, () => { void this.executeJob(job.id); });
        this.jobs.set(job.id, cron);
      }
    } catch (err) {
      this.emit({ type: "error", jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const t = this.intervals.get(id);
    if (t) {
      t.cancel();
      this.intervals.delete(id);
    }
    this.nextFire.delete(id);
  }

  /** Fire a one-shot, then disable it (mirrors pi-cron-schedule). Never throws. */
  private fireOnce(id: string, store: ScheduleStore): void {
    void this.executeJob(id);
    // Queued behind the fire's own writes by the store, so it lands last.
    store.updateAsync(id, { enabled: false }).then(
      () => {
        const updated = store.get(id);
        if (updated) this.emit({ type: "updated", job: updated });
      },
      (err) => this.emit({ type: "error", jobId: id, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  /**
   * Fire a job: persist running state, spawn (bypassing the concurrency
   * queue), persist completion. Called detached from a timer or Cron tick, so
   * it never rejects: a failure (a busy store lock, a full disk) becomes an
   * `error` event, never an exception out of a timer callback — pi exits on
   * those.
   */
  private async executeJob(id: string): Promise<void> {
    try {
      await this.fireJob(id);
    } catch (err) {
      this.emit({ type: "error", jobId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * The fire itself. Synchronous up to the spawn — `updateAsync` applies at
   * once when the lock is free, so the order of writes and events is what it
   * always was — and returns the bookkeeping that may still be waiting on a
   * lock another process holds.
   */
  private fireJob(id: string): Promise<void> {
    const store = this.store;
    const pi = this.pi;
    const ctx = this.ctx;
    const manager = this.manager;
    if (!store || !pi || !ctx || !manager) return Promise.resolve();
    const job = store.get(id);
    if (!job?.enabled) return Promise.resolve();

    // Overlap guard: fires bypass the concurrency queue, so a run that outlasts
    // its interval would otherwise stack another agent on top of it every tick.
    // A stopped run still winding down counts as active: "stopped" is set
    // before the run has ended.
    const previous = this.lastAgent.get(id);
    if (previous && manager.isRunActive(previous)) {
      this.emit({ type: "skipped", jobId: id, agentId: previous, reason: "the previous run is still active" });
      return Promise.resolve();
    }

    const marked = store.updateAsync(id, { lastStatus: "running" });

    // Resolve model at fire time — registry contents may have changed since the
    // job was created (auth added/removed). Fall back silently to spawn-default
    // if resolution fails; the spawn path handles undefined model gracefully.
    let resolvedModel: any | undefined;
    // A job's model and thinking level came from the call that scheduled it,
    // so they count only while `allowModelOverride` is on; otherwise each fire
    // runs on the parent's current model and level, like any other spawn.
    const overridesAllowed = isModelOverrideAllowed();
    const thinking = overridesAllowed ? job.thinking : undefined;
    if (job.model && overridesAllowed) {
      const r = resolveModel(job.model, ctx.modelRegistry);
      if (typeof r !== "string") resolvedModel = r;
    }

    let agentId: string;
    try {
      // Re-resolve at fire time against the registry as it stands. This does not
      // reload from disk (the scheduler has no reason to rebuild process-global
      // state from a timer), so it catches changes that went through /agents or
      // an Agent call — not a file deleted directly from a shell. The catch below turns
      // this into lastStatus: "error" plus an error event, like any other
      // fire-time failure.
      const dispatch = resolveSpawnType(job.subagent_type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      agentId = manager.spawn(pi, ctx, dispatch.type, job.prompt, {
        description: job.description,
        isBackground: true,
        bypassQueue: true,
        model: resolvedModel,
        maxTurns: job.max_turns,
        isolated: job.isolated,
        thinkingLevel: thinking,
        isolation: job.isolation,
        // A scheduled run has no tool call to build this, so without it the
        // conversation viewer shows nothing about how the job was configured.
        // The model is left out on purpose: agent-manager fills in the effective
        // one when the session reports it, and naming the pre-session pick here
        // would only be right until then.
        invocation: {
          thinking,
          // Normalized like the Agent tool's own snapshot: `0` means unlimited,
          // and rendering it as "max turns: 0" would read as a limit of none.
          maxTurns: normalizeMaxTurns(job.max_turns),
          isolated: job.isolated,
          runInBackground: true,
          isolation: job.isolation,
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Ordered after `marked` by the store.
      const recorded = store.updateAsync(id, { lastRun: new Date().toISOString(), lastStatus: "error" });
      this.emit({ type: "error", jobId: id, error });
      return Promise.all([marked, recorded]).then(() => {});
    }

    this.lastAgent.set(id, agentId);
    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    const finalize = async (status: "success" | "error") => {
      const next = this.getNextRun(id);
      const current = store.get(id);
      await store.updateAsync(id, {
        lastRun: new Date().toISOString(),
        lastStatus: status,
        runCount: (current?.runCount ?? 0) + 1,
        nextRun: next,
      });
    };

    // AgentManager's promise resolves either way (its .catch returns ""), so we
    // can't infer success/failure from the promise — read record.status instead.
    // Terminal states: completed/steered = success; error/aborted/stopped = error.
    // awaitStartup first: with isolation: "worktree" the run promise only exists
    // once the repo copy is made, and a failed copy rejects here. Detached, so a
    // long run does not hold this fire; its own failure becomes an event.
    void (async () => {
      let failed = true;
      try {
        await marked.catch(() => {});
        await manager.awaitStartup(agentId);
        await manager.getRecord(agentId)?.promise;
        const r = manager.getRecord(agentId);
        failed = r?.status === "error" || r?.status === "aborted" || r?.status === "stopped";
      } catch { /* a failed startup is a failed run */ }
      try {
        await finalize(failed ? "error" : "success");
      } catch (err) {
        this.emit({ type: "error", jobId: id, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return marked.then(() => {});
  }

  private emit(event: ScheduleChangeEvent): void {
    // Guarded: emit runs from timer callbacks, where a throw (a stale pi after
    // a session switch) would be an uncaught exception.
    try { this.pi?.events.emit("subagents:scheduled", event); } catch { /* ignore */ }
  }

  private requireStore(): ScheduleStore {
    if (!this.store) throw new Error("Scheduler not started — no active session.");
    return this.store;
  }

  // ── Format detection / parsers (statics — pure) ──────────────────────

  /**
   * Sniff a schedule string and tag its type. Throws on invalid input.
   * Order matters: relative ("+10m") and interval ("5m") both match digit+unit;
   * relative requires the leading "+" to disambiguate.
   */
  static detectSchedule(s: string): { type: "cron" | "once" | "interval"; intervalMs?: number; normalized: string } {
    const trimmed = s.trim();
    // "+10m" — relative one-shot
    const rel = SubagentScheduler.parseRelativeTime(trimmed);
    if (rel !== null) return { type: "once", normalized: rel };
    // "5m" — interval
    const ivl = SubagentScheduler.parseInterval(trimmed);
    if (ivl !== null) {
      if (ivl < MIN_INTERVAL_MS) {
        throw new Error(`Interval "${trimmed}" is too short: jobs can repeat at most once a minute ("1m").`);
      }
      return { type: "interval", intervalMs: ivl, normalized: trimmed };
    }
    // ISO timestamp — one-shot. Reject past timestamps upfront so we never
    // create a dead-on-arrival record (scheduleJob's safety net still catches
    // micro-races from `+0s`-style relatives).
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= Date.now()) {
          throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
        }
        return { type: "once", normalized: d.toISOString() };
      }
    }
    // Cron — 6-field
    const cronCheck = SubagentScheduler.validateCronExpression(trimmed);
    if (cronCheck.valid) return { type: "cron", normalized: trimmed };
    throw new Error(
      `Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO).`
    );
  }

  /** 6-field cron — 'second minute hour dom month dow'. */
  static validateCronExpression(expr: string): { valid: boolean; error?: string } {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
      };
    }
    try {
      // Croner validates by construction. Parse only: passing a callback (as
      // this once did) also SCHEDULES the job — croner arms a non-unref'd
      // timer that re-arms itself forever and is never stopped, so every
      // validation leaked a live timer that kept the process alive.
      new Cron(expr);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : "Invalid cron expression" };
    }
  }

  /** "+10s"/"+5m"/"+1h"/"+2d" → ISO timestamp. Throws past MAX_SCHEDULE_MS. */
  static parseRelativeTime(s: string): string | null {
    const m = s.match(/^\+(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const ms = SubagentScheduler.boundedMs(s, Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]);
    return new Date(Date.now() + ms).toISOString();
  }

  /** "10s"/"5m"/"1h"/"2d" → milliseconds. Throws past MAX_SCHEDULE_MS. */
  static parseInterval(s: string): number | null {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    return SubagentScheduler.boundedMs(s, Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]);
  }

  private static boundedMs(input: string, ms: number): number {
    if (!Number.isSafeInteger(ms) || ms > MAX_SCHEDULE_MS) {
      throw new Error(`Schedule "${input}" is too far out: the limit is 3650d.`);
    }
    return ms;
  }
}
