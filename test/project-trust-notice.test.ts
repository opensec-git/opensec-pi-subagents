/**
 * project-trust-notice.test.ts — a project the user has not trusted keeps its
 * agent files out (the default, `projectTrust: "pi"`), and says so: once at
 * session start, and in the `Agent` result when the model asks for one of them,
 * each time with how to trust the project. Without this, a project agent just
 * goes missing and a call for it quietly runs the fallback agent.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const HELPER = "---\ndescription: project helper\n---\n\nHELPER-PROMPT\n";

let booted: BootedPi | undefined;
let hermetic: Hermetic | undefined;

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  registerAgents(new Map());
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.mocked(runAgent).mockReset();
  vi.restoreAllMocks();
});

const notices = () => vi.mocked(console.warn).mock.calls.map(([message]) => String(message));

/** `global` goes to the global subagents.json: an untrusted project's own file is not read. */
async function boot(opts: { trusted: boolean; global?: Record<string, unknown> }) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  hermetic = hermeticDir({
    settings: { outputTranscript: false, schedulingEnabled: false },
    agentFiles: { helper: HELPER },
    trusted: opts.trusted,
  });
  if (opts.global) writeFileSync(join(getAgentDir(), "subagents.json"), JSON.stringify(opts.global));
  vi.mocked(runAgent).mockImplementation(async () => ({
    responseText: "ANSWER", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false,
  }));
  booted = makePi();
  subagentsExtension(booted.pi);
  // Headless, so the notice goes to the console.
  const parentCtx = ctx();
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parentCtx };
}

const callHelper = (b: BootedPi & { parentCtx: any }) =>
  b.tools.get("Agent").execute(
    "tc",
    { prompt: "Help.", description: "help", subagent_type: "helper", run_in_background: false },
    undefined, undefined, b.parentCtx,
  );

describe("project agents in a project the user has not trusted", () => {
  it("are not loaded, and session start says which and how to trust the project", async () => {
    await boot({ trusted: false });
    const matching = notices().filter((message) => message.includes("did not load this project's agents"));
    expect(matching).toHaveLength(1);
    const notice = matching[0];
    expect(notice).toContain("(helper)");
    expect(notice).toContain("/trust");
    expect(notice).toContain('"projectTrust": "full"');
  });

  it("names the agent in the Agent result when the call falls back", async () => {
    const b = await boot({ trusted: false });
    const text = textOf(await callHelper(b));
    expect(text).toContain('Unknown agent type "helper"');
    expect(text).toContain("not trusted in Pi");
    expect(text).toContain("/trust");
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toBe("general-purpose");
  });

  it("names the agent in the refusal when there is no fallback", async () => {
    const b = await boot({ trusted: false, global: { fallbackSubagent: "none" } });
    const result = await callHelper(b);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not trusted in Pi");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("are loaded once the project is trusted, with no notice", async () => {
    const b = await boot({ trusted: true });
    expect(notices().some((message) => message.includes("did not load this project's agents"))).toBe(false);
    const text = textOf(await callHelper(b));
    expect(text).not.toContain("Unknown agent type");
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toBe("helper");
  });

  it("are loaded in every project with projectTrust: \"full\"", async () => {
    const b = await boot({ trusted: false, global: { projectTrust: "full" } });
    await callHelper(b);
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toBe("helper");
  });
});
