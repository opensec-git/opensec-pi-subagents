/**
 * Stops, settles and completions in AgentManager, with a mocked runner.
 *
 * "stopped" is what the user sees the moment they stop an agent; the run itself
 * settles later — after committing its worktree, or never, when a tool ignores
 * its AbortSignal. These pin that every reader of the state sees the real one,
 * that every stop reaches onComplete exactly once, and that a run which never
 * ends is abandoned after a grace period instead of holding its slot forever.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  restoreWorktree: vi.fn(async () => undefined),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

const pi = {} as any;
const ctx = { cwd: "/tmp" } as any;
const session = (extra: Record<string, unknown> = {}) => ({ dispose: vi.fn(), steer: vi.fn(async () => {}), ...extra } as any);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A run that settles `delayMs` after its signal aborts (a slow worktree commit, a slow abort). */
function slowAbortRun(delayMs: number) {
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
    o.onSessionCreated?.(session());
    await new Promise<void>(r => o.signal.addEventListener("abort", () => setTimeout(r, delayMs), { once: true }));
    return { responseText: "partial", session: session(), aborted: false, steered: false };
  });
}

/** A run whose tool ignores the abort: it never settles unless `release` is called. */
function hangingRun() {
  const releases: Array<() => void> = [];
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
    o.onSessionCreated?.(session({ isStreaming: true }));
    await new Promise<void>(r => { releases.push(r); });
    return { responseText: "late", session: session(), aborted: false, steered: false };
  });
  return { releaseAll: () => { for (const r of releases) r(); } };
}

const counters = (m: AgentManager) => m as unknown as { runningBackground: number; runningForeground: number };

describe("stopped is not settled", () => {
  let m: AgentManager | undefined;
  afterEach(async () => { await m?.dispose(); m = undefined; vi.mocked(runAgent).mockReset(); });

  it("waitForAll waits for a stopped run that is still settling, and for the agent queued behind it", async () => {
    slowAbortRun(150);
    m = new AgentManager(undefined, 1);
    const s = m.spawn(pi, ctx, "general-purpose", "x", { description: "S", isBackground: true });
    const q = m.spawn(pi, ctx, "general-purpose", "x", { description: "Q", isBackground: true });
    expect(m.getRecord(q)!.status).toBe("queued");
    m.abort(s);
    expect(m.getRecord(s)!.status).toBe("stopped");
    // Still settling: it holds its slot, and everything reports that.
    expect(m.hasRunning()).toBe(true);
    expect(m.isRunActive(s)).toBe(true);

    // Q starts once S settles; stop it as soon as it runs so waitForAll can end.
    const stopQ = setInterval(() => { if (m?.getRecord(q)?.status === "running") m.abort(q); }, 5);
    const t0 = Date.now();
    await m.waitForAll();
    clearInterval(stopQ);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(m.getRecord(q)!.status).toBe("stopped");
    expect(m.hasRunning()).toBe(false);
    expect(m.isRunActive(s)).toBe(false);
  });
});

