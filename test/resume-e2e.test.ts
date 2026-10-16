/**
 * resume-e2e.test.ts — resuming subagents through REAL sessions.
 *
 * Drives the print-mode host (test/helpers/print-mode-runner.ts) with a scripted
 * faux model: the parent spawns a child, waits for it, then resumes it through
 * the `Agent` tool. Everything between — the manager, the runner, pi's session,
 * the tools the child calls — is real. No network, no provider keys.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Parent: spawn in the foreground, then resume using the id in its result. */
function foregroundScript(spawnArgs: Record<string, unknown>, resumePrompt: string) {
  return (ctx: Context): FauxReply => {
    const results = agentResults(ctx);
    if (results.length === 0) {
      return agentCall({ description: "probe", prompt: "probe", run_in_background: false, ...spawnArgs });
    }
    if (results.length === 1) {
      return agentCall({
        resume: agentIdIn(textOf(results[0])),
        prompt: resumePrompt,
        description: "resume",
        run_in_background: false,
      });
    }
    return "Done.";
  };
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

describe("resume of a worktree-isolated agent", () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function makeRepo() {
    const repo = mkdtempSync(join(tmpdir(), "wt-resume-"));
    repos.push(repo);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "x");
    git("add", "README.md");
    git("commit", "-q", "-m", "init");
    return { repo, git };
  }

  /**
   * First run: `pwd`, optionally write first.txt. Then the parent resumes it
   * (before which `beforeResume` may tamper with the repo); the resumed run
   * runs `pwd` and writes resumed.txt.
   */
  async function runWorktreeResume(repo: string, opts: { firstWrites: boolean; beforeResume?: () => void }) {
    let phase: "first" | "resume" = "first";
    let firstPwd = "";
    const resumeToolResults: string[] = [];
    let resumeStep = 0;
    run = await runPrintMode({
      prompt: "go",
      cwd: repo,
      live: false,
      maxModelCalls: 40,
      respond: (ctx) => {
        if (isParent(ctx)) {
          // Foreground spawn, resumed by the id in its result: no completion
          // nudge to race the print-mode host's hold loop.
          const r = foregroundScript({ prompt: "isolated task", isolation: "worktree" }, "do more work")(ctx);
          if (typeof r !== "string" && agentResults(ctx).length === 1) {
            phase = "resume";
            opts.beforeResume?.();
          }
          return r;
        }
        const results = ctx.messages.filter((m) => m.role === "toolResult");
        if (phase === "first") {
          if (results.length === 0) return fauxToolCall("bash", { command: "pwd" });
          if (results.length === 1) {
            firstPwd = textOf(results[0]).trim();
            if (opts.firstWrites) return fauxToolCall("write", { path: "first.txt", content: "first run\n" });
          }
          return "WT-1 done";
        }
        resumeStep++;
        if (resumeStep > 1) resumeToolResults.push(textOf(results.at(-1) ?? {}));
        if (resumeStep === 1) return fauxToolCall("bash", { command: "pwd" });
        if (resumeStep === 2) return fauxToolCall("write", { path: "resumed.txt", content: "written on resume\n" });
        return "WT-2 done";
      },
    });
    return { firstPwd, resumeToolResults, resumeStep, last: textOf(agentResults({ messages: run.parentSession.messages } as Context).at(-1) ?? {}) };
  }

  for (const firstWrites of [true, false]) {
    it(`puts the worktree back and commits the resumed work to the agent's branch (first run ${firstWrites ? "changed files" : "changed nothing"})`, async () => {
      const { repo, git } = makeRepo();
      const { firstPwd, resumeToolResults, last } = await runWorktreeResume(repo, { firstWrites });

      expect(firstPwd).toMatch(/pi-agent-/);
      // The resumed run worked in its worktree, at the same path.
      expect(resumeToolResults[0]?.trim()).toBe(firstPwd);
      expect(resumeToolResults[0]).not.toMatch(/does not exist/);
      // Nothing outside the repo: the worktree is removed again, and the file
      // is neither in the main checkout nor left in a temp directory.
      expect(existsSync(firstPwd)).toBe(false);
      expect(existsSync(join(repo, "resumed.txt"))).toBe(false);
      // The resumed work is on the agent's branch, with the first run's work.
      const branch = /Changes saved to branch `([^`]+)`/.exec(last)?.[1];
      expect(branch).toMatch(/^pi-agent-/);
      const files = git("ls-tree", "--name-only", branch as string).split("\n");
      expect(files).toContain("resumed.txt");
      if (firstWrites) expect(files).toContain("first.txt");
      expect(git("worktree", "list").split("\n")).toHaveLength(1);
    });
  }

  it("refuses to resume when the agent's branch is gone, and runs nothing", async () => {
    const { repo, git } = makeRepo();
    const { firstPwd, resumeStep, last } = await runWorktreeResume(repo, {
      firstWrites: true,
      beforeResume: () => {
        for (const b of git("branch", "--list", "pi-agent-*", "--format=%(refname:short)").split("\n").filter(Boolean)) {
          git("branch", "-D", b);
        }
      },
    });

    expect(last).toMatch(/Cannot resume agent .* branch `pi-agent-[^`]+` no longer exists/);
    expect(resumeStep).toBe(0);
    expect(existsSync(firstPwd)).toBe(false);
    expect(readdirSync(repo)).not.toContain("resumed.txt");
  });
});

