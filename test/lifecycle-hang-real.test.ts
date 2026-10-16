/**
 * A child whose tool ignores its AbortSignal, with the REAL runAgent, a real pi
 * session, a faux model and a real extension tool (test/fixtures/ext-hang.mjs).
 * No network, no provider keys.
 *
 * Pi awaits a running tool unconditionally, so `session.abort()` cannot end
 * such a run. Stop, Esc and the watchdog must still return, free the slot and
 * let queued agents proceed, and the agent must stay resumable.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setRememberAgents, setToolTimeoutSeconds, setWatchdogTiming } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const HANG_EXT = resolve(fileURLToPath(new URL("./fixtures/ext-hang.mjs", import.meta.url)));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hangStarts = () => (globalThis as { __extHangStarted?: number }).__extHangStarted ?? 0;

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

function lastUserText(context: { messages: Array<{ role: string; content: unknown }> }): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m.role !== "user") continue;
    return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  }
  return "";
}

describe("a child whose tool ignores the abort (real session)", () => {
  let faux: ReturnType<typeof registerFauxProvider>;
  let ctx: any;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const pi: any = { exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }) };
  let manager: AgentManager | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lifecycle-hang-"));
    for (const key of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "HOME"]) saved[key] = process.env[key];
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    process.env.PI_CODING_AGENT_SESSION_DIR = join(dir, "sessions");
    process.env.HOME = dir;
    setRememberAgents(true);
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    const model = faux.getModel();
    const { modelRegistry, modelRuntime } = fauxModelBackend(model);
    (modelRegistry as { runtime?: unknown }).runtime = modelRuntime;
    // A resumed prompt answers; anything else calls `hang` until a tool result exists.
    faux.setResponses(Array.from({ length: 64 }, () => (context: any) => {
      if (lastUserText(context).includes("RESUMED")) return fauxAssistantMessage([fauxText("resumed ok")], { stopReason: "stop" });
      const called = context.messages.some((m: any) => m.role === "toolResult");
      return called
        ? fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })
        : fauxAssistantMessage([fauxToolCall("hang", {})], { stopReason: "toolUse" });
    }));
    ctx = { cwd: dir, getSystemPrompt: () => "", model, modelRegistry };
    registerAgents(new Map([["hanger", {
      name: "hanger", description: "hanger", builtinToolNames: [], skills: false,
      extensions: [HANG_EXT], systemPrompt: "x", promptMode: "replace",
      inheritContext: false, runInBackground: false, isolated: false,
    } as unknown as AgentConfig]]));
  });

  afterEach(async () => {
    setToolTimeoutSeconds(1200);
    setWatchdogTiming({ slackMs: 60_000, intervalMs: 5_000, escalateMs: 30_000 });
    await manager?.dispose();
    manager = undefined;
  });

  afterAll(() => {
    faux.unregister();
    setRememberAgents(true);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("a stop frees the slot after the grace, fires the completion once, and the queued agent starts", async () => {
    const completions: string[] = [];
    manager = new AgentManager(r => completions.push(`${r.description}:${r.status}`), 1);
    manager.setStopGraceMs(300);
    const before = hangStarts();
    const a = manager.spawn(pi, ctx, "hanger", "go", { description: "A", isBackground: true });
    await waitFor(() => hangStarts() === before + 1);
    const b = manager.spawn(pi, ctx, "hanger", "go", { description: "B", isBackground: true });
    expect(manager.getRecord(b)!.status).toBe("queued");

    expect(manager.abort(a)).toBe(true);
    expect(manager.getRecord(a)!.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(a)!.promise;
    expect(completions).toEqual(["A:stopped"]);
    await waitFor(() => hangStarts() === before + 2); // B got A's slot and is in its own hang
    expect(manager.getRecord(b)!.status).toBe("running");

    manager.abort(b);
    const t0 = Date.now();
    await manager.waitForAll();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(completions).toEqual(["A:stopped", "B:stopped"]);
    expect(manager.hasRunning()).toBe(false);
  }, 30_000);

  it("Esc on a foreground call returns promptly with a stopped result", async () => {
    manager = new AgentManager(undefined, 10);
    const ac = new AbortController();
    const before = hangStarts();
    const pending = manager.spawnAndWait(pi, ctx, "hanger", "go", { description: "FG", signal: ac.signal });
    await waitFor(() => hangStarts() === before + 1);
    const t0 = Date.now();
    ac.abort();
    const { record } = await pending;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(record.status).toBe("stopped");
  }, 30_000);

  it("the watchdog escalates instead of aborting once: the run ends aborted and frees its slot", async () => {
    setToolTimeoutSeconds(1);
    setWatchdogTiming({ slackMs: 0, intervalMs: 100, escalateMs: 500 });
    const completions: string[] = [];
    manager = new AgentManager(r => completions.push(r.status), 1);
    const id = manager.spawn(pi, ctx, "hanger", "go", { description: "WD", isBackground: true });
    const t0 = Date.now();
    await manager.getRecord(id)!.promise;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(manager.getRecord(id)!.status).toBe("aborted");
    expect(completions).toEqual(["aborted"]);
    expect(manager.hasRunning()).toBe(false);
  }, 30_000);

  it("an abandoned agent is resumed by reopening its saved session", async () => {
    manager = new AgentManager(undefined, 5);
    manager.setStopGraceMs(200);
    const before = hangStarts();
    const id = manager.spawn(pi, ctx, "hanger", "go", { description: "R", isBackground: true });
    await waitFor(() => hangStarts() === before + 1);
    manager.abort(id);
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.sessionFile).toBeTruthy();

    const resumed = await manager.resume(id, "RESUMED: carry on", undefined, { pi, ctx });
    expect(resumed?.status).toBe("completed");
    expect(resumed?.result).toBe("resumed ok");
    expect(resumed?.id).toBe(id);
  }, 30_000);
});
