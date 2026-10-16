/**
 * The scheduler's fire path against a busy or broken store.
 *
 * A fire runs from a bare timer or a Cron tick, where a throw is an uncaught
 * exception and pi exits. The store lock used to busy-wait with Atomics.wait —
 * freezing the whole TUI for 5 s — and then throw out of that callback.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

describe("scheduler fire path with a held store lock", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sched-lock-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function setup(lockWaitMs: number) {
    const path = join(dir, "s.json");
    const store = new ScheduleStore(path, { lockWaitMs });
    const sched = new SubagentScheduler();
    const manager: any = {
      getRecord: () => undefined,
      isRunActive: () => false,
      spawn: vi.fn(() => "a1"),
      awaitStartup: async () => {},
    };
    const pi: any = { events: { emit: vi.fn() } };
    sched.start(pi, { modelRegistry: {} } as any, manager, store);
    const job = sched.addJob({ name: "j", description: "j", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    return { path, store, sched, manager, pi, job };
  }

  it("never blocks the event loop and never throws: it reports an error event instead", async () => {
    const { path, sched, manager, pi, job } = setup(300);
    // A live pid that is not ours: a reused pid after a crash, or another pi.
    writeFileSync(`${path}.lock`, String(process.ppid));
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 20);
    try {
      const t0 = Date.now();
      // What the timer / Cron callback calls.
      const fired = (sched as any).executeJob(job.id) as Promise<void>;
      expect(Date.now() - t0).toBeLessThan(100); // returned at once
      await expect(fired).resolves.toBeUndefined();
      expect(ticks).toBeGreaterThan(5); // the loop kept running while it waited
    } finally {
      clearInterval(ticker);
      sched.stop();
    }
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: expect.stringMatching(/schedule lock/),
    }));
    // The spawn itself is not held up by a bookkeeping write.
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("an interactive write fails fast instead of freezing pi", () => {
    const { path, sched, job } = setup(300);
    writeFileSync(`${path}.lock`, String(process.ppid));
    const t0 = Date.now();
    expect(() => sched.updateJob(job.id, { enabled: false })).toThrow(/busy/);
    expect(Date.now() - t0).toBeLessThan(100);
    sched.stop();
  });

  it("treats an old lock as stale even when its pid is alive (reused after a crash)", () => {
    const { path, store, sched, job } = setup(300);
    const lock = `${path}.lock`;
    writeFileSync(lock, String(process.ppid));
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    expect(store.update(job.id, { lastStatus: "success" })?.lastStatus).toBe("success");
    sched.stop();
  });
});
