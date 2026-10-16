/**
 * Subagent spend that no tool result carries back still reaches the parent's
 * session stats (src/index.ts, mocked runner).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { runMentionClone } from "../src/mention-clone.js";
import { ctx as baseCtx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const session = () => ({ dispose: vi.fn(), steer: vi.fn(async () => {}) } as any);
const done = (text = "done") => ({ responseText: text, session: session(), aborted: false, steered: false });

let hermetic: Hermetic | undefined;
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(runAgent).mockReset();
  vi.mocked(runMentionClone).mockReset();
  delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  hermetic?.restore();
  hermetic = undefined;
});

function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const booted = makePi();
  subagentsExtension(booted.pi);
  return booted;
}

describe("subagent spend no tool result carries back", () => {
  const usage = { input: 100, output: 50, cacheWrite: 0, cacheRead: 0, cost: 0.01 };

  it("reaches the parent's session stats when a background agent finishes while the parent is idle", async () => {
    const b = boot({ reportUsage: true });
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      await new Promise(r => setTimeout(r, 20));
      o.onAssistantUsage?.(usage);
      return done() as any;
    });
    const appendUsage = vi.fn();
    const c = baseCtx({ isIdle: () => true, sessionManager: { getSessionId: () => "s1", getBranch: () => [], appendUsage } });
    await b.lifecycle.get("session_start")({ type: "session_start" }, c);
    const started = await b.tools.get("Agent").execute("tc-1", {
      prompt: "x", description: "bg", subagent_type: "general-purpose", run_in_background: true,
    }, undefined, undefined, c);
    const id = /Agent ID: (\S+)/.exec(textOf(started))![1];
    await (globalThis as Record<symbol, any>)[MANAGER_KEY].getRecord(id).promise;
    expect(appendUsage).toHaveBeenCalledTimes(1);
    expect(appendUsage.mock.calls[0][3]).toMatchObject({ input: 100, output: 50 });
  });

  it("is flushed at the end of the parent's turn when it landed mid-turn", async () => {
    const b = boot({ reportUsage: true });
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      // After the Agent tool returned: no tool result is left to carry it.
      await new Promise(r => setTimeout(r, 20));
      o.onAssistantUsage?.(usage);
      return done() as any;
    });
    const appendUsage = vi.fn();
    const sessionManager = { getSessionId: () => "s1", getBranch: () => [], appendUsage };
    const busy = baseCtx({ isIdle: () => false, sessionManager });
    await b.lifecycle.get("session_start")({ type: "session_start" }, busy);
    const started = await b.tools.get("Agent").execute("tc-1", {
      prompt: "x", description: "bg", subagent_type: "general-purpose", run_in_background: true,
    }, undefined, undefined, busy);
    const id = /Agent ID: (\S+)/.exec(textOf(started))![1];
    await (globalThis as Record<symbol, any>)[MANAGER_KEY].getRecord(id).promise;
    expect(appendUsage).not.toHaveBeenCalled();
    await b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] }, baseCtx({ sessionManager }));
    expect(appendUsage).toHaveBeenCalledTimes(1);
    // Drained: nothing is counted twice.
    await b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] }, baseCtx({ sessionManager }));
    expect(appendUsage).toHaveBeenCalledTimes(1);
  });

  it("includes the @mention clone's own turn", async () => {
    const b = boot({ reportUsage: true });
    vi.mocked(runMentionClone).mockImplementation(async (opts: any) => {
      opts.onUsage?.(usage);
      return { spawned: true };
    });
    const appendUsage = vi.fn();
    const c = baseCtx({ isIdle: () => true, sessionManager: { getSessionId: () => "s1", getBranch: () => [], appendUsage } });
    await b.lifecycle.get("session_start")({ type: "session_start" }, c);
    await b.lifecycle.get("input")({ type: "input", text: "@Explore look around", source: "interactive" }, c);
    await flush();
    expect(appendUsage).toHaveBeenCalledTimes(1);
    expect(appendUsage.mock.calls[0][3]).toMatchObject({ input: 100, output: 50 });
  });
});
