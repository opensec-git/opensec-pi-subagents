/**
 * Lifecycle wiring in the real extension (src/index.ts), with a mocked runner:
 * a stopped agent's partial result is waited for, and RPC spawns notify.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx as baseCtx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const session = () => ({ dispose: vi.fn(), steer: vi.fn(async () => {}) } as any);
const done = (text = "done") => ({ responseText: text, session: session(), aborted: false, steered: false });
const notifications = (pi: any): any[] =>
  pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "subagent-notification");

let hermetic: Hermetic | undefined;
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(runAgent).mockReset();
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

describe("RPC spawns", () => {
  it("one that omits isBackground notifies the parent when it finishes", async () => {
    const b = boot();
    vi.mocked(runAgent).mockResolvedValue(done("rpc result") as any);
    await b.lifecycle.get("session_start")({ type: "session_start" }, baseCtx());
    const registry = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const id = registry.spawn(b.pi, baseCtx(), "general-purpose", "x", { description: "rpc" });
    await registry.getRecord(id).promise;
    await new Promise(r => setTimeout(r, 400)); // past the notification hold
    expect(notifications(b.pi)).toHaveLength(1);
    expect(String(notifications(b.pi)[0][0].content)).toContain("rpc result");
  });
});

describe("get_subagent_result on a stopped agent that is still winding down", () => {
  it("waits for its partial result instead of reporting 'No output.'", async () => {
    const b = boot();
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, o: any) => {
      o.onSessionCreated?.(session());
      await new Promise<void>(r => o.signal.addEventListener("abort", () => setTimeout(r, 150), { once: true }));
      return done("partial findings") as any;
    });
    await b.lifecycle.get("session_start")({ type: "session_start" }, baseCtx());
    const started = await b.tools.get("Agent").execute("tc-1", {
      prompt: "x", description: "bg", subagent_type: "general-purpose", run_in_background: true,
    }, undefined, undefined, baseCtx());
    const id = /Agent ID: (\S+)/.exec(textOf(started))![1];
    const registry = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = registry.getRecord(id);
    await flush();
    // What manager.abort() does to the record the instant a stop lands.
    record.abortController.abort();
    record.status = "stopped";

    const result = await b.tools.get("get_subagent_result").execute("tc-2", { agent_id: id, wait: true }, undefined, undefined, baseCtx());
    expect(textOf(result)).toContain("partial findings");
    expect(record.resultConsumed).toBe(true);
  });
});

