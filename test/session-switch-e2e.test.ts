/**
 * session-switch-e2e.test.ts — background agents keep running across a session
 * switch, through Pi's REAL session runtime.
 *
 * `AgentSessionRuntime` is what interactive Pi uses for `/new` and `/resume`:
 * it emits `session_shutdown` with the reason, disposes the session (stale
 * `pi` and ctx), loads the extension again for the next session and fires
 * `session_start`. A background agent started in session A must:
 *   - keep running while session B is open, invisible there;
 *   - record its result in A's file when it finishes, not notify B;
 *   - notify A when the user returns to it.
 * And quitting must still stop it and record it as stopped.
 *
 * No network: a faux model answers every call, and the child waits on a
 * promise the test resolves.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, type FauxResponseStep, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCwd } from "../src/output-file.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import { agentCall, type FauxReply, legacyContext } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });

const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string"
    ? m.content
    : ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");

function lastUser(ctx: Context): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    if (ctx.messages[i].role === "user") return textOf(ctx.messages[i] as { content?: unknown });
  }
  return "";
}

function agentResultsSince(ctx: Context, prompt: string): string[] {
  let start = 0;
  ctx.messages.forEach((m, i) => {
    if (m.role === "user" && textOf(m as { content?: unknown }) === prompt) start = i;
  });
  return ctx.messages.slice(start)
    .filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent")
    .map((m) => textOf(m as { content?: unknown }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function entriesOf(file: string): Array<{ type: string; customType?: string; data?: Record<string, unknown> }> {
  return readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

let home: string;
let cwd: string;
let prev: { agentDir?: string; home?: string; cwd: string };
let runtime: AgentSessionRuntime | undefined;
let faux: ReturnType<typeof registerFauxProvider>;
let release: () => void;
let released: Promise<void>;
/** Resolves once the child's model call is in flight (its session exists). */
let childStarted: Promise<void>;
let markChildStarted: () => void;
/** The parent's replies, by the last user message it saw. */
let parentTurns: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "subagents-switch-home-"));
  cwd = mkdtempSync(join(tmpdir(), "subagents-switch-cwd-"));
  prev = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME, cwd: process.cwd() };
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.HOME = home;
  process.chdir(cwd);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ outputTranscript: false }));
  released = new Promise((resolve) => { release = resolve; });
  childStarted = new Promise((resolve) => { markChildStarted = resolve; });
  parentTurns = [];
});

