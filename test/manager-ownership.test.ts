/**
 * manager-ownership.test.ts — the manager side of keeping agents across a
 * session switch: each agent's owning session, the surfaces scoped to the open
 * session, frozen contexts for spawns that start after a switch, and observers
 * an adopting instance rebinds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  restoreWorktree: vi.fn(async () => undefined),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { AgentManager, managerServices } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";

const pi = {} as any;
const ctxOf = (file: string | undefined) => ({
  cwd: "/tmp",
  sessionManager: { getSessionFile: () => file },
  getSystemPrompt: () => "",
}) as any;

/** runAgent that settles when the test says so. */
function controllableRuns() {
  const settle: Array<() => void> = [];
  vi.mocked(runAgent).mockImplementation((_ctx: any, _t: any, _p: any, opts: any) => new Promise((resolve) => {
    const session = { dispose: vi.fn() } as any;
    opts.onSessionCreated?.(session);
    settle.push(() => resolve({ responseText: "done", session, aborted: false, steered: false } as any));
  }) as any);
  return settle;
}

let manager: AgentManager | undefined;
afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  vi.mocked(runAgent).mockReset();
});

describe("owning session", () => {
  it("is the spawning ctx's session file; a nested child inherits its root's", () => {
    controllableRuns();
    manager = new AgentManager();
    const top = manager.spawn(pi, ctxOf("/a.jsonl"), "general-purpose", "x", { description: "top", isBackground: true });
    // A nested child's ctx is its parent agent's own session.
    const child = manager.spawn(pi, ctxOf("/child-session.jsonl"), "general-purpose", "y", { description: "child", parentAgentId: top, depth: 2 });
    expect(manager.getRecord(top)?.ownerSession).toBe("/a.jsonl");
    expect(manager.getRecord(child)?.ownerSession).toBe("/a.jsonl");
  });
});

describe("surfaces scoped to the open session", () => {
  it("list, resolve and wait only for the open session's agents; lookups by id still work", async () => {
    const settle = controllableRuns();
    manager = new AgentManager();
    const a = manager.spawn(pi, ctxOf("/a.jsonl"), "Explore", "x", { description: "a", isBackground: true });
    const b = manager.spawn(pi, ctxOf("/b.jsonl"), "Explore", "x", { description: "b", isBackground: true });
    await Promise.resolve();

    manager.setVisibleOwner("/b.jsonl");
    expect(manager.listAgents().map(r => r.id)).toEqual([b]);
    expect(manager.listAllAgents().map(r => r.id).sort()).toEqual([a, b].sort());
    expect(manager.resolveMention(a)).toBeUndefined();
    expect(manager.resolveMention(manager.getRecord(b)!.handle!)).toMatchObject({ kind: "live" });
    expect(manager.getRecord(a)).toBeDefined();

    // Only b holds this session's wait.
    settle[1]();
    await manager.waitForAll();
    expect(manager.getRecord(b)?.status).toBe("completed");
    expect(manager.getRecord(a)?.status).toBe("running");
    expect(manager.hasRunning()).toBe(false);

    manager.setVisibleOwner(null);
    expect(manager.hasRunning()).toBe(true);
    settle[0]();
  });
});

describe("a spawn that starts after its session switched", () => {
  it("runs with a frozen copy of its context, not the invalidated one", async () => {
    const settle = controllableRuns();
    manager = new AgentManager(undefined, 1);
    manager.spawn(pi, ctxOf("/a.jsonl"), "general-purpose", "first", { description: "first", isBackground: true });
    let stale = false;
    const live = {
      get cwd() { if (stale) throw new Error("stale ctx"); return "/tmp"; },
      get sessionManager() { if (stale) throw new Error("stale ctx"); return { getSessionFile: () => "/a.jsonl" }; },
      getSystemPrompt: () => { if (stale) throw new Error("stale ctx"); return "p"; },
    } as any;
    const queued = manager.spawn(pi, live, "general-purpose", "second", { description: "second", isBackground: true });
    expect(manager.getRecord(queued)?.status).toBe("queued");

    manager.detachPendingContexts();
    stale = true;
    settle[0]();
    await vi.waitFor(() => expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2));
    expect(manager.getRecord(queued)?.status).toBe("running");
    const startedWith = vi.mocked(runAgent).mock.calls[1][0];
    expect(startedWith === live).toBe(false);
    expect(startedWith.cwd).toBe("/tmp");
    settle[1]();
  });
});

describe("rebinding", () => {
  it("sends completions to the observers set last", async () => {
    const settle = controllableRuns();
    const before = vi.fn();
    const after = vi.fn();
    manager = new AgentManager(before);
    const id = manager.spawn(pi, ctxOf("/a.jsonl"), "general-purpose", "x", { description: "x", isBackground: true });
    manager.setObservers({ onComplete: after });
    settle[0]();
    await manager.getRecord(id)!.promise;
    expect(before).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith(expect.objectContaining({ id, status: "completed" }));
  });

  it("starts new runs with the services an adopting instance hands it", async () => {
    controllableRuns();
    const adopterRun = vi.fn(async () => ({ responseText: "adopted", session: { dispose: vi.fn() }, aborted: false, steered: false }));
    manager = new AgentManager();
    manager.useServices({ ...managerServices(), runAgent: adopterRun as any });
    const id = manager.spawn(pi, ctxOf("/a.jsonl"), "general-purpose", "x", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;
    expect(adopterRun).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
