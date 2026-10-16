/**
 * notification-preview.test.ts — a completion notification carries the first
 * lines of the result, capped in characters, the full result's size, and a
 * note saying how much was left out and where it is.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension, { previewResult } from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("previewResult", () => {
  it("returns a short result whole", () => {
    expect(previewResult(lines(10), 500, 10)).toBe(lines(10));
  });

  it("keeps the first lines and says how many lines and bytes were left out", () => {
    const result = lines(30);
    const preview = previewResult(result, 500, 10);
    expect(preview.startsWith(`${lines(10)}\n...(truncated: 20 of 30 lines and `)).toBe(true);
    const shownBytes = Buffer.byteLength(lines(10));
    const total = Buffer.byteLength(result);
    expect(preview).toContain(`${total - shownBytes} of ${total} bytes not shown; use get_subagent_result for the full output)`);
    expect(preview).not.toContain("line 11");
  });

  it("caps one huge line by characters, counting it as not shown", () => {
    const result = `${"x".repeat(5000)}\nsecond`;
    const preview = previewResult(result, 500, 10);
    expect(preview.split("\n")[0]).toHaveLength(500);
    expect(preview).toContain("truncated: 2 of 2 lines");
  });

  it("counts bytes, not characters", () => {
    const result = `${"é".repeat(20)}\n${lines(20)}`;
    const preview = previewResult(result, 500, 1);
    const total = Buffer.byteLength(result);
    expect(preview).toContain(`${total - 40} of ${total} bytes`);
  });
});

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
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, ...settings } });
  booted = makePi();
  subagentsExtension(booted.pi);
  const parent = { running: true };
  const signal = new AbortController().signal;
  const parentCtx = ctx();
  Object.defineProperty(parentCtx, "signal", { get: () => (parent.running ? signal : undefined) });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parentCtx };
}

/** Every run answers with 30 lines named after its prompt. */
function thirtyLineRuns() {
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, prompt: any) => ({
    responseText: lines(30, prompt), session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false,
  }));
}

const spawn = (b: BootedPi, parentCtx: any, prompt: string) =>
  b.tools.get("Agent").execute(
    `call-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose", run_in_background: true },
    undefined, undefined, parentCtx,
  );

const turnEnd = (b: BootedPi) =>
  b.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" } });

const sentContents = (b: BootedPi): string[] => b.pi.sendMessage.mock.calls.map((c: any[]) => c[0].content);

describe("completion notifications preview by lines", () => {
  it("an individual notification carries 10 lines, the size, and the truncation note", async () => {
    vi.useFakeTimers();
    thirtyLineRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    const [content] = sentContents(b);
    expect(content).toContain("alpha 10\n...(truncated: 20 of 30 lines");
    expect(content).not.toContain("alpha 11");
    expect(content).toContain(`<result_bytes>${Buffer.byteLength(lines(30, "alpha"))}</result_bytes>`);
  });

  it("the group notification previews each member the same way", async () => {
    vi.useFakeTimers();
    thirtyLineRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await Promise.all([spawn(b, b.parentCtx, "one"), spawn(b, b.parentCtx, "two")]);
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    const [content] = sentContents(b);
    expect(content).toMatch(/^Background agent group completed: 2 agent\(s\) finished/);
    for (const name of ["one", "two"]) {
      expect(content).toContain(`${name} 10\n...(truncated: 20 of 30 lines`);
      expect(content).not.toContain(`${name} 11`);
      expect(content).toContain(`<result_bytes>${Buffer.byteLength(lines(30, name))}</result_bytes>`);
    }
  });
});
