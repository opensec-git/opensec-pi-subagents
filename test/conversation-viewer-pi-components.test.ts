/**
 * conversation-viewer-pi-components.test.ts — the viewer draws a subagent's
 * transcript exactly as Pi's main session draws its own.
 *
 * `piChat` below builds the transcript the way Pi's interactive mode does
 * (`renderSessionItems` / `addMessageToChat`, and the `message_*` /
 * `tool_execution_*` handlers for a live turn in `interactive-mode.js`): the
 * same components, constructor arguments, spacers and tool definitions, in a
 * pi-tui Container. The viewer's content lines must equal that Container's
 * render, minus the OSC 133 prompt marks the viewer drops (its own frame).
 */
import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  initTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

initTheme("dark", false);

const CWD = "/tmp/viewer-parity";
const definitions: Record<string, any> = {
  read: createReadToolDefinition(CWD),
  edit: createEditToolDefinition(CWD),
  bash: createBashToolDefinition(CWD),
  write: createWriteToolDefinition(CWD),
};
const markdownTheme = () => ({ ...getMarkdownTheme(), codeBlockIndent: "  " });
const ui = { requestRender: () => {} } as unknown as TUI;
const OSC133 = /\x1b\]133;[A-Z]\x07/g;

const PARA = "The subagent read the module and found that the render path rebuilds its content on every frame, which is fine until it is not.";
const FILE = Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i};`).join("\n");

/** One of everything Pi draws: thinking, text, read/edit/bash/write calls (one failing), bash, compaction, … */
function transcript(): any[] {
  return [
    { role: "user", content: `Fix the parser. ${PARA}`, timestamp: 0 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The parser lives in src/parse.ts; read it first." },
        { type: "text", text: `## Plan\n\n${PARA}\n\n- read\n- edit\n\n\`\`\`ts\nconst x = parse(input);\n\`\`\`` },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/parse.ts" } },
        { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "npm test -- parse", timeout: 60 } },
      ],
      stopReason: "toolUse",
      timestamp: 0,
    },
    { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: FILE }], isError: false, timestamp: 0, durationMs: 4 },
    {
      role: "toolResult", toolCallId: "bash-1", toolName: "bash", isError: true, timestamp: 0, durationMs: 2300,
      content: [{ type: "text", text: `${Array.from({ length: 12 }, (_, i) => `test ${i} ok`).join("\n")}\nFAIL parse handles empty input\n\nCommand exited with code 1` }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Found it: the empty case." },
        { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/parse.ts", edits: [{ oldText: "if (input)", newText: "if (input !== undefined)" }] } },
        { type: "toolCall", id: "write-1", name: "write", arguments: { path: "test/parse-empty.test.ts", content: "it('parses empty', () => {});\n" } },
      ],
      stopReason: "toolUse",
      timestamp: 0,
    },
    {
      role: "toolResult", toolCallId: "edit-1", toolName: "edit", isError: false, timestamp: 0, durationMs: 3,
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/parse.ts." }],
      details: { diff: "  3 export function parse(input) {\n- 4   if (input) {\n+ 4   if (input !== undefined) {\n  5     return tokens(input);", firstChangedLine: 4 },
    },
    { role: "toolResult", toolCallId: "write-1", toolName: "write", isError: true, timestamp: 0, content: [{ type: "text", text: "EACCES: permission denied, open 'test/parse-empty.test.ts'" }] },
    { role: "bashExecution", command: "git diff --stat", output: " src/parse.ts | 2 +-\n 1 file changed", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
    { role: "bashExecution", command: "false", output: "", exitCode: 1, cancelled: false, truncated: false, timestamp: 0 },
    { role: "compactionSummary", summary: "## Goal\nFix the parser.\n\n## Done\n- found the empty case", tokensBefore: 48_211, timestamp: 0 },
    { role: "branchSummary", summary: "Tried a regex first; abandoned.", fromId: "e1", timestamp: 0 },
    { role: "custom", customType: "note", content: "A note from an extension.", display: true, timestamp: 0 },
    { role: "custom", customType: "hidden", content: "not shown", display: false, timestamp: 0 },
    { role: "user", content: `<skill name="tdd" location="/skills/tdd.md">\nWrite the test first.\n</skill>\n\nnow add the test`, timestamp: 0 },
    { role: "system", content: "system prompt", timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/never.ts" } }],
      stopReason: "aborted",
      timestamp: 0,
    },
    { role: "assistant", content: [{ type: "text", text: "Done: the parser accepts **empty** input." }], stopReason: "stop", timestamp: 0 },
  ];
}

