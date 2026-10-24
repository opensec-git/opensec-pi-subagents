/**
 * 0.20.7: agents the end of the parent session interrupted are recorded as
 * such, and the next start of that session tells the parent, once, to resume
 * them. Real extension (src/index.ts), mocked runner.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension, { formatInterruptedNotice, interruptedAgentsFromEntries } from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
let hermetic: Hermetic | undefined;
const booted: Array<Map<string, any>> = [];

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
});

afterEach(async () => {
  for (const lifecycle of booted.splice(0)) await lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  hermetic?.restore();
  hermetic = undefined;
});

function sessionPath() {
  const path = join(process.cwd(), "agent-session.jsonl");
  writeFileSync(path, `${JSON.stringify({
    type: "session", version: 3, id: "0b9f3c1e-2a4d-4c8e-9f10-1a2b3c4d5e6f",
    timestamp: new Date(0).toISOString(), cwd: process.cwd(),
  })}\n`);
  return path;
}

function fakeSession(file: string) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    sessionManager: { getSessionFile: () => file },
    model: { provider: "anthropic", id: "claude-haiku", name: "Claude Haiku" },
  } as any;
}

/** Every run lasts until it is aborted. */
function runUntilAborted(file: string) {
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => new Promise((resolve) => {
    const session = fakeSession(file);
    opts.onSessionCreated?.(session);
    opts.signal?.addEventListener("abort", () => resolve({ responseText: "half done", session, aborted: false, steered: false } as any));
  }) as any);
}

async function bootSession(branch: unknown[] = []) {
  const b = makePi();
  subagentsExtension(b.pi);
  booted.push(b.lifecycle);
  await b.lifecycle.get("session_start")?.({}, ctx({ sessionManager: { getSessionId: () => "s1", getBranch: () => branch } }));
  return b;
}

function entriesOf(pi: any): unknown[] {
  return pi.appendEntry.mock.calls.map(([customType, data]: [string, unknown]) => ({ type: "custom", customType, data }));
}