describe("every stop reaches onComplete", () => {
  let m: AgentManager | undefined;
  afterEach(async () => { await m?.dispose(); m = undefined; vi.mocked(runAgent).mockReset(); vi.mocked(createWorktree).mockReset(); });

  it("an agent stopped while queued", async () => {
    slowAbortRun(10_000);
    const done: string[] = [];
    m = new AgentManager(r => done.push(`${r.description}:${r.status}`), 1);
    m.spawn(pi, ctx, "general-purpose", "x", { description: "S", isBackground: true });
    const q = m.spawn(pi, ctx, "general-purpose", "x", { description: "Q", isBackground: true });
    m.abort(q);
    expect(m.getRecord(q)!.status).toBe("stopped");
    expect(done).toEqual(["Q:stopped"]);
  });

  it("an agent queued with a signal that was already aborted", () => {
    slowAbortRun(10_000);
    const done: string[] = [];
    m = new AgentManager(r => done.push(`${r.description}:${r.status}`), 1);
    m.spawn(pi, ctx, "general-purpose", "x", { description: "S", isBackground: true });
    const ac = new AbortController();
    ac.abort();
    m.spawn(pi, ctx, "general-purpose", "x", { description: "Q", isBackground: true, signal: ac.signal });
    expect(done).toEqual(["Q:stopped"]);
  });

  it("queued agents stopped by abortAll", () => {
    slowAbortRun(10_000);
    const done: string[] = [];
    m = new AgentManager(r => done.push(`${r.description}:${r.status}`), 1);
    m.spawn(pi, ctx, "general-purpose", "x", { description: "S", isBackground: true });
    m.spawn(pi, ctx, "general-purpose", "x", { description: "Q1", isBackground: true });
    m.spawn(pi, ctx, "general-purpose", "x", { description: "Q2", isBackground: true });
    expect(m.abortAll()).toBe(3);
    expect(done).toEqual(["Q1:stopped", "Q2:stopped"]);
  });

  it("an agent stopped while its worktree is being created — and its slot is freed", async () => {
    let finishCopy!: (v: any) => void;
    vi.mocked(createWorktree).mockImplementation(() => new Promise(r => { finishCopy = r; }));
    const done: string[] = [];
    m = new AgentManager(r => done.push(r.status), 1);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "W", isBackground: true, isolation: "worktree" });
    m.abort(id);
    finishCopy({ path: "/tmp/wt", workPath: "/tmp/wt", branch: "b", baseSha: "x" });
    await sleep(20);
    expect(m.getRecord(id)!.status).toBe("stopped");
    expect(done).toEqual(["stopped"]);
    expect(cleanupWorktree).toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(counters(m).runningBackground).toBe(0);
  });

  it("a spawn whose signal fires while its worktree is being created never runs", async () => {
    let finishCopy!: (v: any) => void;
    vi.mocked(createWorktree).mockImplementation(() => new Promise(r => { finishCopy = r; }));
    const done: string[] = [];
    m = new AgentManager(r => done.push(r.status), 5);
    const ac = new AbortController();
    const id = m.spawn(pi, ctx, "general-purpose", "x", {
      description: "W", isBackground: true, isolation: "worktree", signal: ac.signal,
    });
    ac.abort(); // e.g. a workflow skip before the manager has issued the id
    finishCopy({ path: "/tmp/wt", workPath: "/tmp/wt", branch: "b", baseSha: "x" });
    await sleep(20);
    expect(m.getRecord(id)!.status).toBe("stopped");
    expect(done).toEqual(["stopped"]);
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("no unhandled rejections from completion callbacks", () => {
  let m: AgentManager | undefined;
  afterEach(async () => { await m?.dispose(); m = undefined; vi.mocked(runAgent).mockReset(); });

  it("a throwing onComplete on the error path does not reject record.promise", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("cleanup/pi.exec: extension context is stale"));
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => { seen.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Stands in for index.ts's handler after a session switch: pi.events.emit throws.
      m = new AgentManager(() => { throw new Error("stale pi.events.emit"); }, 5);
      const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "E", isBackground: true });
      await m.getRecord(id)!.promise;
      await sleep(20);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});

describe("RPC spawns that omit isBackground", () => {
  let m: AgentManager | undefined;
  afterEach(async () => { await m?.dispose(); m = undefined; vi.mocked(runAgent).mockReset(); });

  it("are left unconsumed on settle, so the parent is notified (docs/rpc.md)", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "r", session: session(), aborted: false, steered: false } as any);
    const seen: Array<boolean | undefined> = [];
    m = new AgentManager(r => seen.push(r.resultConsumed), 5);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "rpc" }); // what spawnTopLevel forwards
    await m.getRecord(id)!.promise;
    expect(seen).toEqual([undefined]);
  });

  it("an explicit isBackground: false is still consumed by its inline caller", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "r", session: session(), aborted: false, steered: false } as any);
    const seen: Array<boolean | undefined> = [];
    m = new AgentManager(r => seen.push(r.resultConsumed), 5);
    await m.spawnAndWait(pi, ctx, "general-purpose", "x", { description: "fg" });
    expect(seen).toEqual([true]);
  });
});