/** Pi's chat for `messages`, built as `InteractiveMode.renderSessionItems` builds it. */
function piChat(messages: any[], expanded = false) {
  const chat = new Container();
  const expandable: { setExpanded(e: boolean): void }[] = [];
  const pending = new Map<string, ToolExecutionComponent>();
  const add = (message: any) => {
    switch (message.role) {
      case "bashExecution": {
        const component = new BashExecutionComponent(message.command, ui, message.excludeFromContext, 1);
        if (message.output) component.appendOutput(message.output);
        component.setComplete(message.exitCode, message.cancelled, message.truncated ? ({ truncated: true } as any) : undefined, message.fullOutputPath);
        expandable.push(component);
        chat.addChild(component);
        break;
      }
      case "custom": {
        if (!message.display) break;
        const component = new CustomMessageComponent(message, undefined, markdownTheme(), 1);
        expandable.push(component);
        chat.addChild(component);
        break;
      }
      case "compactionSummary": {
        chat.addChild(new Spacer(1));
        const component = new CompactionSummaryMessageComponent(message, markdownTheme(), 1);
        expandable.push(component);
        chat.addChild(component);
        break;
      }
      case "branchSummary": {
        chat.addChild(new Spacer(1));
        const component = new BranchSummaryMessageComponent(message, markdownTheme(), 1);
        expandable.push(component);
        chat.addChild(component);
        break;
      }
      case "user": {
        const text = typeof message.content === "string" ? message.content : message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        if (!text) break;
        if (chat.children.length > 0) chat.addChild(new Spacer(1));
        const skill = parseSkillBlock(text);
        if (skill) {
          const component = new SkillInvocationMessageComponent(skill, markdownTheme(), 1);
          expandable.push(component);
          chat.addChild(component);
          if (skill.userMessage) {
            chat.addChild(new Spacer(1));
            chat.addChild(new UserMessageComponent(skill.userMessage, markdownTheme(), 1, []));
          }
        } else {
          chat.addChild(new UserMessageComponent(text, markdownTheme(), 1, []));
        }
        break;
      }
      case "assistant":
        chat.addChild(new AssistantMessageComponent(message, false, markdownTheme(), "Thinking...", 1, []));
        break;
    }
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      add(message);
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        const component = new ToolExecutionComponent(content.name, content.id, content.arguments, { showImages: false, outputPad: 1 }, definitions[content.name], ui, CWD);
        expandable.push(component);
        chat.addChild(component);
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          component.updateResult({ content: [{ type: "text", text: message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error" }], isError: true });
        } else {
          pending.set(content.id, component);
        }
      }
    } else if (message.role === "toolResult") {
      const component = pending.get(message.toolCallId);
      if (component) {
        component.updateResult(message);
        pending.delete(message.toolCallId);
      }
    } else {
      add(message);
    }
  }
  for (const component of expandable) component.setExpanded(expanded);
  return {
    chat,
    pending,
    expandable,
    lines: (width: number) => chat.render(width).map(line => line.replace(OSC133, "")),
  };
}

function makeSession(messages: any[]) {
  const listeners: ((event: any) => void)[] = [];
  const session = {
    messages,
    state: { streamingMessage: undefined as any, pendingToolCalls: new Set<string>() },
    subscribe: (listener: (event: any) => void) => { listeners.push(listener); return () => {}; },
    getToolDefinition: (name: string) => definitions[name],
    sessionManager: { getCwd: () => CWD },
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  };
  const emit = (event: any) => { for (const listener of listeners) listener(event); };
  return { session, emit };
}

function makeViewer(messages: any[], status: AgentRecord["status"] = "completed") {
  const { session, emit } = makeSession(messages);
  const tui = { terminal: { rows: 40, columns: 120 }, requestRender: vi.fn() };
  const record = { id: "a", type: "general-purpose", description: "parity", status, toolUses: 0, startedAt: 0, completedAt: 1 } as AgentRecord;
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const viewer = new ConversationViewer(tui as any, session as unknown as AgentSession, record, undefined, theme as any, () => {});
  return { viewer, session, emit, tui };
}

afterEach(() => vi.useRealTimers());

describe("viewer transcript = Pi's interactive rendering", () => {
  it("draws every kind of session message exactly as Pi's components do", () => {
    const messages = transcript();
    const { viewer } = makeViewer(messages);
    for (const width of [116, 80, 50]) {
      const ours = viewer.buildContentLines(width);
      expect(ours).toEqual(piChat(messages).lines(width));
      for (const line of ours) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    // Sanity: the real thing was drawn, not a fallback.
    const text = viewer.buildContentLines(116).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    for (const expected of ["$ npm test -- parse", "read src/parse.ts", "edit src/parse.ts", "write test/parse-empty.test.ts", "[compaction]", "[skill]", "[note]", "EACCES", "Operation aborted", "Took 2.3s"]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("system prompt");
    expect(text).not.toContain("not shown");
  });

  it("expands and collapses like Pi's app.tools.expand, at any width", () => {
    const messages = transcript();
    const { viewer } = makeViewer(messages);
    const collapsed = viewer.buildContentLines(100);
    viewer.handleInput("\x0f");
    for (const width of [100, 70]) expect(viewer.buildContentLines(width)).toEqual(piChat(messages, true).lines(width));
    expect(viewer.buildContentLines(100)).not.toEqual(collapsed);
    viewer.handleInput("\x0f");
    expect(viewer.buildContentLines(100)).toEqual(collapsed);
  });

  it("re-renders only what changed: nothing on a repeat frame, one block per new message, all on a width change", () => {
    const messages = transcript();
    const { viewer } = makeViewer(messages);
    viewer.buildContentLines(100);
    const transcriptState = (viewer as any).transcript;
    const built = transcriptState.renders;
    viewer.buildContentLines(100);
    expect(transcriptState.renders).toBe(built);

    messages.push({ role: "user", content: "and the docs", timestamp: 0 });
    expect(viewer.buildContentLines(100)).toEqual(piChat(messages).lines(100));
    expect(transcriptState.renders).toBe(built + 1);

    viewer.buildContentLines(90);
    expect(transcriptState.renders).toBeGreaterThan(built + 10);
  });

  it("re-renders every block on invalidate (Pi's theme change), with the same output", () => {
    const messages = transcript();
    const { viewer } = makeViewer(messages);
    const before = viewer.buildContentLines(100);
    const state = (viewer as any).transcript;
    const renders = state.renders;
    viewer.invalidate();
    expect(viewer.buildContentLines(100)).toEqual(before);
    expect(state.renders).toBeGreaterThan(renders);
  });

  it("follows a live turn as Pi's event handlers do: streaming text, tool calls, progress, results", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const history = transcript().slice(0, 4);
    const { viewer, session, emit } = makeViewer([...history], "running");

    // Pi's message_start / message_update: a streaming AssistantMessageComponent,
    // plus a ToolExecutionComponent per tool call as soon as one appears.
    const pi = piChat(history);
    const streaming = new AssistantMessageComponent(undefined, false, markdownTheme(), "Thinking...", 1, []);
    pi.chat.addChild(streaming);
    const partial = (text: string, call?: any) => ({ role: "assistant", content: [{ type: "text", text }, ...(call ? [call] : [])], stopReason: "stop", timestamp: 0 });
    const call = { type: "toolCall", id: "bash-2", name: "bash", arguments: { command: "npm test" } };
    let tool: ToolExecutionComponent | undefined;
    const step = (message: any, type = "message_update") => {
      session.state.streamingMessage = message;
      emit({ type, message });
      streaming.updateContent(message, true);
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        if (!tool) {
          tool = new ToolExecutionComponent(content.name, content.id, content.arguments, { showImages: false, outputPad: 1 }, definitions[content.name], ui, CWD);
          tool.setExpanded(false);
          pi.chat.addChild(tool);
        } else {
          tool.updateArgs(content.arguments);
        }
      }
      expect(viewer.buildContentLines(100)).toEqual(pi.lines(100));
    };
    step(partial("Running"), "message_start");
    step(partial("Running the **tests**"));
    step(partial("Running the **tests** now.\n\n- unit", call));

    // message_end: the final message lands in session.messages; Pi finalizes the
    // streaming component and marks the pending calls' arguments complete.
    const streamedTool = (viewer as any).transcript.tools.get("bash-2").component;
    const final = partial("Running the **tests** now.\n\n- unit", call);
    session.state.streamingMessage = undefined;
    session.messages.push(final);
    emit({ type: "message_end", message: final });
    streaming.updateContent(final, false);
    tool!.setArgsComplete();
    expect(viewer.buildContentLines(100)).toEqual(pi.lines(100));
    // The same component carries on, keyed by call id (Pi's pendingTools).
    expect((viewer as any).transcript.tools.get("bash-2").component).toBe(streamedTool);

    // tool_execution_start / _update: running state and partial output.
    emit({ type: "tool_execution_start", toolCallId: "bash-2", toolName: "bash", args: call.arguments });
    tool!.markExecutionStarted();
    expect(viewer.buildContentLines(100)).toEqual(pi.lines(100));
    const progress = { content: [{ type: "text", text: "test 1 ok\ntest 2 ok" }], details: undefined };
    emit({ type: "tool_execution_update", toolCallId: "bash-2", toolName: "bash", args: call.arguments, partialResult: progress });
    tool!.updateResult({ ...progress, isError: false }, true);
    expect(viewer.buildContentLines(100)).toEqual(pi.lines(100));
    expect(viewer.buildContentLines(100).join("\n")).toContain("Elapsed");

    // tool_execution_end and its toolResult message.
    const result = { role: "toolResult", toolCallId: "bash-2", toolName: "bash", content: [{ type: "text", text: "test 1 ok\ntest 2 ok\ntest 3 ok" }], isError: false, timestamp: 0, durationMs: 1500 };
    emit({ type: "tool_execution_end", toolCallId: "bash-2", toolName: "bash", result, isError: false, durationMs: 1500 });
    session.messages.push(result);
    tool!.updateResult({ ...result, isError: false, durationMs: 1500 });
    expect(viewer.buildContentLines(100)).toEqual(pi.lines(100));
    expect(viewer.buildContentLines(100).join("\n")).toContain("Took 1.5s");
  });

  it("redraws only the streamed message per update, however long the transcript", () => {
    const history = Array.from({ length: 40 }, () => transcript()).flat();
    const { viewer, session, emit } = makeViewer(history, "running");
    viewer.buildContentLines(100);
    const state = (viewer as any).transcript;
    let text = "Streaming";
    const update = () => {
      text += " more";
      const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 };
      session.state.streamingMessage = message;
      emit({ type: "message_update", message });
      viewer.buildContentLines(100);
    };
    update();
    const before = state.renders;
    for (let i = 0; i < 5; i++) update();
    expect(state.renders - before).toBe(5);
  });

  it("strips terminal control sequences from agent output, keeping Pi's own styling", () => {
    const evil = [
      { role: "user", content: "hi\x1b]52;c;ZXZpbA==\x07 there\x1b[2J", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan\x1b]0;pwned title\x07" },
          { type: "text", text: "sure\r\x1b[1A\x1b[2Kfake line" },
          { type: "toolCall", id: "b", name: "bash", arguments: { command: "ls\x1b[2J\x1b]8;;http://evil\x07x\x1b]8;;\x07" } },
        ],
        stopReason: "toolUse",
        timestamp: 0,
      },
      { role: "toolResult", toolCallId: "b", toolName: "bash", isError: false, timestamp: 0, content: [{ type: "text", text: "out\x1b]52;c;cm0gLXJm\x07\x9b2J" }] },
      { role: "bashExecution", command: "cat x\x1b[?1049h", output: "a\r\nb\rc\x1bc", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
      { role: "compactionSummary", summary: "s\x1b]52;c;eA==\x07", tokensBefore: 1, timestamp: 0 },
    ];
    const { viewer } = makeViewer(evil);
    viewer.handleInput("\x0f"); // expanded: every tool and summary body is drawn
    const out = viewer.buildContentLines(100).join("\n");
    for (const injected of ["\x1b]52", "\x1b]0;", "\x1b[2J", "\x1b[1A", "\x1b[2K", "\x1b[?1049h", "\x1bc", "\x9b", "\r", "\x07", "http://evil"]) {
      expect(out).not.toContain(injected);
    }
    // Pi's own styling survives.
    expect(out).toMatch(/\x1b\[[0-9;]*m/);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    for (const text of ["hi there", "sure", "fake line", "$ ls", "out", "$ cat x"]) expect(plain).toContain(text);
  });

  it("stops a running bash tool's elapsed-time timer when the viewer closes", () => {
    vi.useFakeTimers();
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "sleep 100" } }], stopReason: "toolUse", timestamp: 0 },
    ];
    const { viewer, emit } = makeViewer(messages, "running");
    viewer.buildContentLines(100);
    emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {} });
    viewer.buildContentLines(100);
    emit({ type: "tool_execution_update", toolCallId: "b", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "zzz" }] } });
    viewer.buildContentLines(100);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // Pi's bash renderer ticks "Elapsed" every second
    viewer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("draws plain text when Pi's theme is not initialized, rather than throwing", () => {
    const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
    const saved = (globalThis as any)[key];
    delete (globalThis as any)[key];
    try {
      const { viewer } = makeViewer(transcript());
      const out = viewer.buildContentLines(80).join("\n");
      expect(out).toContain("Fix the parser.");
      expect(out).toContain("[read]");
    } finally {
      (globalThis as any)[key] = saved;
    }
  });
});
