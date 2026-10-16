/**
 * Releasing a finished child session, with the REAL runAgent, a real pi
 * session, a faux model and a real extension (test/fixtures/ext-shutdown-probe.mjs)
 * that counts the session_shutdown events it receives. No network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setRememberAgents } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const PROBE_EXT = resolve(fileURLToPath(new URL("./fixtures/ext-shutdown-probe.mjs", import.meta.url)));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const shutdowns = () => (globalThis as { __extShutdownProbe?: number }).__extShutdownProbe ?? 0;

function lastUserText(context: { messages: Array<{ role: string; content: unknown }> }): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  }
  return "";
}

describe("a finished child session is released (real session)", () => {
  let faux: ReturnType<typeof registerFauxProvider>;
  let ctx: any;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const pi: any = { exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }) };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "session-release-real-"));
    for (const key of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "HOME"]) saved[key] = process.env[key];
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    process.env.PI_CODING_AGENT_SESSION_DIR = join(dir, "sessions");
    process.env.HOME = dir;
    setRememberAgents(true);
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    const model = faux.getModel();
    const { modelRegistry, modelRuntime } = fauxModelBackend(model);
    (modelRegistry as { runtime?: unknown }).runtime = modelRuntime;
    faux.setResponses(Array.from({ length: 16 }, () => (context: any) =>
      fauxAssistantMessage([fauxText(lastUserText(context).includes("RESUMED") ? "resumed ok" : "first answer")], { stopReason: "stop" })));
    ctx = { cwd: dir, getSystemPrompt: () => "", model, modelRegistry };
    registerAgents(new Map([["prober", {
      name: "prober", description: "prober", builtinToolNames: [], skills: false,
      extensions: [PROBE_EXT], systemPrompt: "x", promptMode: "replace",
      inheritContext: false, runInBackground: false, isolated: false,
    } as unknown as AgentConfig]]));
  });

  afterAll(() => {
    faux.unregister();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("shuts the child's extensions down once, keeps the transcript, and resumes from the file", async () => {
    const manager = new AgentManager(undefined, 5);
    manager.setSessionReleaseMs(0);
    try {
      const before = shutdowns();
      const id = manager.spawn(pi, ctx, "prober", "go", { description: "P", isBackground: true });
      await manager.getRecord(id)!.promise;
      const first = manager.getRecord(id)!;
      expect(first.result).toBe("first answer");
      for (let i = 0; i < 50 && shutdowns() === before; i++) await sleep(20);
      expect(shutdowns()).toBe(before + 1); // released right after it settled
      expect(first.session?.messages.some(m => m.role === "assistant")).toBe(true);

      const resumed = await manager.resume(id, "RESUMED: one more thing", undefined, { pi, ctx });
      expect(resumed?.id).toBe(id);
      expect(resumed?.result).toBe("resumed ok");
      // The reopened session carries the first run's history.
      expect(resumed?.session?.messages.filter(m => m.role === "user")).toHaveLength(2);
    } finally {
      await manager.dispose();
    }
  }, 30_000);
});
