/**
 * tool-args.test.ts — the argument shapes weak models send, repaired before
 * Pi validates them, and the ones that must be left alone.
 *
 * The last block drives a real faux-model turn, so the hook is shown to run in
 * Pi's own tool pipeline and not only when called by hand.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import {
  AGENT_ARG_SHAPE,
  NESTED_AGENT_ARG_SHAPE,
  RESULT_ARG_SHAPE,
  repairToolArgs,
  STEER_ARG_SHAPE,
} from "../src/tool-args.js";
import { type PrintModeRun, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

const VALID = { prompt: "Find the bug.", description: "find bug", subagent_type: "Explore" };

describe("repairToolArgs", () => {
  it("parses the whole arguments object sent as a JSON string", () => {
    expect(repairToolArgs(JSON.stringify(VALID), AGENT_ARG_SHAPE)).toEqual(VALID);
  });

  it("lifts the arguments object out of a string field that holds all of it", () => {
    const raw = { prompt: JSON.stringify({ ...VALID, run_in_background: "false" }) };
    expect(repairToolArgs(raw, AGENT_ARG_SHAPE)).toEqual({ ...VALID, run_in_background: false });
  });

  it("keeps outer fields the inner object does not override", () => {
    const raw = { prompt: JSON.stringify({ prompt: "inner" }), description: "outer", subagent_type: "Plan" };
    expect(repairToolArgs(raw, AGENT_ARG_SHAPE)).toEqual({ prompt: "inner", description: "outer", subagent_type: "Plan" });
  });

  it("leaves a prompt alone whose JSON is content, not this tool's arguments", () => {
    const content = JSON.stringify({ prompt: "x", payload: [1, 2] });
    const raw = { ...VALID, prompt: content };
    expect(repairToolArgs(raw, AGENT_ARG_SHAPE)).toBe(raw);
    const other = { ...VALID, prompt: JSON.stringify({ description: "only" }) };
    expect(repairToolArgs(other, AGENT_ARG_SHAPE)).toBe(other);
  });

  it("joins arrays sent for string fields: lines for the prompt, words elsewhere", () => {
    const raw = { prompt: ["Step one.", "Step two."], description: ["find", "bug"], subagent_type: "Explore" };
    expect(repairToolArgs(raw, AGENT_ARG_SHAPE)).toEqual({
      prompt: "Step one.\nStep two.",
      description: "find bug",
      subagent_type: "Explore",
    });
  });

  it("drops null optional fields and keeps a null required one for validation to report", () => {
    const raw = { ...VALID, name: null, model: null, max_turns: null, isolated: null, resume: null };
    expect(repairToolArgs(raw, AGENT_ARG_SHAPE)).toEqual(VALID);
    const missingPrompt = { prompt: null, description: "d", subagent_type: "Explore" };
    expect(repairToolArgs(missingPrompt, AGENT_ARG_SHAPE)).toBe(missingPrompt);
  });

  it("never invents a prompt", () => {
    const repaired = repairToolArgs({ description: "d" }, AGENT_ARG_SHAPE) as Record<string, unknown>;
    expect(repaired.prompt).toBeUndefined();
  });

  it("leaves a missing or null subagent_type to the default-type policy", () => {
    expect(repairToolArgs({ prompt: "p", description: "d" }, AGENT_ARG_SHAPE)).toEqual({ prompt: "p", description: "d", subagent_type: "" });
    expect(repairToolArgs({ prompt: "p", description: "d", subagent_type: null }, AGENT_ARG_SHAPE))
      .toEqual({ prompt: "p", description: "d", subagent_type: "" });
  });

  it("does not default a nested agent's type, which must name an allowed one", () => {
    const raw = { prompt: "p", description: "d" };
    expect(repairToolArgs(raw, NESTED_AGENT_ARG_SHAPE)).toBe(raw);
  });

  it("converts booleans and numbers sent as strings", () => {
    const raw = { ...VALID, run_in_background: "True", inherit_context: " false ", max_turns: "5" };
    expect(repairToolArgs(raw, AGENT_ARG_SHAPE)).toEqual({
      ...VALID,
      run_in_background: true,
      inherit_context: false,
      max_turns: 5,
    });
    expect(repairToolArgs({ agent_id: "a1", wait: "true" }, RESULT_ARG_SHAPE)).toEqual({ agent_id: "a1", wait: true });
  });

  it("leaves strings that are not booleans or numbers for validation to report", () => {
    const raw = { ...VALID, run_in_background: "yes", max_turns: "five" };
    expect(repairToolArgs(raw, AGENT_ARG_SHAPE)).toBe(raw);
  });

  it("turns a numeric id into a string and joins a multi-line steer message", () => {
    expect(repairToolArgs({ agent_id: 42, message: ["Stop.", "Report now."] }, STEER_ARG_SHAPE))
      .toEqual({ agent_id: "42", message: "Stop.\nReport now." });
  });

  it("returns valid arguments unchanged, by identity", () => {
    expect(repairToolArgs(VALID, AGENT_ARG_SHAPE)).toBe(VALID);
    expect(repairToolArgs("not json", AGENT_ARG_SHAPE)).toBe("not json");
    expect(repairToolArgs(null, AGENT_ARG_SHAPE)).toBeNull();
  });
});

describe("the tools' prepareArguments hooks", () => {
  function registeredTools() {
    const tools = new Map<string, any>();
    subagentsExtension({
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((t: any) => tools.set(t.name, t)),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any);
    return tools;
  }

  it("turn malformed arguments into ones the schema accepts", () => {
    const tools = registeredTools();
    const cases: Array<[string, unknown]> = [
      ["Agent", JSON.stringify({ ...VALID, run_in_background: "false", max_turns: "3" })],
      ["Agent", { prompt: ["a", "b"], description: "d", subagent_type: null, name: null }],
      ["get_subagent_result", { agent_id: "x", wait: "false", verbose: null }],
      ["steer_subagent", { agent_id: 7, message: ["one", "two"] }],
    ];
    for (const [name, raw] of cases) {
      const tool = tools.get(name);
      const prepared = tool.prepareArguments(raw);
      expect(Compile(tool.parameters).Check(prepared), `${name}: ${JSON.stringify(prepared)}`).toBe(true);
    }
  });
});

describe("Pi runs the repair before validating a real tool call", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  function agentToolResult(session: AgentSession): string {
    const msg = [...session.messages].reverse().find(
      (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
    );
    return ((msg?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
  }

  it("spawns from an Agent call with a missing type, an array prompt and string flags", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: fauxAssistantMessage([
          fauxToolCall("Agent", {
            prompt: ["Say hi.", "Then stop."],
            description: "greet",
            run_in_background: "false",
            max_turns: "3",
            name: null,
          }),
        ]),
        parentFinal: "parent done",
        subagent: "CHILD-ANSWER",
      }),
      live: false,
    });

    const result = agentToolResult(run.parentSession);
    expect(result).not.toContain("Validation failed");
    expect(result).toContain("CHILD-ANSWER");
    expect(result).toContain("Note: No agent type given — using general-purpose.");
  }, 30_000);
});
