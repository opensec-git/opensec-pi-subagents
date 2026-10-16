/**
 * Releasing a finished agent's session.
 *
 * A finished child's session held everything its extensions armed in
 * `session_start` until the record was evicted ten minutes later, per agent. A
 * saved session is now shut down and disposed shortly after its run settles;
 * its messages stay readable, and a resume reopens it from the session file
 * with the agent's lifetime figures intact.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const pi = {} as any;
const ctx = { cwd: "/tmp", modelRegistry: { find: () => undefined } } as any;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function liveSession(file: string | undefined) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: "kept" }] }],
    dispose: vi.fn(),
    steer: vi.fn(async () => {}),
    isStreaming: false,
    sessionManager: { getSessionFile: () => file },
    extensionRunner: { hasHandlers: () => true, emit: vi.fn(async () => {}) },
  } as any;
}

describe("finished sessions are released", () => {
  let m: AgentManager | undefined;
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-release-"));
    file = join(dir, "s.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "0b9f3c1e-2a4d-4c8e-9f10-1a2b3c4d5e6f", timestamp: new Date(0).toISOString(), cwd: dir })}\n`);
  });
  afterEach(async () => {
    await m?.dispose();
    m = undefined;
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a saved session is shut down and disposed after its run settles, and stays readable", async () => {
    const session = liveSession(file);
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      o.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });
    m = new AgentManager(undefined, 5);
    m.setSessionReleaseMs(0);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "A", isBackground: true });
    await m.getRecord(id)!.promise;
    await sleep(10);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "session_shutdown" }));
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(m.getRecord(id)!.session?.messages).toHaveLength(1); // the viewer still has the transcript

    // Evicting the record later does not shut the session down a second time.
    m.getRecord(id)!.completedAt = Date.now() - 11 * 60_000;
    (m as any).cleanup();
    await sleep(10);
    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("an in-memory session is kept: it is the only copy of the conversation", async () => {
    const session = liveSession(undefined);
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      o.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });
    m = new AgentManager(undefined, 5);
    m.setSessionReleaseMs(0);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "A", isBackground: true });
    await m.getRecord(id)!.promise;
    await sleep(10);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("a resume after the release reopens the file, and the lifetime figures continue", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      const session = liveSession(file);
      o.onSessionCreated?.(session);
      o.onAssistantUsage?.({ input: 10, output: o.resumeSessionFile ? 50 : 100, cacheWrite: 0, cost: 0 });
      o.onToolActivity?.({ type: "end", toolName: "read" });
      return { responseText: o.resumeSessionFile ? "second" : "first", session, aborted: false, steered: false } as any;
    });
    m = new AgentManager(undefined, 5);
    m.setSessionReleaseMs(0);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "A", isBackground: true });
    await m.getRecord(id)!.promise;
    await sleep(10);

    const resumed = await m.resume(id, "more", undefined, { pi, ctx });
    expect(resumeAgent).not.toHaveBeenCalled(); // not prompted on the disposed session
    expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3]).toMatchObject({ resumeSessionFile: file });
    expect(resumed?.id).toBe(id);
    expect(resumed?.result).toBe("second");
    expect(resumed?.lifetimeUsage.output).toBe(150);
    expect(resumed?.toolUses).toBe(2);
  });

  it("a resume within the delay reuses the live session", async () => {
    const session = liveSession(file);
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      o.onSessionCreated?.(session);
      return { responseText: "first", session, aborted: false, steered: false } as any;
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });
    m = new AgentManager(undefined, 5);
    m.setSessionReleaseMs(60_000);
    const id = m.spawn(pi, ctx, "general-purpose", "x", { description: "A", isBackground: true });
    await m.getRecord(id)!.promise;
    const resumed = await m.resume(id, "more", undefined, { pi, ctx });
    expect(resumed?.result).toBe("second");
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(session.dispose).not.toHaveBeenCalled();
  });
});
