/**
 * 0.20.7: why an agent stopped. An agent the parent session's end interrupted
 * (`stopCause: "session-end"`) is not reported as stopped by the user, and the
 * texts the parent reads say a stopped or failed agent is resumed, not replaced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager, resumeStateOf } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { getForegroundOutcomeNote, getStatusNote, resumeHintXml } from "../src/status-note.js";
import type { AgentRecord } from "../src/types.js";

const pi = {} as any;
const ctx = { cwd: "/tmp" } as any;

/** A run that ends (as stopped runs do) when its signal aborts, with a session saved to `file`. */
function runUntilAborted(file = "/tmp/agent.jsonl") {
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => new Promise((resolve) => {
    const session = { dispose: vi.fn(), sessionManager: { getSessionFile: () => file } } as any;
    opts.onSessionCreated?.(session);
    opts.signal?.addEventListener("abort", () => resolve({ responseText: "partial", session, aborted: false, steered: false } as any));
  }) as any);
}

let manager: AgentManager | undefined;
afterEach(() => {
  manager?.dispose();
  manager = undefined;
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

describe("status notes", () => {
  it("say a session-end stop was an interruption, not the user's stop", () => {
    expect(getStatusNote("stopped")).toContain("STOPPED BY THE USER");
    expect(getStatusNote("stopped", "user")).toContain("STOPPED BY THE USER");
    const interrupted = getStatusNote("stopped", "session-end");
    expect(interrupted).toContain("INTERRUPTED when the parent session ended, not stopped by anyone");
    expect(interrupted).toContain("can be resumed");
    expect(interrupted).not.toContain("USER");
    expect(getForegroundOutcomeNote("stopped", "session-end")).toContain("interrupted when the session ended");
    expect(getForegroundOutcomeNote("stopped")).toContain("STOPPED BY THE USER");
    // Other statuses ignore the cause.
    expect(getStatusNote("aborted", "session-end")).toBe(getStatusNote("aborted"));
  });

  it("a background notification's resume hint names the id, only for unfinished runs with a saved session", () => {
    const base = { id: "a1", sessionFile: "/s.jsonl" };
    for (const status of ["error", "stopped", "aborted"] as const) {
      expect(resumeHintXml({ ...base, status })).toBe(
        "<resume>It keeps its context: pass a1 as `resume` to continue this agent instead of starting a fresh one.</resume>",
      );
    }
    expect(resumeHintXml({ ...base, status: "completed" })).toBeNull();
    expect(resumeHintXml({ ...base, status: "steered" })).toBeNull();
    expect(resumeHintXml({ id: "a1", status: "stopped", sessionFile: undefined })).toBeNull();
  });
});

describe("AgentManager stop causes", () => {
  it("a plain abort is the user's stop (no cause); a session-end abort records it", () => {
    runUntilAborted();
    manager = new AgentManager();
    const user = manager.spawn(pi, ctx, "general-purpose", "a", { description: "a", isBackground: true });
    const ended = manager.spawn(pi, ctx, "general-purpose", "b", { description: "b", isBackground: true });
    manager.abort(user);
    manager.abort(ended, "session-end");
    expect(manager.getRecord(user)!.stopCause).toBeUndefined();
    expect(manager.getRecord(ended)).toMatchObject({ status: "stopped", stopCause: "session-end" });
  });

  it("abortAll passes the cause to running and queued agents", () => {
    runUntilAborted();
    manager = new AgentManager(undefined, 1);
    const running = manager.spawn(pi, ctx, "general-purpose", "a", { description: "a", isBackground: true });
    const queued = manager.spawn(pi, ctx, "general-purpose", "b", { description: "b", isBackground: true });
    expect(manager.getRecord(queued)!.status).toBe("queued");
    expect(manager.abortAll("session-end")).toBe(2);
    expect(manager.getRecord(running)!.stopCause).toBe("session-end");
    expect(manager.getRecord(queued)).toMatchObject({ status: "stopped", stopCause: "session-end" });
  });

  it("an interrupted parent passes the cause on to the children it owns", async () => {
    runUntilAborted();
    manager = new AgentManager();
    const parent = manager.spawn(pi, ctx, "general-purpose", "p", { description: "p", isBackground: true });
    const child = manager.spawn(pi, ctx, "scout", "c", { description: "c", isBackground: true, depth: 2, parentAgentId: parent });
    manager.abort(parent, "session-end");
    await manager.getRecord(parent)!.promise;
    expect(manager.getRecord(child)).toMatchObject({ status: "stopped", stopCause: "session-end" });
  });

  it("the cause reaches the resume state of a stopped agent only", async () => {
    runUntilAborted("/tmp/x.jsonl");
    manager = new AgentManager();
    const id = manager.spawn(pi, ctx, "general-purpose", "a", { description: "a", isBackground: true });
    manager.abort(id, "session-end");
    await manager.getRecord(id)!.promise;
    const record = manager.getRecord(id)!;
    expect(resumeStateOf(record)).toMatchObject({ status: "stopped", stopCause: "session-end" });
    expect(resumeStateOf({ ...record, status: "completed" } as AgentRecord)?.stopCause).toBeUndefined();
  });

  it("a resume clears the cause, foreground and background", async () => {
    runUntilAborted();
    manager = new AgentManager();
    vi.mocked(resumeAgent).mockResolvedValue({ text: "finished" } as any);
    for (const isBackground of [false, true]) {
      const id = manager.spawn(pi, ctx, "general-purpose", "a", { description: "a", isBackground: true });
      manager.abort(id, "session-end");
      await manager.getRecord(id)!.promise;
      const resumed = await manager.resume(id, "go on", undefined, { isBackground });
      expect(resumed!.stopCause).toBeUndefined();
      await resumed!.promise;
      expect(manager.getRecord(id)).toMatchObject({ status: "completed", result: "finished" });
      expect(manager.getRecord(id)!.stopCause).toBeUndefined();
    }
  });
});
