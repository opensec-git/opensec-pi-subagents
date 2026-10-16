import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { ViewerBackgroundAction } from "../src/ui/conversation-viewer.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

// The transcript is drawn with Pi's components, which read Pi's global theme.
initTheme("dark", false);

// ── Helpers ────────────────────────────────────────────────────────────

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("ConversationViewer invocation line", () => {
  /** The `↳` metadata row for a record, or "" when the viewer renders none. */
  function invocationLine(invocation: AgentRecord["invocation"]): string {
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), mockRecord({ invocation }), undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(),
    );
    // The row arrives inside the overlay's frame, padded out to the right
    // border; what is under test is the metadata it carries.
    const row = viewer.render(200).find(l => l.includes("↳"));
    return row ? row.slice(row.indexOf("↳")).replace(/\s*│\s*$/, "") : "";
  }

  // The canonical id, not the short label the widget uses: this overlay is
  // opened to inspect one agent and has the width to disambiguate providers.
  it("names the model with its provider", () => {
    expect(invocationLine({
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      maxTurns: 60,
    })).toBe("↳ anthropic/claude-sonnet-4-6 · thinking: high · max turns: 60");
  });

  it("falls back to the short label when no canonical id was captured", () => {
    expect(invocationLine({ modelName: "sonnet 4.6", thinking: "high" }))
      .toBe("↳ sonnet 4.6 · thinking: high");
  });

  it("discloses a model and level the run did not honor", () => {
    expect(invocationLine({
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      requestedModel: "google/gemini-3-pro",
      thinking: "low",
      requestedThinking: "max",
    })).toBe("↳ anthropic/claude-haiku-4-5 (asked google/gemini-3-pro) · thinking: low (asked max)");
  });

  it("renders no row at all for a record with no invocation", () => {
    expect(invocationLine(undefined)).toBe("");
  });
});

describe("ConversationViewer cost display", () => {
  /** The header line, with a cost of `cost` on the record and showCost `on`. */
  function header(on: boolean, cost: number): string {
    const record = mockRecord({
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
    } as Partial<AgentRecord>);
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), record, undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(), undefined, undefined, undefined, on,
    );
    return viewer.render(200).join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    // The viewer opens on finished agents, whose live activity entry is gone —
    // so this reads the record, and would show nothing if it did not.
    const out = header(true, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const out = header(false, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).not.toContain("$");
  });

  it("shows no cost for a model with no pricing data", () => {
    expect(header(true, 0)).not.toContain("$");
  });
});

