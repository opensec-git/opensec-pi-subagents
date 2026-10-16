/**
 * resume-owned-restart-e2e.test.ts — nested agents and workflow children stay
 * resumable after a restart, through REAL sessions.
 *
 * Two print-mode runs share one persisted parent session file and one agent
 * directory: the first ends with `session_shutdown` ("quit"), the second reopens
 * the same file, as `pi -c` after a restart would. All that carries over is
 * what the extension wrote into the parent session and the child session files.
 *
 * - Nested: `lead` delegates to `helper` through its nested `Agent` tool. After
 *   the restart, `lead` is resumed and resumes `helper` itself (its owner), and
 *   `helper` continues its own conversation.
 * - Workflow: a run's child is replayed from the journal by
 *   `resumeFromRunId`, then continued with `agent({ resume })`.
 *
 * No network: the faux backend answers every model call.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCwd } from "../src/output-file.js";
import { readJournal } from "../src/workflow/journal.js";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 90_000 });

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");

/** The last user message of a call: which turn of which agent this is. */
function lastUser(ctx: Context): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role === "user") return textOf(m as { content?: unknown });
  }
  return "";
}

function toolResults(ctx: Context, name: string): string[] {
  return ctx.messages
    .filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === name)
    .map((m) => textOf(m as { content?: unknown }));
}

/** The same, counting only this turn: after the last user message that reads `prompt`. */
function toolResultsSince(ctx: Context, prompt: string, name: string): string[] {
  let start = 0;
  ctx.messages.forEach((m, i) => {
    if (m.role === "user" && textOf(m as { content?: unknown }) === prompt) start = i;
  });
  return toolResults({ ...ctx, messages: ctx.messages.slice(start) }, name);
}

const asText = (ctx: Context) => JSON.stringify(ctx.messages);
/** The id a result hands back: the last `Agent ID:` line (a parent's result may quote its child's first). */
const agentIdIn = (text: string) => [...text.matchAll(/Agent ID: (\S+)/g)].at(-1)?.[1];

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

let home: string;
let cwd: string;
let prev: { agentDir?: string; home?: string; cwd: string };
const runs: PrintModeRun[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "subagents-owned-home-"));
  cwd = mkdtempSync(join(tmpdir(), "subagents-owned-cwd-"));
  prev = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME, cwd: process.cwd() };
  // Shared by both runs: the child sessions are saved under the agent dir.
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.HOME = home;
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ workflowsEnabled: true, outputTranscript: false }));
  writeFileSync(join(cwd, ".pi", "agents", "lead.md"), "---\ndescription: lead\nallowed_subagents: helper\n---\nYou are lead.\n");
  writeFileSync(join(cwd, ".pi", "agents", "helper.md"), "---\ndescription: helper\ntools: read\n---\nYou are helper.\n");
});

