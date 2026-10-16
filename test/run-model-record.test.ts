/**
 * run-model-record.test.ts — the record keeps the model and thinking level each
 * run actually ran with, and the result surfaces show it: the foreground
 * result's stats, get_subagent_result's header, and the completion
 * notification. A resumed run records its own.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

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
  vi.useRealTimers();
});

async function boot() {
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false } });
  booted = makePi();
  subagentsExtension(booted.pi);
  const parentCtx = ctx();
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parentCtx };
}

/** The child session as pi resolved it: its own model and clamped level. */
function childSession() {
  return {
    model: { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    thinkingLevel: "low",
    messages: [] as unknown[],
    dispose: vi.fn(),
  } as any;
}

function runsOn(session: any, text = "ANSWER") {
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
    opts.onSessionCreated?.(session);
    return { responseText: text, session, aborted: false, steered: false };
  });
}

const call = (b: BootedPi, parentCtx: any, extra: Record<string, unknown>) =>
  b.tools.get("Agent").execute(
    "tc",
    { prompt: "Do it.", description: "do it", subagent_type: "general-purpose", ...extra },
    undefined, undefined, parentCtx,
  );

describe("the model a run used", () => {
  it("is in the foreground result's stats and in get_subagent_result's header", async () => {
    const b = await boot();
    runsOn(childSession());

    const res = await call(b, b.parentCtx, { run_in_background: false });
    expect(textOf(res)).toMatch(/^Agent completed in .*anthropic\/claude-haiku-4-5, thinking: low\)/);

    const read = await b.tools.get("get_subagent_result").execute("r", { agent_id: res.details.agentId }, undefined, undefined, b.parentCtx);
    expect(textOf(read)).toContain("\nModel: anthropic/claude-haiku-4-5, thinking: low\n");
  });

  it("is in the completion notification", async () => {
    vi.useFakeTimers();
    const b = await boot();
    runsOn(childSession());

    await call(b, b.parentCtx, { run_in_background: true });
    await vi.advanceTimersByTimeAsync(1_000);

    const content = b.pi.sendMessage.mock.calls[0][0].content as string;
    expect(content).toContain("<model>anthropic/claude-haiku-4-5</model>");
    expect(content).toContain("<thinking>low</thinking>");
  });

  it("is recorded again by a resumed run", async () => {
    const b = await boot();
    const session = childSession();
    runsOn(session);
    const first = await call(b, b.parentCtx, { run_in_background: false });
    const id = first.details.agentId;

    // The session's model changed between runs (e.g. a /model inside it).
    session.model = { provider: "openai", id: "gpt-5", name: "GPT-5" };
    session.thinkingLevel = "high";
    vi.mocked(resumeAgent).mockResolvedValue({ text: "SECOND" });

    const resumed = await call(b, b.parentCtx, { resume: id, run_in_background: false });
    expect(textOf(resumed)).toContain("SECOND");

    const read = await b.tools.get("get_subagent_result").execute("r", { agent_id: id }, undefined, undefined, b.parentCtx);
    expect(textOf(read)).toContain("\nModel: openai/gpt-5, thinking: high\n");
  });
});
