/**
 * resume-reopen.test.ts — resuming an agent whose record was evicted: the
 * manager reopens its session file under the same id, with what it ran with.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, resumeStateOf } from "../src/agent-manager.js";
import type { AgentResumeState } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  restoreWorktree: vi.fn(async () => undefined),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { runAgent } from "../src/agent-runner.js";
import { restoreWorktree } from "../src/worktree.js";

const mockPi = {} as any;
let dir: string;
let manager: AgentManager;

const haiku = { provider: "anthropic", id: "claude-haiku", name: "Claude Haiku" };
function ctx(cwd = dir) {
  return {
    cwd,
    model: { provider: "anthropic", id: "parent-model" },
    modelRegistry: { find: vi.fn((p: string, id: string) => (p === haiku.provider && id === haiku.id ? haiku : undefined)) },
  } as any;
}

/** A session file Pi can open: a header line and one message. */
function sessionFile(name = "agent.jsonl", content?: string) {
  const path = join(dir, name);
  writeFileSync(path, content ?? `${JSON.stringify({ type: "session", version: 3, id: "0b9f3c1e-2a4d-4c8e-9f10-1a2b3c4d5e6f", timestamp: new Date(0).toISOString(), cwd: dir })}\n`);
  return path;
}

function state(overrides: Partial<AgentResumeState> = {}): AgentResumeState {
  return {
    id: "agent-1",
    type: "Explore",
    description: "audit",
    sessionFile: sessionFile(),
    completedAt: 1,
    handle: "explore",
    model: "anthropic/claude-haiku",
    isolated: true,
    maxTurns: 4,
    baseCwd: dir,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resume-reopen-"));
  manager = new AgentManager();
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockResolvedValue({ responseText: "reopened", session: { dispose: vi.fn() }, aborted: false, steered: false } as any);
});

afterEach(async () => {
  await manager.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("AgentManager.resume of an evicted agent", () => {
  it("reopens its session file under the same id, with its own model, isolation and turn limit", async () => {
    manager.restoreTombstones([state()]);

    const record = await manager.resume("agent-1", "continue", undefined, { ctx: ctx(), pi: mockPi });

    expect(record?.id).toBe("agent-1");
    expect(record?.handle).toBe("explore");
    expect(record?.result).toBe("reopened");
    const [, type, prompt, opts] = vi.mocked(runAgent).mock.calls[0] as any[];
    expect(type).toBe("Explore");
    expect(prompt).toBe("continue");
    expect(opts).toMatchObject({
      agentId: "agent-1",
      resumeSessionFile: join(dir, "agent.jsonl"),
      model: haiku,
      isolated: true,
      maxTurns: 4,
    });
  });

  it("keeps the directory it ran in when the parent session is elsewhere", async () => {
    const other = mkdtempSync(join(tmpdir(), "resume-reopen-other-"));
    try {
      manager.restoreTombstones([state({ baseCwd: other })]);
      await manager.resume("agent-1", "continue", undefined, { ctx: ctx(), pi: mockPi });
      expect((vi.mocked(runAgent).mock.calls[0] as any[])[3].cwd).toBe(other);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("falls back to the default model when the saved one is not available here", async () => {
    manager.restoreTombstones([state({ model: "gone/model" })]);
    await manager.resume("agent-1", "continue", undefined, { ctx: ctx(), pi: mockPi });
    expect((vi.mocked(runAgent).mock.calls[0] as any[])[3].model).toBeUndefined();
  });

  it("restores a worktree agent's worktree from its branch", async () => {
    const worktree = { path: join(dir, "wt"), branch: "pi-agent-agent-1", baseSha: "abc", workPath: join(dir, "wt") };
    const prior = { hasChanges: true, branch: "pi-agent-agent-1", path: join(dir, "wt") };
    manager.restoreTombstones([state({ worktree, worktreeResult: prior })]);

    await manager.resume("agent-1", "continue", undefined, { ctx: ctx(), pi: mockPi });

    expect(restoreWorktree).toHaveBeenCalledWith(mockPi, dir, expect.objectContaining({ path: worktree.path }), prior);
    expect((vi.mocked(runAgent).mock.calls[0] as any[])[3].cwd).toBe(worktree.path);
  });

  it("runs in the background and returns at once when asked", async () => {
    manager.restoreTombstones([state()]);
    const onRecord = vi.fn();
    const record = await manager.resume("agent-1", "continue", undefined, { ctx: ctx(), pi: mockPi, isBackground: true, onRecord });
    expect(record?.isBackground).toBe(true);
    expect(onRecord).toHaveBeenCalledWith(record);
    await record?.promise;
    expect(record?.status).toBe("completed");
  });

  it("cannot reopen without a session context", async () => {
    manager.restoreTombstones([state()]);
    await expect(manager.resume("agent-1", "continue")).rejects.toThrow(/cannot be reopened from here/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses a corrupt or empty session file before running anything", async () => {
    manager.restoreTombstones([state({ sessionFile: sessionFile("bad.jsonl", "not json\n") })]);
    await expect(manager.resume("agent-1", "go", undefined, { ctx: ctx(), pi: mockPi })).rejects.toThrow(/cannot be read/);

    manager.restoreTombstones([state({ completedAt: 2, sessionFile: sessionFile("empty.jsonl", "") })]);
    await expect(manager.resume("agent-1", "go", undefined, { ctx: ctx(), pi: mockPi })).rejects.toThrow(/is empty/);
    expect(runAgent).not.toHaveBeenCalled();
    // Still there: the file may be repaired.
    expect(manager.findTombstone("agent-1")).toBeDefined();
  });

  it("forgets an agent whose session file is gone", async () => {
    manager.restoreTombstones([state({ sessionFile: join(dir, "missing.jsonl") })]);
    await expect(manager.resume("agent-1", "go", undefined, { ctx: ctx(), pi: mockPi })).rejects.toThrow(/is gone/);
    expect(manager.findTombstone("agent-1")).toBeUndefined();
  });

  it("refuses when the caller's type check does", async () => {
    manager.restoreTombstones([state()]);
    await expect(manager.resume("agent-1", "go", undefined, {
      ctx: ctx(), pi: mockPi, checkType: () => "the Explore agent is no longer available.",
    })).rejects.toThrow(/no longer available/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("reopens a nested child under its owner", async () => {
    manager.restoreTombstones([state({ handle: undefined, parentAgentId: "parent-9", depth: 2 })]);
    const record = await manager.resume("agent-1", "go", undefined, { ctx: ctx(), pi: mockPi });
    expect(record?.parentAgentId).toBe("parent-9");
    expect(record?.handle).toBeUndefined();
    expect(manager.listTombstones()).toHaveLength(0); // nested: not addressable by @handle
  });
});

describe("resumeStateOf", () => {
  it("captures what a reopen needs from a record", async () => {
    const id = manager.spawn(mockPi, ctx(), "Explore", "go", { description: "d", isolated: true, isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.sessionFile = join(dir, "s.jsonl");
    record.invocation = { modelId: "anthropic/claude-haiku" };

    expect(resumeStateOf(record)).toMatchObject({
      id, type: "Explore", sessionFile: join(dir, "s.jsonl"), model: "anthropic/claude-haiku",
      isolated: true, baseCwd: dir, maxTurns: 0, handle: "explore",
    });
  });
});
