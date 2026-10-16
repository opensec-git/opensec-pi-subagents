/**
 * When completion notifications reach the parent, through the real extension:
 * held while the parent runs and sent at its turn's end, as in Claude Code, and
 * — in `group` join mode — batched by the turn that spawned them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";
import type * as WorktreeModule from "../src/worktree.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof WorktreeModule>("../src/worktree.js");
  return {
    ...actual,
    createWorktree: vi.fn(),
    cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
    isWorktreeIsolationEnabled: vi.fn(() => true),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { createWorktree } from "../src/worktree.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let booted: BootedPi | undefined;
let hermetic: Hermetic | undefined;

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  vi.mocked(createWorktree).mockReset();
  vi.useRealTimers();
});

/** Boot the extension with a parent whose run state the test controls. */
async function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, ...settings } });
  booted = makePi();
  subagentsExtension(booted.pi);
  const parent = { running: true };
  const signal = new AbortController().signal;
  const parentCtx = ctx();
  Object.defineProperty(parentCtx, "signal", { get: () => (parent.running ? signal : undefined) });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parent, parentCtx };
}

/** Runs that settle only when `settle(description)` is called. */
function controllableRuns() {
  const finishers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) =>
    new Promise<any>(resolve => {
      finishers.set(prompt, () => resolve({
        responseText: `${prompt} done`, session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false,
      }));
    }) as any,
  );
  vi.mocked(resumeAgent).mockImplementation((_s: any, prompt: string) =>
    new Promise(resolve => { finishers.set(prompt, () => resolve({ text: `${prompt} done` })); }),
  );
  return { settle: (prompt: string) => finishers.get(prompt)!() };
}