describe("resume after the record is evicted", () => {
  // The manager drops finished records ten minutes after they finish. Only
  // setInterval is faked — that is the cleanup timer — so the sessions, the
  // tools and the faux model run on real time.
  afterEach(() => vi.useRealTimers());

  /** Age a record past the cutoff and let the real cleanup timer evict it. */
  function evict(id: string) {
    const registry = (globalThis as Record<symbol, { getRecord(id: string): { completedAt?: number } | undefined }>)[
      Symbol.for("pi-subagents:manager")
    ];
    const record = registry.getRecord(id);
    if (!record) throw new Error(`no record ${id}`);
    record.completedAt = Date.now() - 11 * 60_000;
    vi.advanceTimersByTime(60_000);
    if (registry.getRecord(id)) throw new Error(`record ${id} was not evicted`);
  }

  for (const background of [false, true]) {
    it(`reopens the agent's session file under the same id (${background ? "background" : "foreground"} resume)`, async () => {
      vi.useFakeTimers({ toFake: ["setInterval"] });
      const childContexts: string[][] = [];
      let resumeResult = "";
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
            const id = agentIdIn(textOf(results[0])) as string;
            if (results.length === 1) {
              evict(id);
              return agentCall({ resume: id, prompt: "What was the codeword?", description: "resume", run_in_background: background });
            }
            if (results.length === 2) resumeResult = textOf(results[1]);
            return "Done.";
          }
          childContexts.push(ctx.messages.map((m) => `${m.role}:${textOf(m)}`));
          return childContexts.length === 1 ? "ACK-1" : "BANANA";
        },
      });

      expect(resumeResult).not.toMatch(/not found/i);
      expect(childContexts).toHaveLength(2);
      expect(childContexts[1]).toEqual([
        "user:CODEWORD BANANA. Reply ACK-1.",
        "assistant:ACK-1",
        "user:What was the codeword?",
      ]);
      // Same id: what the model holds keeps working.
      const firstId = agentIdIn(textOf(agentResults({ messages: run.parentSession.messages } as Context)[0]));
      expect(resumeResult).toContain(`Agent ID: ${firstId}`);
      expect(recordOf(run)?.status).toBe("completed");
    });
  }

  it("keeps the agent's worktree isolation when reopened", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const repo = mkdtempSync(join(tmpdir(), "wt-reopen-"));
    try {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString().trim();
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "README.md"), "x");
      git("add", "README.md");
      git("commit", "-q", "-m", "init");

      let phase: "first" | "resume" = "first";
      let firstPwd = "";
      const resumeToolResults: string[] = [];
      let step = 0;
      let last = "";
      run = await runPrintMode({
        prompt: "go",
        cwd: repo,
        live: false,
        maxModelCalls: 30,
        respond: (ctx) => {
          if (isParent(ctx)) {
            const results = agentResults(ctx);
            if (results.length === 0) {
              return agentCall({ description: "wt", prompt: "isolated", isolation: "worktree", run_in_background: false });
            }
            const id = agentIdIn(textOf(results[0])) as string;
            if (results.length === 1) {
              phase = "resume";
              evict(id);
              return agentCall({ resume: id, prompt: "more", description: "resume", run_in_background: false });
            }
            last = textOf(results[1]);
            return "Done.";
          }
          const results = ctx.messages.filter((m) => m.role === "toolResult");
          if (phase === "first") {
            if (results.length === 0) return fauxToolCall("bash", { command: "pwd" });
            if (results.length === 1) {
              firstPwd = textOf(results[0]).trim();
              return fauxToolCall("write", { path: "first.txt", content: "first\n" });
            }
            return "WT-1 done";
          }
          step++;
          if (step > 1) resumeToolResults.push(textOf(results.at(-1) ?? {}));
          if (step === 1) return fauxToolCall("bash", { command: "pwd" });
          if (step === 2) return fauxToolCall("write", { path: "resumed.txt", content: "resumed\n" });
          return "WT-2 done";
        },
      });

      expect(resumeToolResults[0]?.trim()).toBe(firstPwd);
      expect(existsSync(join(repo, "resumed.txt"))).toBe(false);
      const branch = /Changes saved to branch `([^`]+)`/.exec(last)?.[1] as string;
      expect(git("ls-tree", "--name-only", branch).split("\n")).toEqual(expect.arrayContaining(["first.txt", "resumed.txt"]));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