afterEach(async () => {
  release();
  try { await runtime?.dispose(); } catch { /* already disposed */ }
  runtime = undefined;
  faux?.unregister();
  delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  process.chdir(prev.cwd);
  if (prev.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prev.agentDir;
  if (prev.home === undefined) delete process.env.HOME;
  else process.env.HOME = prev.home;
  rmSync(join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd)), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** The scripted model: the parent starts one background agent; the agent waits for `release`. */
async function respond(ctx: Context): Promise<FauxReply> {
  const turn = lastUser(ctx);
  if (turn === "long-job") {
    markChildStarted();
    await released;
    return "LONG-JOB-RESULT";
  }
  parentTurns.push(turn);
  if (turn === "start" && agentResultsSince(ctx, "start").length === 0) {
    return agentCall({ prompt: "long-job", description: "long job", run_in_background: true });
  }
  if (turn.includes("finished while another session was open")) return "GOT THE RESULT";
  return "ok";
}

async function startRuntime(): Promise<AgentSessionRuntime> {
  faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  const model = faux.getModel();
  const step: FauxResponseStep = async (context) => {
    const reply = await respond(legacyContext(context));
    const content = typeof reply === "string" ? [fauxText(reply)] : Array.isArray(reply) ? reply : [reply];
    const hasToolCall = content.some((b) => (b as { type?: string }).type === "toolCall");
    return fauxAssistantMessage(content as never, { stopReason: hasToolCall ? "toolUse" : "stop" });
  };
  faux.setResponses(Array.from({ length: 64 }, () => step));
  const { modelRuntime } = fauxModelBackend(model);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: home,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: {
        additionalExtensionPaths: [EXTENSION_PATH],
        systemPromptOverride: () => "You orchestrate.",
        appendSystemPromptOverride: () => [],
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const created = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: home,
    sessionManager: SessionManager.create(cwd, join(home, "sessions")),
  });
  await created.session.bindExtensions({});
  return created;
}

/** Start the background agent in the open session; returns its id. */
async function spawnLongJob(rt: AgentSessionRuntime): Promise<string> {
  await rt.session.prompt("start");
  const results = rt.session.messages
    .filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent")
    .map((m) => textOf(m as { content?: unknown }));
  const id = /Agent ID: (\S+)/.exec(results.at(-1) ?? "")?.[1];
  if (!id) throw new Error(`no agent id in: ${results.join(" | ")}`);
  await childStarted;
  return id;
}

const registry = () => (globalThis as Record<symbol, { getRecord(id: string): { status?: string } | undefined } | undefined>)[MANAGER_KEY];

describe("a background agent across a session switch (real session runtime)", () => {
  it("keeps running in another session, records its result in its own, and notifies it on return", async () => {
    runtime = await startRuntime();
    const id = await spawnLongJob(runtime);
    const fileA = runtime.session.sessionFile as string;
    expect(registry()?.getRecord(id)?.status).toBe("running");

    await runtime.newSession();
    await runtime.session.bindExtensions({});
    const fileB = runtime.session.sessionFile as string;

    // Not stopped at the switch, and not this session's to see.
    expect(entriesOf(fileA).some((e) => e.customType === "subagents:record" && e.data?.id === id)).toBe(false);
    expect(registry()?.getRecord(id)).toBeUndefined();

    // Finishes while B is open: recorded in A for delivery, B hears nothing.
    release();
    expect(await waitFor(() => entriesOf(fileA).some((e) => e.customType === "subagents:record" && e.data?.id === id))).toBe(true);
    const recorded = entriesOf(fileA).find((e) => e.customType === "subagents:record" && e.data?.id === id);
    expect(recorded?.data).toMatchObject({ status: "completed", result: "LONG-JOB-RESULT", pending: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runtime.session.messages.map((m) => textOf(m as { content?: unknown })).join("\n")).not.toContain("LONG-JOB-RESULT");
    expect(parentTurns.some((turn) => turn.includes("finished while another session was open"))).toBe(false);

    // Back in A: the result is delivered, and the parent takes a turn on it.
    await runtime.switchSession(fileA);
    await runtime.session.bindExtensions({});
    expect(runtime.session.sessionFile).toBe(fileA);
    expect(await waitFor(() => parentTurns.some((turn) => turn.includes("finished while another session was open")))).toBe(true);
    const delivered = parentTurns.find((turn) => turn.includes("finished while another session was open")) ?? "";
    expect(delivered).toContain("LONG-JOB-RESULT");
    expect(delivered).toContain(`<task-id>${id}</task-id>`);
    expect(await waitFor(() => entriesOf(fileA).some((e) => e.customType === "subagents:delivered"))).toBe(true);
    // Shown in A again, as finished.
    expect(registry()?.getRecord(id)?.status).toBe("completed");
    expect(fileB).not.toBe(fileA);
  });

  it("quitting still stops a running background agent and records it as stopped", async () => {
    runtime = await startRuntime();
    const id = await spawnLongJob(runtime);
    const fileA = runtime.session.sessionFile as string;

    await runtime.dispose();
    runtime = undefined;

    const recorded = entriesOf(fileA).filter((e) => e.customType === "subagents:record" && e.data?.id === id).at(-1);
    expect(recorded?.data).toMatchObject({ status: "stopped", resume: expect.objectContaining({ id }) });
  });
});