const spawn = (b: BootedPi, parentCtx: any, prompt: string, extra: Record<string, unknown> = {}) =>
  b.tools.get("Agent").execute(
    `call-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose", run_in_background: true, ...extra },
    undefined, undefined, parentCtx,
  );

const agentIdOf = (result: any): string => /Agent ID: (\S+)/.exec(result.content[0].text)![1];

const turnEnd = (b: BootedPi, stopReason = "toolUse") =>
  b.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason } });

const sentContents = (b: BootedPi): string[] => b.pi.sendMessage.mock.calls.map((c: any[]) => c[0].content);

describe("completion delivery to a running parent", () => {
  it("holds a completion until the parent's turn ends, then steers it in", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");

    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("alpha done") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("sends a completion that landed after the run's last turn once the run ends", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    turnEnd(b, "stop"); // the run's final turn: nothing pending yet

    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(200);

    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
  });

  it("sends a completion that landed while the ending run was still open, once the run settles", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    turnEnd(b, "stop");
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });

    runs.settle("alpha"); // lands while a later agent_end listener still holds the run open
    await vi.advanceTimersByTimeAsync(0);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ type: "agent_settled", aborted: false });
    await vi.advanceTimersByTimeAsync(200);

    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
  });

  it("drops what is still pending when the session shuts down", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    b.parent.running = false;
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await b.lifecycle.get("session_shutdown")();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("delivers an aborted turn's completion once the run ends, starting a turn, as Claude Code does after Esc", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b, "aborted");
    // Sent now, it would land in the queue pi clears on Esc.
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    b.parent.running = false;
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(200);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("alpha done") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });
  it("drops a completion whose result another extension consumed over RPC before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    const [, consume] = b.pi.events.on.mock.calls.find(([channel]: any[]) => channel === "subagents:rpc:consume");
    await consume({ requestId: "r1", agentId: id });
    turnEnd(b);

    expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:rpc:consume:reply:r1", expect.objectContaining({ success: true }));
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

// Fork lifecycle: a stop that lands while an agent is still queued completes
// like any other stop (0.20.1), so it rides the same boundary.
describe("completion delivery with the fork's lifecycle", () => {
  it("delivers an agent stopped while queued together with a sibling that finished, at the turn's end", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ maxConcurrent: 1 });
    await spawn(b, b.parentCtx, "alpha");
    const queuedId = agentIdOf(await spawn(b, b.parentCtx, "beta"));
    expect((globalThis as any)[MANAGER_KEY].getRecord(queuedId).status).toBe("queued");

    const [, stop] = b.pi.events.on.mock.calls.find(([channel]: any[]) => channel === "subagents:rpc:stop");
    await stop({ requestId: "s1", agentId: queuedId });
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [content] = sentContents(b);
    expect(content).toContain("2 background tasks finished.");
    expect(content).toContain("alpha done");
    expect(content).toContain(queuedId);
  });

  it("lets get_subagent_result suppress a completion long after it finished, while the parent is busy", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    // Far past the old 200 ms hold: the parent is still in its tool batch.
    await vi.advanceTimersByTimeAsync(60_000);

    const read = await b.tools.get("get_subagent_result").execute(
      "call-read", { agent_id: id }, undefined, undefined, b.parentCtx,
    );
    expect(read.content[0].text).toContain("alpha done");
    turnEnd(b);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("a completion pending while its agent is resumed", () => {
  const resume = (b: BootedPi, parentCtx: any, id: string, prompt: string, background: boolean) =>
    b.tools.get("Agent").execute(
      `call-${prompt}`,
      { prompt, description: prompt, subagent_type: "general-purpose", resume: id, run_in_background: background },
      undefined, undefined, parentCtx,
    );

  it("still reports the first run when a background resume starts before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await resume(b, b.parentCtx, id, "again", true);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);

    runs.settle("again");
    await vi.advanceTimersByTimeAsync(0);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done"), expect.stringContaining("again done")]);
  });

  it("still reports the first run, not the inline result, when a foreground resume runs before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    const inline = resume(b, b.parentCtx, id, "again", false);
    await vi.advanceTimersByTimeAsync(0);
    runs.settle("again");
    await inline;
    turnEnd(b);

    const sent = sentContents(b);
    expect(sent).toEqual([expect.stringContaining("alpha done")]);
    expect(sent[0]).not.toContain("again done");
  });

  it("does not report a run whose result was read before a background resume", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await b.tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, b.parentCtx);
    await resume(b, b.parentCtx, id, "again", true);
    turnEnd(b);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("`group` join mode — one notification per turn's batch", () => {
  /** A worktree copy that takes `ms`, or fails after it. */
  function worktreeAfter(ms: number, ok = true) {
    vi.mocked(createWorktree).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, ms));
      return ok ? { path: "/tmp/wt", branch: "b", baseSha: "s", workPath: "/tmp/wt" } as any : undefined;
    });
  }

  it("groups a turn's worktree spawns whose copies finish far apart", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    worktreeAfter(0);
    worktreeAfter(500);

    const calls = Promise.all([
      spawn(b, b.parentCtx, "fast-copy", { isolation: "worktree" }),
      spawn(b, b.parentCtx, "slow-copy", { isolation: "worktree" }),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    await calls;
    turnEnd(b);

    runs.settle("fast-copy");
    runs.settle("slow-copy");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.stringContaining("Background agent group completed: 2 agent(s) finished")]);
  });

  it("delivers a batch that finished before its turn ended, once, at that turn's end", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await Promise.all([spawn(b, b.parentCtx, "one"), spawn(b, b.parentCtx, "two")]);
    runs.settle("one");
    runs.settle("two");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);

    // The group alone — not each member again beside it.
    expect(sentContents(b)).toEqual([expect.stringMatching(/^Background agent group completed: 2 agent\(s\) finished/)]);
  });

  it("leaves out a member whose result was consumed before the group was sent", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    const [first] = await Promise.all([spawn(b, b.parentCtx, "read-early"), spawn(b, b.parentCtx, "unread")]);
    turnEnd(b);
    runs.settle("read-early");
    runs.settle("unread");
    await vi.advanceTimersByTimeAsync(0);

    await b.tools.get("get_subagent_result").execute(
      "read", { agent_id: agentIdOf(first) }, undefined, undefined, b.parentCtx,
    );
    turnEnd(b);

    const [content] = sentContents(b);
    expect(content).toContain("unread done");
    expect(content).not.toContain("read-early done");
  });

  it("reports a turn's lone spawn as a single completion, not a group of one", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await spawn(b, b.parentCtx, "solo");
    turnEnd(b);

    runs.settle("solo");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.not.stringMatching(/^Background agent group completed/)]);
    expect(sentContents(b)[0]).toContain("solo done");
  });

  it("reports a lone spawn that finished before its turn ended as a single completion", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await spawn(b, b.parentCtx, "solo");
    runs.settle("solo");
    await vi.advanceTimersByTimeAsync(1_000);

    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.not.stringMatching(/^Background agent group completed/)]);
    expect(sentContents(b)[0]).toContain("solo done");
  });

  it("delivers a spawn made outside a parent turn, which has no turn end to wait for", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    b.parent.running = false; // e.g. an `@handle` mention's off-screen spawn
    await spawn(b, b.parentCtx, "mentioned");

    runs.settle("mentioned");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sentContents(b)).toEqual([expect.stringContaining("mentioned done")]);
  });

  it("does not hold a sibling for a spawn whose worktree failed late", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    worktreeAfter(500, false);

    const calls = Promise.allSettled([
      spawn(b, b.parentCtx, "doomed", { isolation: "worktree" }),
      spawn(b, b.parentCtx, "sibling"),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    const [doomed] = await calls;
    expect(doomed.status).toBe("rejected");
    turnEnd(b);

    runs.settle("sibling");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.stringContaining("sibling done")]);
  });
});
