/**
 * model-inheritance-e2e.test.ts — a subagent runs on the parent's current model
 * at the parent's current thinking level, through REAL sessions.
 *
 * The parent (faux, reasoning-capable, thinking "high") calls the Agent tool
 * with its own `model` and `thinking: "minimal"`. With `allowModelOverride` off
 * (the default) the parameters are not offered and are ignored if sent anyway,
 * so the child runs at "high". An agent file's own `thinking:` still wins, and
 * `allowModelOverride: true` restores the per-call choice. No network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });

const runs: PrintModeRun[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const isParent = (ctx: Context) => (ctx.tools ?? []).some((t) => t.name === "Agent");
const hasAgentResult = (ctx: Context) =>
  ctx.messages.some((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent");

function project(files: { settings?: Record<string, unknown>; agents?: Record<string, string> } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-model-e2e-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  if (files.settings) writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(files.settings));
  for (const [name, body] of Object.entries(files.agents ?? {})) {
    writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), body);
  }
  return cwd;
}

/** Run one foreground spawn that asks for a cheaper model and lower effort; report what the child ran with. */
async function spawnAskingForLess(cwd: string, subagentType = "general-purpose") {
  let agentSchema: Record<string, unknown> | undefined;
  const run = await runPrintMode({
    prompt: "delegate",
    cwd,
    reasoning: true,
    thinkingLevel: "high",
    respond: (ctx): FauxReply => {
      if (!isParent(ctx)) return "child done";
      agentSchema ??= (ctx.tools ?? []).find((t) => t.name === "Agent")?.parameters as Record<string, unknown>;
      if (hasAgentResult(ctx)) return "Done.";
      return agentCall({
        prompt: "work",
        description: "probe",
        subagent_type: subagentType,
        run_in_background: false,
        model: "faux/faux-1",
        thinking: "minimal",
      });
    },
  });
  runs.push(run);
  const child = run.subagents[0] as { invocation?: { thinking?: string; modelId?: string } } | undefined;
  const id = /Agent ID: (\S+)/.exec(
    run.parentSession.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join(""))
      .join("\n"),
  )?.[1];
  const record = (child ?? (id ? run.manager?.getRecord(id) : undefined)) as
    | { invocation?: { thinking?: string; modelId?: string } }
    | undefined;
  return { record, properties: Object.keys((agentSchema?.properties as object | undefined) ?? {}) };
}

describe("subagent model and thinking level (real sessions)", () => {
  it("runs on the parent's model at the parent's thinking level, ignoring the call's own (the default)", async () => {
    const { record, properties } = await spawnAskingForLess(project());
    expect(properties).not.toContain("model");
    expect(properties).not.toContain("thinking");
    expect(record?.invocation?.modelId).toBe("faux/faux-1");
    expect(record?.invocation?.thinking).toBe("high");
  });

  it("keeps an agent file's explicit thinking level", async () => {
    const cwd = project({
      agents: { pinned: "---\ndescription: pinned\ntools: read\nthinking: low\n---\nYou are pinned.\n" },
    });
    const { record } = await spawnAskingForLess(cwd, "pinned");
    expect(record?.invocation?.thinking).toBe("low");
  });

  it("allowModelOverride: true restores the call's thinking level and the schema parameters", async () => {
    const { record, properties } = await spawnAskingForLess(project({ settings: { allowModelOverride: true } }));
    expect(properties).toContain("model");
    expect(properties).toContain("thinking");
    expect(record?.invocation?.thinking).toBe("minimal");
  });
});