afterEach(async () => {
  for (const run of runs.splice(0)) await run.dispose();
  process.chdir(prev.cwd);
  if (prev.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prev.agentDir;
  if (prev.home === undefined) delete process.env.HOME;
  else process.env.HOME = prev.home;
  rmSync(join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd)), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** One run on the persisted parent session `file` (created on the first run). */
async function runOn(file: string | undefined, prompt: string, respond: (ctx: Context) => FauxReply) {
  const sessionManager = file ? SessionManager.open(file) : SessionManager.create(cwd, join(home, "parent-sessions"));
  const run = await runPrintMode({
    prompt,
    cwd,
    live: false,
    isolateGlobals: false,
    maxModelCalls: 32,
    sessionManager,
    respond,
  });
  return { run, file: sessionManager.getSessionFile() as string };
}

/** End a run the way quitting pi does, before the next one reopens its session. */
async function quit(run: PrintModeRun): Promise<void> {
  await run.dispose();
}

describe("owned agents across a restart (real sessions)", () => {
  it("a nested agent stays resumable by its owner after a restart", async () => {
    let leadId: string | undefined;
    let helperId: string | undefined;
    const first = await runOn(undefined, "root-1", (ctx) => {
      const turn = lastUser(ctx);
      if (turn === "helper-task") return "HELPER-FIRST-ANSWER";
      if (turn === "lead-task") {
        const nested = toolResults(ctx, "Agent");
        if (nested.length === 0) {
          return agentCall({ subagent_type: "helper", description: "help", prompt: "helper-task", run_in_background: false });
        }
        helperId = agentIdIn(nested[0]);
        return `lead done ${nested[0]}`;
      }
      const results = toolResults(ctx, "Agent");
      if (results.length === 0) {
        return agentCall({ subagent_type: "lead", description: "lead", prompt: "lead-task", run_in_background: false });
      }
      leadId = agentIdIn(results.at(-1) ?? "");
      return "Done.";
    });
    expect(helperId, "the nested result names the helper").toBeDefined();
    expect(leadId).toBeDefined();
    await quit(first.run);

    // The helper's resume state is in the parent session, owned by lead.
    const entries = readFileSync(first.file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toContainEqual(expect.objectContaining({
      type: "custom",
      customType: "subagents:resume",
      data: { resume: expect.objectContaining({ id: helperId, parentAgentId: leadId }) },
    }));

    let helperSawHistory = false;
    let nestedResumeResult = "";
    const second = await runOn(first.file, "root-2", (ctx) => {
      const turn = lastUser(ctx);
      if (turn === "helper-again") {
        helperSawHistory = asText(ctx).includes("helper-task") && asText(ctx).includes("HELPER-FIRST-ANSWER");
        return "HELPER-SECOND-ANSWER";
      }
      if (turn === "lead-again") {
        const nested = toolResultsSince(ctx, "lead-again", "Agent");
        if (nested.length === 0) {
          return agentCall({ subagent_type: "helper", description: "help again", prompt: "helper-again", resume: helperId });
        }
        nestedResumeResult = nested.at(-1) ?? "";
        return `lead again: ${nestedResumeResult}`;
      }
      const results = toolResultsSince(ctx, "root-2", "Agent");
      if (results.length === 0) {
        return agentCall({ subagent_type: "lead", description: "resume lead", prompt: "lead-again", resume: leadId, run_in_background: false });
      }
      return "Done.";
    });
    runs.push(second.run);

    expect(nestedResumeResult).not.toMatch(/not found|not owned/i);
    expect(nestedResumeResult).toContain("HELPER-SECOND-ANSWER");
    expect(helperSawHistory, "the helper continued its own conversation").toBe(true);
  });

  it("a workflow child replayed by resumeFromRunId can be continued with agent({ resume }) after a restart", async () => {
    const firstScript = [
      'export const meta = { name: "w", description: "one child" };',
      'return await agent("WF-FIRST", { label: "w" });',
    ].join("\n");
    const secondScript = [
      'export const meta = { name: "w", description: "one child, continued" };',
      'const a = await agent("WF-FIRST", { label: "w" });',
      'return await agent("WF-AGAIN", { label: "w", resume: "w" });',
    ].join("\n");

    const childTurns: string[] = [];
    let runId: string | undefined;
    const first = await runOn(undefined, "wf-1", (ctx) => {
      if (!(ctx.tools ?? []).some((t) => t.name === "SubagentWorkflow")) {
        childTurns.push(lastUser(ctx));
        return "WF-ANSWER-1";
      }
      const launched = toolResults(ctx, "SubagentWorkflow");
      if (launched.length === 0) return fauxToolCall("SubagentWorkflow", { script: firstScript });
      runId = /Task ID: (\S+)/.exec(launched[0])?.[1];
      return "launched";
    });
    expect(runId).toBeDefined();
    const journalPath = join(
      tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd),
      SessionManager.open(first.file).getSessionId(), "tasks", `${runId}.workflow.jsonl`,
    );
    expect(await waitFor(() => existsSync(journalPath) && readJournal(journalPath).length === 1)).toBe(true);
    expect(readJournal(journalPath)[0]).toMatchObject({ ok: true, text: "WF-ANSWER-1", ref: expect.any(String) });
    await first.run.manager?.waitForAll();
    // The child's resume state reaches the parent session as it settles.
    expect(await waitFor(() => readFileSync(first.file, "utf-8").includes('"subagents:resume"'))).toBe(true);
    await quit(first.run);

    let continued = "";
    let launchText = "";
    const second = await runOn(first.file, "wf-2", (ctx) => {
      if (!(ctx.tools ?? []).some((t) => t.name === "SubagentWorkflow")) {
        childTurns.push(lastUser(ctx));
        if (lastUser(ctx) === "WF-AGAIN") {
          continued = asText(ctx).includes("WF-FIRST") && asText(ctx).includes("WF-ANSWER-1") ? "with history" : "fresh";
        }
        return "WF-ANSWER-2";
      }
      const launched = toolResultsSince(ctx, "wf-2", "SubagentWorkflow");
      if (launched.length === 0) {
        return fauxToolCall("SubagentWorkflow", { script: secondScript, resumeFromRunId: runId });
      }
      launchText = launched[0];
      return "launched again";
    });
    runs.push(second.run);

    expect(launchText).toContain(`Resuming ${runId}`);
    expect(await waitFor(() => continued !== "")).toBe(true);
    expect(continued).toBe("with history");
    // WF-FIRST ran once, in the first run: the second replayed it.
    expect(childTurns.filter((turn) => turn === "WF-FIRST")).toHaveLength(1);
  });
});
