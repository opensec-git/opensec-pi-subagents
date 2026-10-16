/**
 * Session shutdown in the real extension (src/index.ts), with a mocked runner:
 * nothing may reach a torn-down session, and nothing may reject unhandled —
 * pi exits on that.
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
import { ctx as baseCtx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const session = () => ({ dispose: vi.fn(), steer: vi.fn(async () => {}) } as any);
const done = (text = "done") => ({ responseText: text, session: session(), aborted: false, steered: false });
const notifications = (pi: any): any[] =>
  pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "subagent-notification");

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

/** A ctx whose getters throw once the session is replaced, like pi's runner.assertActive(). */
function staleableCtx(overrides: Record<string, unknown> = {}) {
  const base = baseCtx(overrides);
  const state = { stale: false };
  const c: any = {};
  for (const key of Object.keys(base)) {
    Object.defineProperty(c, key, {
      get() {
        if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
        return base[key];
      },
    });
  }
  return { c, state };
}

describe("@mention (model mode) racing a session switch", () => {
  it("the fallback after the clone does not throw into a stale ctx, and the clone is aborted", async () => {
    const b = boot();
    let finishClone!: (r: any) => void;
    let cloneSignal: AbortSignal | undefined;
    vi.mocked(runMentionClone).mockImplementation((opts: any) => {
      cloneSignal = opts.signal;
      return new Promise(r => { finishClone = r; });
    });

    const { c, state } = staleableCtx();
    await b.lifecycle.get("session_start")({ type: "session_start" }, c);
    const res = await b.lifecycle.get("input")({ type: "input", text: "@Explore look around", source: "interactive" }, c);
    expect(res.action).toBe("handled");

    // /new (or /resume, /reload) while the clone's model turn is in flight.
    await b.lifecycle.get("session_shutdown")();
    state.stale = true;
    expect(cloneSignal?.aborted).toBe(true);

    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => { seen.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      finishClone({ spawned: false, error: "the conversation clone did not start it" });
      await new Promise(r => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled(); // no fallback spawn into the dead session
  });
});

describe("session shutdown", () => {
  it("clears a held group notification, so it never fires into the torn-down session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = boot({ defaultJoinMode: "smart" });
    vi.mocked(runAgent)
      .mockImplementationOnce(async () => done("first") as any)
      .mockImplementationOnce(() => new Promise(() => {}));
    await b.lifecycle.get("session_start")({ type: "session_start" }, baseCtx());
    const params = { prompt: "x", subagent_type: "general-purpose", run_in_background: true };
    await b.tools.get("Agent").execute("tc-a", { ...params, description: "a" }, undefined, undefined, baseCtx());
    await b.tools.get("Agent").execute("tc-b", { ...params, description: "b" }, undefined, undefined, baseCtx());
    await vi.advanceTimersByTimeAsync(150); // the batch forms a group; "a" is held in it

    await b.lifecycle.get("session_shutdown")();
    await vi.advanceTimersByTimeAsync(60_000); // past the group's 30 s partial-delivery timeout
    expect(notifications(b.pi)).toEqual([]);
  });
});

