/**
 * failed-results.test.ts — a run that did not deliver its answer comes back to
 * the model as an error result, with what it produced and where its turns are.
 *
 * Through the REAL Agent, get_subagent_result and steer_subagent tools, with a
 * fake runAgent: the cases here are failures (a throw after real turns, a user
 * stop, a turn-limit abort) that no live model produces on request.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const SESSION_FILE = "/tmp/agent-session.jsonl";
const textOf = (r: any): string => r.content[0].text;

/** A session stub with a file and an assistant turn already on it. */
function sessionWithTurn(text: string) {
  return {
    dispose: vi.fn(),
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "text", text }] },
    ],
    sessionManager: { getSessionFile: () => SESSION_FILE },
  } as any;
}

function foreground(tools: Map<string, any>, signal?: AbortSignal) {
  return tools.get("Agent").execute(
    "tc-fg",
    { prompt: "Do the work.", description: "work", subagent_type: "general-purpose", run_in_background: false },
    signal,
    undefined,
    ctx(),
  );
}

describe("failed agents are error results", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-failed-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-failed-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("a run that throws after real turns keeps its last text and names its session file", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // A reopened conversation's earlier answer is history, not this run's output.
      const session = sessionWithTurn("EARLIER-RUN-ANSWER");
      opts.onSessionCreated?.(session);
      session.messages.push(
        { role: "user", content: [{ type: "text", text: "go on" }] },
        { role: "assistant", content: [{ type: "text", text: "HALF-DONE-ANALYSIS" }] },
      );
      throw new Error("connection reset");
    });

    const res = await foreground(tools);

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("Agent failed: connection reset");
    expect(text).toContain("Partial output before the failure:\nHALF-DONE-ANALYSIS");
    expect(text).toContain(`Session file (every turn of this agent): ${SESSION_FILE}`);
    expect(text).not.toContain("EARLIER-RUN-ANSWER");

    // The same record, read back, is still an error with the same salvage.
    const read = await tools.get("get_subagent_result").execute("tc-r", { agent_id: res.details.agentId }, undefined, undefined, ctx());
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain("HALF-DONE-ANALYSIS");
    expect(textOf(read)).toContain(SESSION_FILE);

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("a turn-limit abort is an error result, not 'completed'", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = sessionWithTurn("PARTIAL");
      opts.onSessionCreated?.(session);
      return { responseText: "PARTIAL", session, aborted: true, steered: true };
    });

    const res = await foreground(tools);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Agent was aborted after/);
    expect(textOf(res)).not.toContain("Agent completed");
    expect(textOf(res)).toContain(SESSION_FILE);
    // Our own error result keeps its status line in the renderer.
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: false }, theme, { isError: true })
      .render(120).join("\n");
    expect(rendered).toContain("Aborted (max turns exceeded)");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("a user stop says the user stopped it and is an error result", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const controller = new AbortController();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = sessionWithTurn("SO-FAR");
      opts.onSessionCreated?.(session);
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { responseText: "SO-FAR", session, aborted: false, steered: false };
    });

    const pending = foreground(tools, controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const res = await pending;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Agent was stopped by the user after/);
    expect(textOf(res)).toContain("STOPPED BY THE USER");
    expect(textOf(res)).toContain("SO-FAR");

    const read = await tools.get("get_subagent_result").execute("tc-r", { agent_id: res.details.agentId }, undefined, undefined, ctx());
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain("the user ended this run");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("a completed run is not an error result", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = sessionWithTurn("ANSWER");
      opts.onSessionCreated?.(session);
      return { responseText: "ANSWER", session, aborted: false, steered: false };
    });

    const res = await foreground(tools);

    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toMatch(/^Agent completed in/);
    expect(textOf(res)).not.toContain("Session file");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("not-found answers from get_subagent_result, steer_subagent and resume are error results", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const result = await tools.get("get_subagent_result").execute("t1", { agent_id: "nope" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Agent not found");

    const steer = await tools.get("steer_subagent").execute("t2", { agent_id: "nope", message: "hi" }, undefined, undefined, ctx());
    expect(steer.isError).toBe(true);
    expect(textOf(steer)).toContain("Agent not found");

    const resume = await tools.get("Agent").execute(
      "t3",
      { prompt: "more", description: "more", subagent_type: "general-purpose", resume: "nope" },
      undefined,
      undefined,
      ctx(),
    );
    expect(resume.isError).toBe(true);
    expect(textOf(resume)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
