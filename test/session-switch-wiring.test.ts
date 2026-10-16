/**
 * session-switch-wiring.test.ts — what the extension does with running
 * background agents at `session_shutdown`, driven through the real extension
 * with a mocked runner (session-switch-e2e.test.ts drives Pi's real runtime).
 *
 * A switch (`new`, `resume`, `fork`, `reload`) parks the manager for the next
 * instance, which adopts it if it starts the target session; `quit` stops
 * everything as before. An agent's results go to the session that started it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { takeParkedSubagents } from "../src/session-handoff.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const HANDOFF_KEY = Symbol.for("pi-subagents:handoff:@kushalkhemka/opensec-pi-subagents");

let hermetic: Hermetic | undefined;
let finishers: Array<() => void>;
const booted: Array<Map<string, any>> = [];

beforeEach(() => {
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
  finishers = [];
  vi.mocked(runAgent).mockReset();
  // Each run waits for the test to finish it — or for its abort.
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => new Promise((resolve) => {
    const session = {
      steer: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      messages: [],
      sessionManager: { getSessionFile: () => join(process.cwd(), `child-${opts.agentId}.jsonl`) },
      model: { provider: "anthropic", id: "claude-haiku", name: "Claude Haiku" },
    } as any;
    opts.onSessionCreated?.(session);
    const done = (text: string) => resolve({ responseText: text, session, aborted: false, steered: false } as any);
    finishers.push(() => done("BACKGROUND-RESULT"));
    opts.signal?.addEventListener("abort", () => done(""));
  }) as any);
});

afterEach(async () => {
  for (const finish of finishers) finish();
  for (const lifecycle of booted.splice(0)) await lifecycle.get("session_shutdown")?.();
  const parked = (globalThis as any)[HANDOFF_KEY];
  if (parked) {
    takeParkedSubagents(parked.reason === "reload" ? parked.sessionFile : parked.targetSessionFile);
    await parked.stop().catch(() => {});
  }
  delete (globalThis as any)[MANAGER_KEY];
  hermetic?.restore();
  hermetic = undefined;
});

/** A persisted parent session with a conversation, as Pi writes one. */
function sessionFile(): string {
  const manager = SessionManager.create(process.cwd(), process.cwd());
  manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() } as never);
  return manager.getSessionFile() as string;
}

/** A ctx for the session in `file` (undefined: a session kept in memory). */
function sessionCtx(file: string | undefined) {
  return ctx({
    sessionManager: {
      getSessionId: () => (file ? file.slice(-20) : "memory"),
      getBranch: () => (file ? SessionManager.open(file).getBranch() : []),
      ...(file ? { getSessionFile: () => file } : {}),
    },
  });
}

async function boot(file: string | undefined) {
  const b = makePi();
  subagentsExtension(b.pi);
  booted.push(b.lifecycle);
  const c = sessionCtx(file);
  await b.lifecycle.get("session_start")?.({ type: "session_start" }, c);
  return { ...b, ctx: c };
}

/** Leave the instance the way Pi does at a switch, without running its shutdown again later. */
async function shutDown(instance: { lifecycle: Map<string, any> }, event: Record<string, unknown>) {
  booted.splice(booted.indexOf(instance.lifecycle), 1);
  await instance.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", ...event });
}

async function spawnBackground(instance: Awaited<ReturnType<typeof boot>>): Promise<string> {
  const result = await instance.tools.get("Agent").execute(
    "tc-1", { prompt: "go", description: "long job", subagent_type: "general-purpose", run_in_background: true },
    undefined, undefined, instance.ctx,
  );
  await flush();
  const id = /Agent ID: (\S+)/.exec(textOf(result))?.[1];
  if (!id) throw new Error(textOf(result));
  return id;
}

const recordsIn = (file: string) => readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line))
  .filter((e) => e.customType === "subagents:record");
const appended = (pi: any, id: string) => pi.appendEntry.mock.calls.filter(([type, data]: [string, any]) => type === "subagents:record" && data.id === id);
const registry = () => (globalThis as any)[MANAGER_KEY];

describe("background agents at a session switch", () => {
  it("survive /reload: the reloaded instance shows the agent and reports it as its own", async () => {
    const file = sessionFile();
    const first = await boot(file);
    const id = await spawnBackground(first);

    await shutDown(first, { reason: "reload" });
    expect(appended(first.pi, id)).toEqual([]);

    const second = await boot(file);
    expect(registry().getRecord(id)?.status).toBe("running");

    finishers[0]();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(appended(second.pi, id)).toEqual([[
      "subagents:record",
      expect.objectContaining({ id, status: "completed", result: "BACKGROUND-RESULT" }),
    ]]);
    expect(appended(second.pi, id)[0][1].pending).toBeUndefined();
    expect(second.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification" }),
      expect.anything(),
    );
    expect(first.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("belong to the session that started them: another session neither sees nor hears them", async () => {
    const fileA = sessionFile();
    const fileB = sessionFile();
    const a = await boot(fileA);
    const id = await spawnBackground(a);

    await shutDown(a, { reason: "new", targetSessionFile: fileB });
    const b = await boot(fileB);
    expect(registry().getRecord(id)).toBeUndefined();
    const fetched = await b.tools.get("get_subagent_result").execute("tc-2", { agent_id: id }, undefined, undefined, b.ctx);
    expect(textOf(fetched)).toMatch(/not found/i);

    finishers[0]();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    expect(appended(b.pi, id)).toEqual([]);
    expect(recordsIn(fileA).find((e) => e.data.id === id)?.data).toMatchObject({ status: "completed", pending: true });
  });

  it("stop at a switch, as before, when their session is kept only in memory", async () => {
    const first = await boot(undefined);
    const id = await spawnBackground(first);

    await shutDown(first, { reason: "new", targetSessionFile: "/elsewhere.jsonl" });

    expect(appended(first.pi, id).at(-1)?.[1]).toMatchObject({ id, status: "stopped" });
    expect((globalThis as any)[HANDOFF_KEY]).toBeUndefined();
  });

  it("are stopped by the parking version's own code when another version starts the session", async () => {
    const fileA = sessionFile();
    const fileB = sessionFile();
    const a = await boot(fileA);
    const id = await spawnBackground(a);

    await shutDown(a, { reason: "new", targetSessionFile: fileB });
    (globalThis as any)[HANDOFF_KEY].version = "0.0.0-other";
    await boot(fileB);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((globalThis as any)[HANDOFF_KEY]).toBeUndefined();
    expect(recordsIn(fileA).filter((e) => e.data.id === id).at(-1)?.data).toMatchObject({ status: "stopped" });
  });

  it("are left alone by an instance that starts some other session", async () => {
    const fileA = sessionFile();
    const fileB = sessionFile();
    const fileC = sessionFile();
    const a = await boot(fileA);
    const id = await spawnBackground(a);

    await shutDown(a, { reason: "new", targetSessionFile: fileB });
    await boot(fileC);
    expect((globalThis as any)[HANDOFF_KEY]).toBeDefined();
    expect(recordsIn(fileA).some((e) => e.data.id === id)).toBe(false);
  });
});
