import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type * as PiSDK from "@earendil-works/pi-coding-agent";
import { createAgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunOptions, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import type { ThinkingLevel } from "../src/types.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof PiSDK>();
  return { ...actual, createAgentSession: vi.fn() };
});

const parent: Model<"openai-completions"> = {
  id: "parent-model", name: "Parent", provider: "custom-provider",
  api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000, maxTokens: 8192,
};
const haiku = { ...parent, provider: "anthropic", id: "claude-haiku-4-5" };
const stop = new Error("stop before model request");

describe("parent model and effort inheritance at session construction", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-parent-inheritance-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
    registerAgents(new Map());
    vi.mocked(createAgentSession).mockReset().mockRejectedValue(stop);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  async function construct(type: string, thinkingLevel?: ThinkingLevel, options: Partial<RunOptions> = {}) {
    const models = [parent, haiku];
    const ctx = {
      cwd, model: parent, thinkingLevel, getSystemPrompt: () => "Parent prompt",
      modelRegistry: {
        find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
        getAvailable: () => models,
      },
    } as unknown as ExtensionContext;
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    await expect(runAgent(ctx, type, "test", { pi, isolated: true, ...options })).rejects.toBe(stop);
    return vi.mocked(createAgentSession).mock.calls.at(-1)![0]!;
  }

  for (const type of ["Explore", "general-purpose"]) {
    it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[])(
      `${type} inherits parent model and %s even with Haiku available`, async effort => {
        const opts = await construct(type, effort);
        expect(opts.model).toBe(parent);
        expect(opts.thinkingLevel).toBe(effort);
      },
    );
  }

  it("preserves explicit model and effort overrides", async () => {
    const opts = await construct("Explore", "high", { model: haiku, thinkingLevel: "off" });
    expect(opts.model).toBe(haiku);
    expect(opts.thinkingLevel).toBe("off");
  });

  it("preserves agent-file pins ahead of call parameters and parent defaults", async () => {
    const config = { ...DEFAULT_AGENTS.get("Explore")!, model: "anthropic/claude-haiku-4-5", thinking: "low" as const };
    registerAgents(new Map([["Explore", config]]));
    const invocation = resolveAgentInvocationConfig(config, { model: "custom-provider/parent-model", thinking: "max" });
    expect(invocation.modelInput).toBe(config.model);
    const opts = await construct("Explore", "high", { thinkingLevel: invocation.thinking });
    expect(opts.model).toBe(haiku);
    expect(opts.thinkingLevel).toBe("low");
  });

  it("leaves the SDK fallback available when the parent supplies no effort", async () => {
    expect((await construct("Explore")).thinkingLevel).toBeUndefined();
  });

  it("does not replace a reopened session's saved effort with the parent's", async () => {
    expect((await construct("Explore", "max", { resumeSessionFile: join(cwd, "saved.jsonl") })).thinkingLevel).toBeUndefined();
  });
});