async function spawn(b: any, description: string): Promise<string> {
  const r = await b.tools.get("Agent").execute(
    `tc-${description}`, { prompt: "go", description, subagent_type: "Explore", run_in_background: true },
    undefined, undefined, ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

/** Stop an agent as a user does (here through the cross-extension RPC stop). */
async function userStop(b: any, agentId: string) {
  const [, stop] = b.pi.events.on.mock.calls.find(([channel]: any[]) => channel === "subagents:rpc:stop");
  await stop({ requestId: "stop-1", agentId });
  await flush();
}

/** Shut an instance down as a quit does, and forget it. */
async function quit(b: any) {
  await b.lifecycle.get("session_shutdown")?.({ reason: "quit" });
  booted.splice(booted.indexOf(b.lifecycle), 1);
  delete (globalThis as any)[MANAGER_KEY];
}

describe("an agent interrupted by its session's end", () => {
  it("is recorded with stopCause session-end, on the record and in its resume state", async () => {
    const file = sessionPath();
    runUntilAborted(file);
    const first = await bootSession();
    const id = await spawn(first, "long job");
    await flush();
    await quit(first);

    const last = entriesOf(first.pi).filter((e: any) => e.data?.id === id).at(-1) as any;
    expect(last.data).toMatchObject({ status: "stopped", stopCause: "session-end", resume: { id, sessionFile: file, stopCause: "session-end" } });
  });

  it("is named once to the first run of the next start, which records the notice", async () => {
    const file = sessionPath();
    runUntilAborted(file);
    const first = await bootSession();
    const a = await spawn(first, "audit");
    const b = await spawn(first, "fuzz");
    await flush();
    await quit(first);
    const entries = entriesOf(first.pi);

    const second = await bootSession(entries);
    const result = await second.lifecycle.get("before_agent_start")({ type: "before_agent_start", prompt: "continue" }, ctx());
    // Order follows the shutdown's records, which do not order agents started in the same millisecond.
    expect(result.message).toMatchObject({ customType: "subagents-interrupted", display: true });
    expect([...result.message.details.ids].sort()).toEqual([a, b].sort());
    expect(result.message.content).toContain(`- ${a} (Explore): audit`);
    expect(result.message.content).toContain(`- ${b} (Explore): fuzz`);
    expect(second.pi.appendEntry).toHaveBeenCalledWith("subagents:interrupted-notice", { ids: result.message.details.ids });
    // Once: the next run gets nothing.
    expect(await second.lifecycle.get("before_agent_start")({ type: "before_agent_start", prompt: "again" }, ctx())).toBeUndefined();
    await quit(second);

    // Nor does a later start that reads the notice entry.
    const third = await bootSession([...entries, ...entriesOf(second.pi)]);
    expect(await third.lifecycle.get("before_agent_start")({ type: "before_agent_start", prompt: "x" }, ctx())).toBeUndefined();
  });

  it("a foreground run Pi's shutdown aborted just before is recorded as interrupted too", async () => {
    const file = sessionPath();
    // A run that winds down only after the session is gone, like a tool still unwinding.
    let settle!: () => void;
    vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => new Promise((resolve) => {
      const session = fakeSession(file);
      opts.onSessionCreated?.(session);
      settle = () => resolve({ responseText: "half done", session, aborted: false, steered: false } as any);
    }) as any);
    const first = await bootSession();
    const toolCall = new AbortController();
    void first.tools.get("Agent").execute(
      "tc-fg", { prompt: "go", description: "foreground job", subagent_type: "Explore", run_in_background: false },
      toolCall.signal, undefined, ctx(),
    );
    await flush();
    toolCall.abort(); // Pi aborts the tool call, then fires session_shutdown
    await flush();
    const shutdown = quit(first);
    settle();
    await shutdown;

    const last = entriesOf(first.pi).filter((e: any) => e.customType === "subagents:record" && e.data?.description === "foreground job").at(-1) as any;
    expect(last.data).toMatchObject({ status: "stopped", stopCause: "session-end" });
  });

  it("an agent the user stopped is not named", async () => {
    const file = sessionPath();
    runUntilAborted(file);
    const first = await bootSession();
    const id = await spawn(first, "audit");
    await flush();
    await userStop(first, id);
    await quit(first);

    const last = entriesOf(first.pi).filter((e: any) => e.data?.id === id).at(-1) as any;
    expect(last.data.status).toBe("stopped");
    expect(last.data.stopCause).toBeUndefined();
    const second = await bootSession(entriesOf(first.pi));
    expect(await second.lifecycle.get("before_agent_start")({ type: "before_agent_start", prompt: "x" }, ctx())).toBeUndefined();
  });
});

describe("interruptedAgentsFromEntries", () => {
  const record = (id: string, data: Record<string, unknown>) =>
    ({ type: "custom", customType: "subagents:record", data: { id, type: "Explore", description: id, ...data } });
  const resume = { sessionFile: "/s.jsonl" };

  it("lists session-end stops with a saved session; a later record of the same agent replaces it", () => {
    const entries = [
      record("a", { status: "stopped", stopCause: "session-end", resume }),
      record("b", { status: "stopped", resume: { ...resume, stopCause: "session-end" } }),
      record("c", { status: "stopped", stopCause: "session-end" }), // no saved session
      record("d", { status: "stopped", resume }), // the user's stop
      record("e", { status: "stopped", stopCause: "session-end", resume }),
      record("e", { status: "completed", resume }), // resumed and finished since
    ];
    expect(interruptedAgentsFromEntries(entries)).toEqual([
      { id: "a", type: "Explore", description: "a" },
      { id: "b", type: "Explore", description: "b" },
    ]);
  });

  it("drops agents a notice entry already named", () => {
    const entries = [
      record("a", { status: "stopped", stopCause: "session-end", resume }),
      record("b", { status: "stopped", stopCause: "session-end", resume }),
      { type: "custom", customType: "subagents:interrupted-notice", data: { ids: ["a"] } },
    ];
    expect(interruptedAgentsFromEntries(entries).map((a) => a.id)).toEqual(["b"]);
  });

  it("formats the notice in the singular and the plural", () => {
    const one = formatInterruptedNotice([{ id: "a", type: "Explore", description: "audit" }]);
    expect(one).toBe([
      "<interrupted-agents>",
      "1 background agent of this session was still running when the session last ended, and was interrupted by that, not stopped by anyone. Each keeps its whole context: to finish its task, resume it with the Agent tool (`resume: \"<id>\"` and a prompt to continue) instead of starting a fresh agent, which would redo its work.",
      "- a (Explore): audit",
      "</interrupted-agents>",
    ].join("\n"));
    const two = formatInterruptedNotice([{ id: "a", type: "Explore", description: "x" }, { id: "b", type: "Plan", description: "y" }]);
    expect(two).toContain("2 background agents of this session were still running");
    expect(two).toContain("- b (Plan): y");
  });
});

describe("the texts the parent reads", () => {
  it("the Agent tool says stopped and failed agents keep their context and are resumed", async () => {
    const b = await bootSession();
    const agent = b.tools.get("Agent");
    expect(agent.description).toContain("An agent that stopped or failed (a provider error, a restart of your own session) keeps its whole context: resume it rather than starting a fresh one");
    expect(agent.parameters.properties.resume.description).toContain("Finished, stopped and failed agents stay resumable, with their context");
  });

  it("a background notification of a stopped run carries the resume hint", async () => {
    const file = sessionPath();
    runUntilAborted(file);
    const b = await bootSession();
    const id = await spawn(b, "audit");
    await flush();
    await userStop(b, id);
    b.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
    await new Promise((r) => setTimeout(r, 300)); // past the notification hold
    const sent: string[] = b.pi.sendMessage.mock.calls.map((c: any[]) => String(c[0]?.content ?? ""));
    expect(sent.join("\n")).toContain(`<resume>It keeps its context: pass ${id} as \`resume\``);
  });
});
