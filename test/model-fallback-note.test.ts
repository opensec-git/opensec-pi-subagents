/**
 * model-fallback-note.test.ts — an agent file whose `model:` does not resolve
 * (missing, or matching several models) no longer runs silently on the
 * parent's model: the run keeps going, and every result surface says what was
 * asked for, why it was not used, and what ran instead. A caller's own model
 * that is ambiguous is refused with the candidates.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

// Sonnet from two providers, and a parent on a third: the cross-provider case
// that must not be settled by a guess.
const MODELS = [
  { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { provider: "openrouter", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
];
const PARENT = MODELS[0];
const NOTE =
  'Note: model "sonnet" from the agent file is ambiguous (candidates: anthropic/claude-sonnet-4-6, '
  + "openrouter/claude-sonnet-4-6); ran on deepseek/deepseek-chat instead.";

let booted: BootedPi | undefined;
let hermetic: Hermetic | undefined;

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.mocked(runAgent).mockReset();
  vi.useRealTimers();
});

async function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({
    settings: { outputTranscript: false, schedulingEnabled: false, ...settings },
    agentFiles: { pinned: "---\ndescription: pins sonnet\nmodel: sonnet\n---\n\nPinned.\n" },
  });
  booted = makePi();
  subagentsExtension(booted.pi);
  const parentCtx = ctx({
    model: PARENT,
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id)),
      getAvailable: vi.fn(() => MODELS),
      getAll: vi.fn(() => MODELS),
    },
  });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parentCtx };
}

function runs() {
  vi.mocked(runAgent).mockImplementation(async () => ({
    responseText: "ANSWER", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false,
  }));
}

const call = (b: BootedPi & { parentCtx: any }, extra: Record<string, unknown>) =>
  b.tools.get("Agent").execute(
    "tc",
    { prompt: "Do it.", description: "do it", subagent_type: "pinned", ...extra },
    undefined, undefined, b.parentCtx,
  );

describe("an agent file model that does not resolve", () => {
  it("resolves a short name to the parent provider's model when that provider serves it", async () => {
    const b = await boot();
    b.parentCtx.model = MODELS[1]; // an anthropic parent
    runs();

    const res = await call(b, { run_in_background: false });

    expect(vi.mocked(runAgent).mock.calls[0][3].model).toBe(MODELS[1]);
    expect(textOf(res)).not.toContain("Note: model");
  });

  it("runs on the parent's model, and the foreground result and get_subagent_result say so", async () => {
    const b = await boot();
    runs();

    const res = await call(b, { run_in_background: false });

    expect(vi.mocked(runAgent).mock.calls[0][3].model).toBe(PARENT);
    expect(res.isError).toBeUndefined();
    expect(textOf(res).startsWith(`${NOTE}\n\nAgent completed in`)).toBe(true);
    const read = await b.tools.get("get_subagent_result").execute("r", { agent_id: res.details.agentId }, undefined, undefined, b.parentCtx);
    expect(textOf(read)).toContain(`\n${NOTE}\n`);
  });

  it("is noted in the background spawn result and the completion notification", async () => {
    vi.useFakeTimers();
    const b = await boot();
    runs();

    const res = await call(b, { run_in_background: true });
    expect(textOf(res).startsWith(`${NOTE}\n\nAgent started in background.`)).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    const content = b.pi.sendMessage.mock.calls[0][0].content as string;
    expect(content).toContain(`<model-note>${NOTE}</model-note>`);
  });

  it("refuses an ambiguous model the caller named, with the candidates", async () => {
    const b = await boot({ allowModelOverride: true });
    runs();

    const res = await b.tools.get("Agent").execute(
      "tc",
      { prompt: "Do it.", description: "do it", subagent_type: "general-purpose", model: "sonnet", run_in_background: false },
      undefined, undefined, b.parentCtx,
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Model "sonnet" is ambiguous');
    expect(textOf(res)).toContain("anthropic/claude-sonnet-4-6, openrouter/claude-sonnet-4-6");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
