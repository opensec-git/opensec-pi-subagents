/**
 * resume-restart.test.ts — agents stay resumable across a restart or session
 * switch. Pi rebuilds the extension on every session replacement, so all that
 * survives is what the extension wrote into the parent session: the
 * `subagents:record` entries, which now carry each agent's resume state.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
const booted: Array<Map<string, any>> = [];

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
});

afterEach(async () => {
  for (const lifecycle of booted.splice(0)) await lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  hermetic?.restore();
  hermetic = undefined;
});

function sessionPath() {
  const path = join(process.cwd(), "agent-session.jsonl");
  writeFileSync(path, `${JSON.stringify({
    type: "session", version: 3, id: "0b9f3c1e-2a4d-4c8e-9f10-1a2b3c4d5e6f",
    timestamp: new Date(0).toISOString(), cwd: process.cwd(),
  })}\n`);
  return path;
}

/** A session object as runAgent hands it to onSessionCreated. */
function fakeSession(file: string) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    sessionManager: { getSessionFile: () => file },
    model: { provider: "anthropic", id: "claude-haiku", name: "Claude Haiku" },
  } as any;
}

/** Boot an extension instance, as pi does for each session, and start its session. */
async function bootSession(branch: unknown[] = []) {
  const b = makePi();
  subagentsExtension(b.pi);
  booted.push(b.lifecycle);
  await b.lifecycle.get("session_start")?.({}, ctx({ sessionManager: { getSessionId: () => "s1", getBranch: () => branch } }));
  return b;
}

/** What the extension appended to its session, as session entries. */
function entriesOf(pi: any): unknown[] {
  return pi.appendEntry.mock.calls.map(([customType, data]: [string, unknown]) => ({ type: "custom", customType, data }));
}

describe("resume across a session switch or restart", () => {
  it("rebuilds a finished agent from the session's records and resumes it by id, keeping its handle", async () => {
    const file = sessionPath();
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      const session = fakeSession(file);
      opts.onSessionCreated?.(session);
      return { responseText: "first answer", session, aborted: false, steered: false } as any;
    });

    const first = await bootSession();
    const spawned = await first.tools.get("Agent").execute(
      "tc-1", { prompt: "go", description: "audit", subagent_type: "Explore", run_in_background: true, isolated: true },
      undefined, undefined, ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    await flush();
    const entries = entriesOf(first.pi);
    expect(entries.at(-1)).toMatchObject({
      customType: "subagents:record",
      data: { id, resume: { id, sessionFile: file, handle: "explore", isolated: true, model: "anthropic/claude-haiku" } },
    });
    await first.lifecycle.get("session_shutdown")?.();
    booted.length = 0;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];

    // A new extension instance, as after a restart or `/resume`.
    const second = await bootSession(entries);
    vi.mocked(runAgent).mockClear();
    const resumed = await second.tools.get("Agent").execute(
      "tc-2", { resume: id, prompt: "and then?", description: "resume", subagent_type: "Explore", run_in_background: false },
      undefined, undefined, ctx(),
    );

    expect(textOf(resumed)).not.toMatch(/not found/i);
    expect(textOf(resumed)).toContain(`Agent ID: ${id}`);
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(), "Explore", "and then?",
      expect.objectContaining({ agentId: id, resumeSessionFile: file, isolated: true }),
    );
    // The handle is held too, so a new Explore does not take it.
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(registry.getRecord(id)?.handle).toBe("explore");
  });

  it("forgets the agents when the new session has no records (/new)", async () => {
    const second = await bootSession([]);
    const resumed = await second.tools.get("Agent").execute(
      "tc", { resume: "nope-1", prompt: "x", description: "r", subagent_type: "Explore", run_in_background: false },
      undefined, undefined, ctx(),
    );
    expect(textOf(resumed)).toMatch(/Agent not found/);
  });

  it("records an agent still running at shutdown as stopped and resumable", async () => {
    const file = sessionPath();
    vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => new Promise((resolve) => {
      const session = fakeSession(file);
      opts.onSessionCreated?.(session);
      opts.signal?.addEventListener("abort", () => resolve({ responseText: "", session, aborted: false, steered: false } as any));
    }) as any);

    const first = await bootSession();
    const spawned = await first.tools.get("Agent").execute(
      "tc-1", { prompt: "go", description: "long job", subagent_type: "Explore", run_in_background: true },
      undefined, undefined, ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    await flush();
    await first.lifecycle.get("session_shutdown")?.();
    booted.length = 0;

    const last = entriesOf(first.pi).filter((e: any) => e.data?.id === id).at(-1) as any;
    expect(last.data.status).toBe("stopped");
    expect(last.data.resume).toMatchObject({ id, sessionFile: file });
  });
});
