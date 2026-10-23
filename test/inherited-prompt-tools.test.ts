/**
 * 0.20.7: a subagent's inherited (append-mode) system prompt drops the lines of
 * the parent's tools it does not have.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiSDK from "@earendil-works/pi-coding-agent";
import { createAgentSession, type ExtensionAPI, type ExtensionContext, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, toolsChildLacks } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { stripToolLines } from "../src/orchestration.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof PiSDK>();
  return { ...actual, createAgentSession: vi.fn() };
});

const tool = (name: string, path: string, promptGuidelines?: string[]): ToolInfo =>
  ({ name, promptGuidelines, sourceInfo: { path, source: "x", scope: "user", origin: "top-level" } }) as unknown as ToolInfo;
const piWith = (tools: ToolInfo[]) => ({ getAllTools: () => tools });
const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

describe("stripToolLines", () => {
  const prompt = [
    "Available tools:",
    "- read: Read files",
    "- Agent: Launch a subagent",
    "- get_subagent_result: Check a background agent",
    "",
    "Guidelines:",
    "- Use Agent for broad searches.",
    "- Prefer read over cat.",
    "Call Agent only when it helps.",
  ].join("\n");

  it("removes each tool's name line and its own guideline lines, matched exactly", () => {
    const out = stripToolLines(prompt, [
      { name: "Agent", promptGuidelines: ["Use Agent for broad searches."] },
      { name: "get_subagent_result" },
    ]);
    expect(out).toBe([
      "Available tools:",
      "- read: Read files",
      "",
      "Guidelines:",
      "- Prefer read over cat.",
      "Call Agent only when it helps.",
    ].join("\n"));
  });

  it("leaves the prompt as it is without tools to drop", () => {
    expect(stripToolLines(prompt, [])).toBe(prompt);
  });

  it("does not remove a line that only starts with the tool name", () => {
    expect(stripToolLines("- readme: notes\n- read: Read files", [{ name: "read" }])).toBe("- readme: notes");
  });
});

describe("toolsChildLacks", () => {
  const all = [
    tool("read", "builtin:read"),
    tool("bash", "builtin:bash"),
    tool("Agent", "/ext/opensec-pi-subagents/index.ts"),
    tool("steer_subagent", "/ext/opensec-pi-subagents/index.ts"),
    tool("web_search", "/home/u/.pi/agent/extensions/web/index.ts"),
    tool("todo", "/home/u/.pi/agent/extensions/todo/index.ts"),
    tool("inline_tool", "<inline:abc>"),
  ];

  it("lists orchestration tools, denied tools and built-ins the child was not given", () => {
    const lacks = toolsChildLacks(piWith(all), { toolNames: ["read"], disallowed: ["todo"], extensions: true });
    expect(names(lacks)).toEqual(["Agent", "bash", "steer_subagent", "todo"].sort());
  });

  it("lists every extension tool when the child loads no extensions, but keeps its built-ins", () => {
    const lacks = toolsChildLacks(piWith(all), { toolNames: ["read", "bash"], extensions: false });
    expect(names(lacks)).toEqual(["Agent", "inline_tool", "steer_subagent", "todo", "web_search"].sort());
  });

  it("lists tools of extensions outside the child's list or excluded by it", () => {
    expect(names(toolsChildLacks(piWith(all), { toolNames: ["read", "bash"], extensions: ["web"] })))
      .toEqual(["Agent", "steer_subagent", "todo"].sort());
    expect(names(toolsChildLacks(piWith(all), { toolNames: ["read", "bash"], extensions: ["*"], excludeExtensions: ["Web"] })))
      .toEqual(["Agent", "steer_subagent", "web_search"].sort());
  });

  it("keeps inline extension tools, which cannot be matched to the child's list", () => {
    expect(names(toolsChildLacks(piWith(all), { toolNames: ["read", "bash"], extensions: ["web"] }))).not.toContain("inline_tool");
  });

  it("carries each tool's prompt guidelines", () => {
    const lacks = toolsChildLacks(piWith([tool("Agent", "/x/index.ts", ["Use Agent."])]), { toolNames: [], extensions: true });
    expect(lacks).toEqual([{ name: "Agent", promptGuidelines: ["Use Agent."] }]);
  });

  it("strips nothing when the parent's registry cannot be read", () => {
    expect(toolsChildLacks(undefined, { toolNames: [], extensions: true })).toEqual([]);
    expect(toolsChildLacks({ getAllTools: () => { throw new Error("not bound yet"); } }, { toolNames: [], extensions: true })).toEqual([]);
  });
});

describe("runAgent: the inherited prompt", () => {
  const stop = new Error("stop before model request");
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-inherited-prompt-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
    registerAgents(new Map());
    vi.mocked(createAgentSession).mockReset().mockRejectedValue(stop);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  it("an append-mode agent's system prompt no longer lists the parent's orchestration tools", async () => {
    const parentPrompt = [
      "Parent prompt",
      "- read: Read files",
      "- Agent: Launch a subagent",
      "- Use Agent for broad searches.",
      "- Prefer read over cat.",
    ].join("\n");
    const ctx = {
      cwd, model: undefined, getSystemPrompt: () => parentPrompt,
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
    } as unknown as ExtensionContext;
    const pi = {
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      getAllTools: () => [tool("read", "builtin:read"), tool("Agent", "/ext/subagents/index.ts", ["Use Agent for broad searches."])],
    } as unknown as ExtensionAPI;
    await expect(runAgent(ctx, "general-purpose", "test", { pi, isolated: true })).rejects.toBe(stop);
    const opts = vi.mocked(createAgentSession).mock.calls.at(-1)![0]!;
    const systemPrompt = opts.resourceLoader!.getSystemPrompt()!;
    expect(systemPrompt).toContain("- read: Read files");
    expect(systemPrompt).toContain("- Prefer read over cat.");
    expect(systemPrompt).not.toContain("- Agent: Launch a subagent");
    expect(systemPrompt).not.toContain("Use Agent for broad searches.");
  });
});
