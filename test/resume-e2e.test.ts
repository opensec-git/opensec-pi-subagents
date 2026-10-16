/**
 * resume-e2e.test.ts — resuming subagents through REAL sessions.
 *
 * Drives the print-mode host (test/helpers/print-mode-runner.ts) with a scripted
 * faux model: the parent spawns a child, waits for it, then resumes it through
 * the `Agent` tool. Everything between — the manager, the runner, pi's session,
 * the tools the child calls — is real. No network, no provider keys.
 */
import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");

const agentResults = (ctx: Context) =>
  ctx.messages.filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent");

const isParent = (ctx: Context) => (ctx.tools ?? []).some((t) => t.name === "Agent");

/** The id a background spawn's envelope (or a foreground result) hands the model. */
const agentIdIn = (text: string) => /Agent ID: (\S+)/.exec(text)?.[1];

/**
 * Parent: spawn in the background, wait for the completion nudge, then resume
 * with `resumeArgs` (foreground unless they say otherwise).
 */
function parentScript(spawnArgs: Record<string, unknown>, resumePrompt: string, resumeArgs: Record<string, unknown> = {}) {
  return (ctx: Context): FauxReply => {
    const results = agentResults(ctx);
    if (results.length === 0) {
      return agentCall({ description: "probe", prompt: "probe", run_in_background: true, ...spawnArgs });
    }
    if (results.length === 1) {
      const notified = ctx.messages.some(
        (m) => m.role === "user" && (textOf(m).includes("<task-id>") || textOf(m).includes("Background agents have completed")),
      );
      if (!notified) return "waiting for the agent";
      return agentCall({
        resume: agentIdIn(textOf(results[0])),
        prompt: resumePrompt,
        description: "resume",
        run_in_background: false,
        ...resumeArgs,
      });
    }
    return "Done.";
  };
}

/** The record of the run's first spawned agent, read through the manager registry. */
function recordOf(r: PrintModeRun): { status?: string; result?: string } | undefined {
  const results = r.parentSession.messages.filter(
    (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
  );
  const id = agentIdIn(textOf(results[0] ?? {}));
  return id ? (r.manager?.getRecord(id) as { status?: string; result?: string } | undefined) : undefined;
}

let run: PrintModeRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

describe("resume enforces the run limits", () => {
  for (const background of [false, true]) {
    it(`steers at max_turns and aborts after the grace turns on a ${background ? "background" : "foreground"} resume`, async () => {
      let phase: "first" | "resume" = "first";
      let resumeCalls = 0;
      let sawLimitSteer = false;
      run = await runPrintMode({
        prompt: "go",
        live: false,
        maxModelCalls: 60,
        respond: (ctx) => {
          if (isParent(ctx)) {
            const r = parentScript({ prompt: "first task", max_turns: 2 }, "keep going", { run_in_background: background })(ctx);
            if (typeof r !== "string" && agentResults(ctx).length === 1) phase = "resume";
            return r;
          }
          if (phase === "first") return "FIRST-DONE";
          if (ctx.messages.some((m) => textOf(m).includes("reached your turn limit"))) sawLimitSteer = true;
          resumeCalls++;
          // Never wraps up on its own: only the limit can end this run.
          return resumeCalls <= 20 ? fauxToolCall("ls", { path: "." }) : "RESUME-DONE";
        },
      });

      // max_turns 2 + 5 grace turns: steered at turn 2, aborted at turn 7.
      expect(sawLimitSteer).toBe(true);
      expect(resumeCalls).toBeLessThanOrEqual(8);
      expect(recordOf(run)?.status).toBe("aborted");
    });
  }

  it("lets an explicit max_turns on the resume replace the first run's limit", async () => {
    let phase: "first" | "resume" = "first";
    let resumeCalls = 0;
    run = await runPrintMode({
      prompt: "go",
      live: false,
      maxModelCalls: 60,
      respond: (ctx) => {
        if (isParent(ctx)) {
          const r = parentScript({ prompt: "first task" }, "keep going", { max_turns: 1 })(ctx);
          if (typeof r !== "string" && agentResults(ctx).length === 1) phase = "resume";
          return r;
        }
        if (phase === "first") return "FIRST-DONE";
        resumeCalls++;
        return resumeCalls <= 20 ? fauxToolCall("ls", { path: "." }) : "RESUME-DONE";
      },
    });

    // max_turns 1 + 5 grace turns.
    expect(resumeCalls).toBeLessThanOrEqual(7);
  });
});

describe("resume of a foreground agent", () => {
  it("finds the agent id in the foreground result and resumes the same conversation", async () => {
    const childContexts: string[][] = [];
    run = await runPrintMode({
      prompt: "go",
      live: false,
      maxModelCalls: 20,
      respond: (ctx) => {
        if (isParent(ctx)) {
          const results = agentResults(ctx);
          if (results.length === 0) {
            return agentCall({ description: "fg", prompt: "CODEWORD BANANA. Reply ACK-1.", run_in_background: false });
          }
          if (results.length === 1) {
            // Only what the model can see: the result text.
            const id = agentIdIn(textOf(results[0]));
            if (!id) return "NO-ID";
            return agentCall({ resume: id, prompt: "What was the codeword?", description: "resume", run_in_background: false });
          }
          return "Done.";
        }
        childContexts.push(ctx.messages.map((m) => `${m.role}:${textOf(m)}`));
        return childContexts.length === 1 ? "ACK-1" : "BANANA";
      },
    });

    expect(run.responseText).not.toContain("NO-ID");
    expect(childContexts).toHaveLength(2);
    expect(childContexts[1]).toEqual([
      "user:CODEWORD BANANA. Reply ACK-1.",
      "assistant:ACK-1",
      "user:What was the codeword?",
    ]);
  });
});
