/**
 * anti-polling-wording.test.ts — what the model is told about a background
 * agent that has not finished must point it at the completion notification,
 * never at checking again. "Use wait: true or check back later" read as an
 * instruction to poll, and weak models looped on get_subagent_result.
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

const textOf = (r: any): string => r.content[0].text;

describe("get_subagent_result does not invite polling", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-poll-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-poll-agentdir-"));
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

  it("points a check on a running agent at the notification, and not at calling again", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = { dispose: vi.fn(), messages: [] } as any;
      opts.onSessionCreated?.(session);
      await new Promise<void>((resolve) => { finish = resolve; });
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const spawn = await tools.get("Agent").execute(
      "tc-bg",
      { prompt: "Look around.", description: "look", subagent_type: "general-purpose" },
      undefined,
      undefined,
      ctx(),
    );
    const spawnText = textOf(spawn);
    expect(spawnText).toContain("do not poll it");
    expect(spawnText).not.toMatch(/get_subagent_result to (wait|retrieve)/);

    const id = spawn.details.agentId;
    const check = await tools.get("get_subagent_result").execute("tc-r", { agent_id: id }, undefined, undefined, ctx());
    const checkText = textOf(check);
    expect(check.isError).toBeUndefined();
    expect(checkText).toContain("Agent is still running.");
    expect(checkText).toContain("A completion notification will arrive on its own");
    expect(checkText).toContain("continue with other work");
    expect(checkText).toContain("do not call get_subagent_result for this agent again");
    expect(checkText).not.toContain("check back later");
    expect(checkText).not.toContain("Use wait: true");

    // The refused resume of a running agent does not send the model to wait either.
    const resume = await tools.get("Agent").execute(
      "tc-res",
      { prompt: "more", description: "more", subagent_type: "general-purpose", resume: id },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(resume)).not.toContain("to wait for it");
    expect(textOf(resume)).toContain("A completion notification arrives on its own");

    finish();
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("describes wait as a last resort and keeps it off by default", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const tool = tools.get("get_subagent_result");
    expect(tool.description).toContain("do not call this to check on one that is still running");
    expect(tool.parameters.properties.wait.description).toContain("Only when there is nothing else to do");
    expect(tool.parameters.properties.wait.description).toContain("Default: false");
    expect(tool.parameters.required ?? []).not.toContain("wait");
  });
});
