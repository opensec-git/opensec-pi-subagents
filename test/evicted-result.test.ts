/**
 * evicted-result.test.ts — get_subagent_result for an agent whose record the
 * 10-minute cleanup released. The answer comes from the kept resume state
 * (status, model) and the agent's saved session file (the result), read on
 * demand; nothing is held in memory longer for it.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { RECORD_ENTRY_TYPE } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { readSavedResult } from "../src/session-file.js";
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
  vi.useRealTimers();
});

function assistant(text: string, extra: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...extra,
  } as never;
}

/** A child's saved session: its prompt, then the given assistant turns. */
function childSession(dir: string, ...turns: unknown[]): string {
  const manager = SessionManager.create(dir, dir);
  manager.appendModelChange("anthropic", "claude-haiku-4-5");
  manager.appendThinkingLevelChange("low");
  manager.appendMessage({ role: "user", content: "Audit the parser.", timestamp: Date.now() } as never);
  for (const turn of turns) manager.appendMessage(turn as never);
  return manager.getSessionFile() as string;
}

describe("readSavedResult", () => {
  it("reads the last assistant text and the model the session ran on", () => {
    hermetic = hermeticDir();
    const path = childSession(hermetic.dir, assistant("first look"), assistant("THE FINAL REPORT"));
    expect(readSavedResult(path)).toEqual({
      text: "THE FINAL REPORT",
      model: "anthropic/claude-haiku-4-5",
      thinking: "low",
    });
  });

  it("reports the provider error a failed final turn stopped on, with the text before it", () => {
    hermetic = hermeticDir();
    const path = childSession(
      hermetic.dir,
      assistant("got halfway"),
      assistant("", { stopReason: "error", errorMessage: "overloaded" }),
    );
    expect(readSavedResult(path)).toMatchObject({ text: "got halfway", error: "overloaded" });
  });

  it("explains a missing or foreign file, and never writes to it", () => {
    hermetic = hermeticDir();
    expect(readSavedResult(join(hermetic.dir, "gone.jsonl"))).toContain("is gone");
    const empty = join(hermetic.dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(readSavedResult(empty)).toContain("not a pi session");
    expect(statSync(empty).size).toBe(0);
    const foreign = join(hermetic.dir, "notes.jsonl");
    writeFileSync(foreign, '{"hello":"world"}\n');
    expect(readSavedResult(foreign)).toContain("not a pi session");
    expect(readFileSync(foreign, "utf-8")).toBe('{"hello":"world"}\n');
  });
});

/** Boot with the parent session's branch holding these entries. */
async function boot(branch: unknown[]) {
  booted = makePi();
  subagentsExtension(booted.pi);
  const parentCtx = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parentCtx };
}

/** A `subagents:record` entry as the parent session holds it after the agent finished. */
function recordEntry(resume: Record<string, unknown>) {
  return {
    type: "custom",
    customType: RECORD_ENTRY_TYPE,
    data: { id: resume.id, type: "Explore", description: "audit parser", status: resume.status, resume },
  };
}

const read = (b: BootedPi & { parentCtx: any }, agent_id: string) =>
  b.tools.get("get_subagent_result").execute("r", { agent_id }, undefined, undefined, b.parentCtx);

describe("get_subagent_result after the record was released", () => {
  it("answers from the kept state and the saved session, by id and by handle", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
    const sessionFile = childSession(hermetic.dir, assistant("THE FINAL REPORT"));
    const b = await boot([recordEntry({
      id: "agent-1", type: "Explore", description: "audit parser", sessionFile, completedAt: 1,
      handle: "explore", status: "completed", model: "anthropic/claude-haiku-4-5", thinking: "low",
    })]);

    for (const ref of ["agent-1", "explore"]) {
      const result = await read(b, ref);
      expect(result.isError).toBeUndefined();
      const text = textOf(result);
      expect(text).toContain("Agent: agent-1");
      expect(text).toContain("Status: completed");
      expect(text).toContain("Model: anthropic/claude-haiku-4-5, thinking: low");
      expect(text).toContain(`(Read from the agent's saved session file, ${sessionFile}`);
      expect(text).toContain("THE FINAL REPORT");
      expect(text).not.toContain("Agent not found");
    }
  });

  it("reports a failed agent as an error result with its error and partial output", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
    const sessionFile = childSession(
      hermetic.dir,
      assistant("got halfway"),
      assistant("", { stopReason: "error", errorMessage: "overloaded" }),
    );
    const b = await boot([recordEntry({
      id: "agent-2", type: "Explore", description: "audit parser", sessionFile, completedAt: 1, handle: "explore", status: "error",
    })]);

    const result = await read(b, "agent-2");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Error: overloaded");
    expect(textOf(result)).toContain("Partial output before the failure:\ngot halfway");
    // No model in the kept state: the session's own record of it is used.
    expect(textOf(result)).toContain("Model: anthropic/claude-haiku-4-5, thinking: low");
  });

  it("says why when the saved session is gone", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
    const b = await boot([recordEntry({
      id: "agent-3", type: "Explore", description: "x", sessionFile: join(hermetic.dir, "gone.jsonl"), completedAt: 1, handle: "explore",
    })]);

    const result = await read(b, "agent-3");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("was released from memory, and its result cannot be read: its session file is gone");
  });

  it("reads an agent the 10-minute cleanup evicted in this session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false } });
    const sessionFile = childSession(hermetic.dir, assistant("EVICTED ANSWER"));
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      const session = { dispose: vi.fn(), messages: [], sessionManager: { getSessionFile: () => sessionFile } } as any;
      opts.onSessionCreated?.(session);
      return { responseText: "EVICTED ANSWER", session, aborted: false, steered: false };
    });
    const b = await boot([]);
    const res = await b.tools.get("Agent").execute(
      "tc", { prompt: "go", description: "go", subagent_type: "general-purpose", run_in_background: false },
      undefined, undefined, b.parentCtx,
    );
    const id = res.details.agentId as string;

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toBeUndefined();

    const result = await read(b, id);
    expect(textOf(result)).toContain("EVICTED ANSWER");
    expect(textOf(result)).toContain("Status: completed");
    expect(textOf(result)).toContain("saved session file");
  });
});