describe("ConversationViewer", () => {
  it("closes with Ctrl+C when not composing", () => {
    const done = vi.fn();
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), mockRecord(), undefined, ansiTheme(), done,
    );

    viewer.handleInput("\x03");

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(undefined);
  });

  describe("render width safety", () => {
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("keeps bordered rows exact-width at a double-width truncation boundary", () => {
      const width = 40;
      for (let prefixLength = 0; prefixLength < width; prefixLength++) {
        const viewer = new ConversationViewer(
          mockTui(30, width),
          mockSession([]),
          mockRecord({ description: `${"a".repeat(prefixLength)}界more` }),
          undefined,
          ansiTheme(),
          vi.fn(),
        );

        for (const line of viewer.render(width)) {
          expect(
            visibleWidth(line),
            `prefix ${prefixLength} produced an under-width bordered row: ${JSON.stringify(line)}`,
          ).toBe(width);
        }
      }
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("Pi rendering", () => {
    /** ANSI stripped, so an assertion is about the text and not the styling. */
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

    const toolCall = [
      { role: "user", content: "check the file", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "# Reading" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "seq 1 40" } }],
        stopReason: "toolUse",
        timestamp: 0,
      },
      {
        role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, timestamp: 0,
        content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `out ${i + 1}`).join("\n") }],
      },
    ];

    function viewerFor(messages: any[], record = mockRecord({ status: "completed" }), onStop?: () => void, onSteer?: (m: string) => void) {
      return new ConversationViewer(mockTui(200, 80), mockSession(messages), record, undefined, ansiTheme(), vi.fn(), onStop, undefined, onSteer);
    }

    it("renders assistant Markdown and the tool call with its arguments", () => {
      const out = strip(viewerFor(toolCall).render(80).join("\n"));
      expect(out).toContain("Reading");
      expect(out).not.toContain("# Reading");
      expect(out).toContain("$ seq 1 40");
      expect(out).not.toContain("[Tool:");
    });

    it("ctrl+o expands and collapses tool output, and the footer says which", () => {
      const viewer = viewerFor(toolCall);
      const collapsed = strip(viewer.render(80).join("\n"));
      expect(collapsed).toContain("out 40");
      expect(collapsed).not.toContain("out 1\n");
      expect(collapsed).toContain("ctrl+o expand");

      viewer.handleInput("\x0f");
      const expanded = strip(viewer.render(80).join("\n"));
      expect(expanded).toMatch(/out 1 /);
      expect(expanded).toContain("ctrl+o collapse");

      viewer.handleInput("\x0f");
      expect(strip(viewer.render(80).join("\n"))).toBe(collapsed);
    });

    it("no longer has an `m` key", () => {
      const viewer = viewerFor(toolCall);
      const before = viewer.render(80);
      viewer.handleInput("m");
      expect(viewer.render(80)).toEqual(before);
      expect(strip(before.join("\n"))).not.toMatch(/\bm (raw|md)/);
    });

    it("the expand key disarms a pending stop rather than confirming it", () => {
      const onStop = vi.fn();
      const viewer = viewerFor(toolCall, mockRecord({ status: "running" }), onStop);
      viewer.handleInput("x");
      viewer.handleInput("\x0f");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("keeps the footer's navigation hints intact at 80 columns", () => {
      const viewer = viewerFor(toolCall, mockRecord({ status: "running" }), vi.fn(), vi.fn());
      const lines = viewer.render(80);
      const footer = strip(lines[lines.length - 2]);

      expect(footer).toContain("Enter steer");
      expect(footer).toContain("x stop");
      expect(footer).toContain("Esc close");
      assertAllLinesFit(lines, 80);
      // The expand hint is the first to go; Pi's components show the key beside collapsed output anyway.
      expect(footer).not.toContain("ctrl+o");
      expect(strip(viewer.render(120).at(-2) ?? "")).toContain("ctrl+o expand");
    });

    it("clamps a renderer's overwidth lines to the content width", () => {
      const w = 80;
      const session = mockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "wide", arguments: {} }], stopReason: "toolUse", timestamp: 0 },
      ]);
      // A tool renderer is extension code; one that ignores the width must not crash Pi's TUI.
      session.getToolDefinition = () => ({
        renderCall: () => ({ render: () => ["W".repeat(w + 50), `\x1b[1m${"V".repeat(w + 30)}\x1b[0m`], invalidate: () => {} }),
      });
      const viewer = new ConversationViewer(mockTui(30, w), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const content = viewer.buildContentLines(w - 4);
      expect(content.some(l => l.includes("WWW"))).toBe(true);
      assertAllLinesFit(content, w - 4);
      assertAllLinesFit(viewer.render(w), w);
    });
  });

  describe("stop key", () => {
    const W = 80;

    it("two-press x stops a running agent (first arms, second aborts)", () => {
      const onStop = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      // Idle footer offers the stop affordance.
      expect(viewer.render(W).join("\n")).toContain("x stop");

      // First press arms (no abort yet) and re-renders.
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");

      // Second press aborts.
      viewer.handleInput("x");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("any other key disarms the confirm", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");                       // arm
      viewer.handleInput("j");                       // scroll → disarm
      expect(viewer.render(W).join("\n")).toContain("x stop");
      expect(viewer.render(W).join("\n")).not.toContain("x again to STOP");

      viewer.handleInput("x");                       // arms again, does NOT stop
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not offer or perform stop once the agent is no longer running", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("no stop affordance when no onStop handler is provided (read-only history)", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
    });
  });

  describe("background key", () => {
    const W = 80;

    const backgroundViewer = (record: AgentRecord, action?: ViewerBackgroundAction, width = W) =>
      new ConversationViewer(
        mockTui(30, width), mockSession([]), record, undefined, ansiTheme(),
        vi.fn(), vi.fn(), undefined, vi.fn(), false, action,
      );

    /** An action available until it is sent, as the extension's is. */
    const oneShotAction = () => {
      let available = true;
      const send = vi.fn(() => { available = false; });
      return { available: () => available, send };
    };

    it("offers b while the owner says the run can be handed off, and sends once", () => {
      const action = oneShotAction();
      const viewer = backgroundViewer(mockRecord({ status: "running" }), action);

      expect(viewer.render(W).join("\n")).toContain("b bg");
      viewer.handleInput("b");
      expect(action.send).toHaveBeenCalledTimes(1);

      expect(viewer.render(W).join("\n")).not.toContain("b bg");
      viewer.handleInput("b");
      expect(action.send).toHaveBeenCalledTimes(1);
    });

    it("hides and ignores b when the owner says it is unavailable", () => {
      // The record alone cannot say: a blocking, running agent-generator spawn
      // has no tool call to release. Only the owner's answer counts.
      const send = vi.fn();
      const viewer = backgroundViewer(
        mockRecord({ status: "running", blocking: true }), { available: () => false, send },
      );
      expect(viewer.render(W).join("\n")).not.toContain("b bg");
      viewer.handleInput("b");
      expect(send).not.toHaveBeenCalled();
    });

    it("omits b entirely when no action is supplied", () => {
      const viewer = backgroundViewer(mockRecord({ status: "running", blocking: true }), undefined);
      expect(viewer.render(W).join("\n")).not.toContain("b bg");
      expect(() => viewer.handleInput("b")).not.toThrow();
    });

    it("keeps the footer within width at 80 columns with every action showing", () => {
      const viewer = backgroundViewer(mockRecord({ status: "running" }), oneShotAction(), 80);
      const lines = viewer.render(80);
      const footer = lines.find(l => l.includes("b bg"));
      expect(footer).toBeDefined();
      expect(footer).toContain("Enter steer");
      expect(footer).toContain("x stop");
      assertAllLinesFit(lines, 80);
    });
  });

  describe("steer composer", () => {
    const W = 80;

    function makeViewer(opts: { status?: AgentRecord["status"]; onSteer?: (m: string) => void } = {}) {
      const onSteer = opts.onSteer ?? vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: opts.status ?? "running" }),
        undefined, ansiTheme(), vi.fn(), undefined, undefined, onSteer,
      );
      return { viewer, tui, onSteer };
    }

    it("offers the steer affordance for a running agent and opens on Enter", () => {
      const { viewer } = makeViewer();
      expect(viewer.render(W).join("\n")).toContain("Enter steer");

      viewer.handleInput("\r"); // Enter
      // Composer is shown (its prompt + send/cancel hint), idle footer is gone.
      const out = viewer.render(W).join("\n");
      expect(out).toContain("Enter send · Esc cancel");
      expect(out).not.toContain("Enter steer");
    });

    it("typing then Enter sends the trimmed message and closes the composer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "  hello  ") viewer.handleInput(ch);
      viewer.handleInput("\r"); // send

      expect(onSteer).toHaveBeenCalledWith("hello");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("Esc cancels the composer without sending", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "draft") viewer.handleInput(ch);
      viewer.handleInput("\x1b"); // Esc

      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
    });

    it("an empty submit just returns (like Esc), without calling onSteer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("\r"); // empty submit
      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("scroll keys are inert while composing (input owns them)", () => {
      const { viewer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      // 'j' would normally scroll, but here it types into the composer.
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("Enter send · Esc cancel");
    });

    it("no steer affordance once the agent is no longer running", () => {
      const { viewer, onSteer } = makeViewer({ status: "completed" });
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      viewer.handleInput("\r");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
      expect(onSteer).not.toHaveBeenCalled();
    });

    it("no steer affordance when no onSteer handler is provided", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      expect(() => viewer.handleInput("\r")).not.toThrow();
    });

    it("composer rows never exceed width", () => {
      for (const w of [40, 80, 120]) {
        const tui = mockTui(30, w);
        const viewer = new ConversationViewer(
          tui, mockSession(), mockRecord({ status: "running" }),
          undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
        );
        viewer.handleInput("\r"); // open composer
        for (const ch of "x".repeat(200)) viewer.handleInput(ch);
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });
});
