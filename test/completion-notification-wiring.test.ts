import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ReturnType<typeof makeHeadlessCtx>,
  ) => Promise<unknown>;
}

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (...args: never[]) => unknown>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as never,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as never;
}

function completedRun() {
  return {
    responseText: "done",
    session: { dispose: vi.fn() },
    aborted: false,
    steered: false,
  } as Awaited<ReturnType<typeof runAgent>>;
}

async function spawnBackground(
  tool: RegisteredTool,
  toolCallId: string,
  description: string,
): Promise<void> {
  await tool.execute(
    toolCallId,
    {
      prompt: "reply done",
      description,
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    makeHeadlessCtx(),
  );
}

describe("background completion notification wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("requests steering for an individual completion after the result-consumption hold", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);

    await spawnBackground(tools.get("Agent")!, "individual-call", "individual child");
    await vi.advanceTimersByTimeAsync(200); // result-consumption hold

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("individual child"),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.();
  });

  it("sends completions that land together as one steering message, not a message each", async () => {
    vi.useFakeTimers();
    // Both runs settle after their spawns return, as real runs do.
    let settleRuns!: () => void;
    const runsSettled = new Promise<void>((resolve) => { settleRuns = resolve; });
    vi.mocked(runAgent).mockImplementation(async () => {
      await runsSettled;
      return completedRun();
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const agentTool = tools.get("Agent")!;

    await Promise.all([
      spawnBackground(agentTool, "batch-call-1", "first batched child"),
      spawnBackground(agentTool, "batch-call-2", "second batched child"),
    ]);
    settleRuns();
    await vi.advanceTimersByTimeAsync(200); // result-consumption hold

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("2 background tasks finished"),
        details: expect.objectContaining({
          description: "first batched child",
          others: [expect.objectContaining({ description: "second batched child" })],
        }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.();
  });

  it("delivers runs that settle while their Agent calls start up exactly once", async () => {
    vi.useFakeTimers();
    // Settled before the tool's awaitStartup continues — the spawn-time batch
    // used to notify each alone, then again in their group.
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const agentTool = tools.get("Agent")!;

    await Promise.all([
      spawnBackground(agentTool, "instant-call-1", "first instant child"),
      spawnBackground(agentTool, "instant-call-2", "second instant child"),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    await handlers.get("session_shutdown")?.();
  });
});