describe("a run whose tool ignores the abort", () => {
  let m: AgentManager | undefined;
  afterEach(async () => { await m?.dispose(); m = undefined; vi.mocked(runAgent).mockReset(); vi.mocked(resumeAgent).mockReset(); });

  it("is abandoned after the grace period: slot freed once, completion once, queue proceeds", async () => {
    const hang = hangingRun();
    const done: string[] = [];
    m = new AgentManager(r => done.push(`${r.description}:${r.status}`), 1);
    m.setStopGraceMs(50);
    const a = m.spawn(pi, ctx, "general-purpose", "x", { description: "A", isBackground: true });
    const b = m.spawn(pi, ctx, "general-purpose", "x", { description: "B", isBackground: true });
    await sleep(0);
    expect(m.getRecord(b)!.status).toBe("queued");

    expect(m.abort(a)).toBe(true);
    expect(m.getRecord(a)!.status).toBe("stopped");
    expect(m.hasRunning()).toBe(true);
    expect(done).toEqual([]); // not settled yet

    await m.getRecord(a)!.promise; // resolves on abandonment
    expect(done).toEqual(["A:stopped"]);
    expect(m.getRecord(a)!.error).toMatch(/abandoned/);
    expect(m.getRecord(b)!.status).toBe("running"); // the freed slot went to B
    expect(counters(m).runningBackground).toBe(1);

    m.abort(b);
    await m.getRecord(b)!.promise;
    expect(counters(m).runningBackground).toBe(0);
    expect(m.hasRunning()).toBe(false);

    // The abandoned runs end after all: nothing settles a second time.
    hang.releaseAll();
    await sleep(20);
    expect(done).toEqual(["A:stopped", "B:stopped"]);
    expect(counters(m).runningBackground).toBe(0);
    expect(m.getRecord(a)!.result).toBeUndefined();
  });

  it("a foreground caller returns promptly after Esc, and is not left waiting for the grace", async () => {
    hangingRun();
    m = new AgentManager(undefined, 10);
    m.setStopGraceMs(60_000);
    const ac = new AbortController();
    const pending = m.spawnAndWait(pi, ctx, "general-purpose", "x", { description: "FG", signal: ac.signal });
    await sleep(10);
    const t0 = Date.now();
    ac.abort();
    const { record } = await pending;
    expect(Date.now() - t0).toBeLessThan(4_500);
    expect(record.status).toBe("stopped");
  }, 10_000);

  it("the 10-minute cleanup never evicts (or disposes the session of) a stopped run that has not settled", async () => {
    const live = session();
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      o.onSessionCreated?.(live);
      return new Promise(() => {});
    });
    m = new AgentManager(undefined, 1);
    m.setStopGraceMs(60_000);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "H", isBackground: true });
    await sleep(0);
    m.abort(id);
    m.getRecord(id)!.completedAt = Date.now() - 11 * 60_000;
    (m as any).cleanup();
    m.clearCompleted();
    await sleep(10);
    expect(m.getRecord(id)).toBeDefined();
    expect(live.dispose).not.toHaveBeenCalled();
  });

  it("a resume after abandonment reopens the conversation from its session file", async () => {
    let stuck: any;
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      if (o.resumeSessionFile) {
        o.onSessionCreated?.(session({ sessionManager: { getSessionFile: () => o.resumeSessionFile } }));
        return { responseText: "reopened", session: session(), aborted: false, steered: false };
      }
      stuck = session({ isStreaming: true, sessionManager: { getSessionFile: () => "/tmp/does-not-matter.jsonl" } });
      o.onSessionCreated?.(stuck);
      return new Promise(() => {});
    });
    m = new AgentManager(undefined, 5);
    m.setStopGraceMs(20);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "R", isBackground: true });
    await sleep(0);
    m.abort(id);
    await m.getRecord(id)!.promise;

    // The file check is the manager's own; point it at a real pi session file.
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-reopen-"));
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "0b9f3c1e-2a4d-4c8e-9f10-1a2b3c4d5e6f", timestamp: new Date(0).toISOString(), cwd: dir })}\n`);
      m.getRecord(id)!.sessionFile = file;
      const resumed = await m.resume(id, "again", undefined, { pi, ctx: { ...ctx, modelRegistry: { find: () => undefined } } });
      expect(resumed?.result).toBe("reopened");
      expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3]).toMatchObject({ resumeSessionFile: file });
      expect(resumeAgent).not.toHaveBeenCalled(); // never prompted the stuck session
      await sleep(10);
      expect(stuck.dispose).toHaveBeenCalled(); // detached, so it cannot write to the file
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a background resume that hangs is abandoned the same way", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: session(), aborted: false, steered: false } as any);
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    const done: string[] = [];
    m = new AgentManager(r => done.push(r.status), 1);
    m.setStopGraceMs(20);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "BR", isBackground: true });
    await m.getRecord(id)!.promise;
    const record = (await m.resume(id, "more", undefined, { isBackground: true })) as AgentRecord;
    expect(record.status).toBe("running");
    m.abort(id);
    await record.promise;
    expect(done).toEqual(["completed", "stopped"]);
    expect(counters(m).runningBackground).toBe(0);
    expect(m.hasRunning()).toBe(false);
  });
});
