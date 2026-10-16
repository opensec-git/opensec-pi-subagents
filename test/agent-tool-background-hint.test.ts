import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("Agent");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const HINT = "(ctrl+b to run in background)";

/** A running foreground row, as `streamUpdate` reports it. */
function renderRunning(details: Record<string, unknown>): string {
  return agentTool().renderResult(
    {
      content: [{ type: "text", text: "3 tool uses..." }],
      details: { displayName: "Agent", description: "job", subagentType: "general-purpose", toolUses: 3, tokens: "", status: "running", spinnerFrame: 0, ...details },
    },
    { expanded: false, isPartial: true },
    theme,
    { isError: false },
  ).render(120).join("\n");
}

describe("Agent tool — ctrl+b hint on a running foreground call", () => {
  it("appears on the hinted row once its call has run for 2s, as in Claude Code", () => {
    expect(renderRunning({ backgroundHint: true, durationMs: 2000 })).toContain(HINT);
  });

  it("does not flash on a call that finishes quickly", () => {
    expect(renderRunning({ backgroundHint: true, durationMs: 1999 })).not.toContain(HINT);
  });

  it("is not shown on a row without the hint", () => {
    // Still queued, already handed off, or a later call in the same batch.
    expect(renderRunning({ backgroundHint: false, durationMs: 60_000 })).not.toContain(HINT);
  });
});
