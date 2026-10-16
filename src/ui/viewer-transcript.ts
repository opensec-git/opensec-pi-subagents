/**
 * viewer-transcript.ts — a subagent's transcript drawn with Pi's own chat components.
 *
 * Pi's interactive mode turns session messages into components (`addMessageToChat`,
 * `renderSessionItems` and the `message_*` / `tool_execution_*` handlers in
 * `interactive-mode.js`). This module repeats that mapping for a subagent's
 * session, so the conversation viewer draws a transcript exactly as Pi's main
 * session would: the same components, constructor arguments, spacers, tool
 * renderers (resolved through the session's tool registry and extension
 * runner) and expand/collapse state.
 *
 * What it adds is the cost model the viewer needs under Pi-Bolt (no JIT). Pi
 * re-renders its whole chat container on every frame; here each component is a
 * block whose rendered lines are cached and re-rendered only when the block is
 * marked dirty: it was just created, its message streamed, its tool got a
 * result or a progress update, its renderer asked for a redraw (bash's elapsed
 * clock, an edit preview), or the width, theme or expand state changed. The
 * flat line array is re-assembled from the first changed block on, by copying
 * cached lines, so a frame where nothing changed costs a few comparisons
 * whatever the transcript's length.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  type MarkdownTransformer,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  type ToolDefinition,
  ToolExecutionComponent,
  type ToolRenderers,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, type MarkdownTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.js";

type Message = AgentSession["messages"][number];
type ToolResultInput = Parameters<ToolExecutionComponent["updateResult"]>[0];

/** Pi settings that change how the chat renders, read from the main session when the viewer opens. */
export interface ViewerRenderOptions {
  /** `hideThinkingBlock` (Pi default false). */
  hideThinkingBlock?: boolean;
  /** `outputPad` (Pi default 1). */
  outputPad?: number;
  /** `markdown.codeBlockIndent` (Pi default two spaces). */
  codeBlockIndent?: string;
}

/** Pi's label for a hidden thinking block (`InteractiveMode.defaultHiddenThinkingLabel`). */
const HIDDEN_THINKING_LABEL = "Thinking...";

/**
 * OSC 133 prompt-zone marks that Pi's user and assistant components put on their
 * first and last lines. They tell the terminal where the main transcript's
 * prompts are; inside the viewer's overlay they would mark the overlay's rows
 * as prompts of the screen underneath, so the viewer drops them.
 */
const OSC133 = /\x1b\]133;[A-Z]\x07/g;

/** Nesting beyond which `clean` stops descending (tool args and details are JSON). */
const CLEAN_MAX_DEPTH = 64;

/**
 * `value` with every string passed through `sanitizeTerminalText`, copied only
 * where something changed: clean input comes back as the same object, so Pi's
 * components see exactly the messages Pi's own chat would. Image data is
 * base64 and skipped.
 */
export function cleanForTerminal<T>(value: T, depth = 0): T {
  if (typeof value === "string") return sanitizeTerminalText(value) as T;
  if (value === null || typeof value !== "object" || depth > CLEAN_MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      const cleaned = cleanForTerminal(item, depth + 1);
      if (cleaned !== item) {
        out ??= value.slice();
        out[i] = cleaned;
      }
    }
    return (out ?? value) as T;
  }
  const record = value as Record<string, unknown>;
  const image = record.type === "image";
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    if (image && key === "data") continue;
    const item = record[key];
    const cleaned = cleanForTerminal(item, depth + 1);
    if (cleaned !== item) {
      out ??= { ...record };
      out[key] = cleaned;
    }
  }
  return (out ?? value) as T;
}

/** Pi's built-in tool renderers by name, for a tool the subagent's session no longer defines. */
const builtInRenderers = new Map<string, ToolRenderers | undefined>();

/**
 * The same as Pi's (unexported) `withBuiltInRenderers`: a definition's own
 * renderers, else the built-in tool's. The built-in definitions carry their
 * renderers, so building one yields them; it is done once per tool name.
 */
function withBuiltInRenderers(name: string, definition: ToolRenderers | undefined): ToolRenderers | undefined {
  if (!builtInRenderers.has(name)) {
    const cwd = process.cwd();
    // ToolDefinition<any, any, any> is the type ToolExecutionComponent itself accepts.
    const create: Record<string, () => ToolDefinition<any, any, any>> = {
      read: () => createReadToolDefinition(cwd),
      bash: () => createBashToolDefinition(cwd),
      powershell: () => createPowerShellToolDefinition(cwd),
      edit: () => createEditToolDefinition(cwd),
      write: () => createWriteToolDefinition(cwd),
      grep: () => createGrepToolDefinition(cwd),
      find: () => createFindToolDefinition(cwd),
      ls: () => createLsToolDefinition(cwd),
    };
    let renderers: ToolRenderers | undefined;
    try {
      const def = create[name]?.();
      // Renderers only, as Pi's createAllToolRenderers() has them (no `renderShell`).
      if (def) renderers = { renderCall: def.renderCall, renderResult: def.renderResult } as ToolRenderers;
    } catch {
      renderers = undefined;
    }
    builtInRenderers.set(name, renderers);
  }
  const builtIn = builtInRenderers.get(name);
  if (!definition) return builtIn;
  if (!builtIn) return definition;
  return {
    ...definition,
    renderCall: definition.renderCall ?? builtIn.renderCall,
    renderResult: definition.renderResult ?? builtIn.renderResult,
  };
}

/** One component in the transcript, with its lines as last rendered. */
interface Block {
  component: Component;
  /** Pi adds a `Spacer(1)` before this component. */
  spaceBefore: boolean;
  lines: string[];
  widths: number[];
  /** Must be re-rendered before its lines are used. */
  dirty: boolean;
  /** Position in `flat`; valid for the blocks of entries before `layoutFrom`. */
  index: number;
  /** Responds to the expand toggle. */
  expandable?: { setExpanded(expanded: boolean): void };
  /** Set when the block is a tool call's. */
  tool?: ToolState;
}


/** The blocks one session message produced, and what they were built from. */
interface Entry {
  msg: Message;
  /** Fingerprint of the message, compared only for the last message (see `syncMessages`). */
  sig: unknown[];
  blocks: Block[];
  /** For a tool result: the entry whose tool call it completed. */
  owner?: number;
}

interface ToolState {
  id: string;
  component: ToolExecutionComponent;
  block: Block;
  /** Index of the entry (assistant message) that lists this block; undefined while only streamed. */
  entry?: number;
  /** A final result (from a toolResult message or the assistant's error) has been applied. */
  done: boolean;
  /** The latest partial result applied, kept to stop a renderer's timer on dispose. */
  partial?: ToolResultInput;
}

/**
 * The references and values a message's rendering depends on. Compared
 * element by element with `===`, so an unchanged message costs a few pointer
 * comparisons and nothing is serialized per frame.
 */
function signature(msg: Message): unknown[] {
  const m = msg as { role?: string; content?: unknown; output?: unknown; command?: unknown; summary?: unknown; exitCode?: unknown; stopReason?: unknown };
  if (!Array.isArray(m.content)) return [m.role, m.content, m.output, m.command, m.summary, m.exitCode];
  const sig: unknown[] = [m.role, m.content, m.content.length, m.stopReason];
  for (const c of m.content as { text?: string; thinking?: string; arguments?: unknown }[]) sig.push(c, c.text ?? c.thinking, c.arguments);
  return sig;
}

function sameSignature(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** An assistant message Pi's component can draw (a partial one always has its content array). */
function isAssistant(msg: Message | undefined): msg is AssistantMessage {
  return msg?.role === "assistant" && Array.isArray(msg.content);
}

/** Pi's `getUserMessageText`: the text blocks, joined without a separator. */
function userText(msg: Extract<Message, { role: "user" }>): string {
  if (typeof msg.content === "string") return msg.content;
  let text = "";
  for (const c of msg.content) if (c.type === "text") text += c.text;
  return text;
}

type Runner = {
  getMessageRenderer?(customType: string): unknown;
  getMarkdownTransformers?(): MarkdownTransformer[];
  resolveToolRenderers?(name: string, base: () => ToolRenderers | undefined): ToolRenderers | undefined;
};

type SessionState = { streamingMessage?: Message; pendingToolCalls?: ReadonlySet<string> };

export class PiTranscript {
  /** Rendered lines of every block, in order. Owned here; do not mutate. */
  readonly lines: string[] = [];
  /** `widths[i]` is the visible width of `lines[i]`, measured when it was rendered. */
  readonly widths: number[] = [];
  /** Block renders so far: a test hook for the cost model. */
  renders = 0;

  private entries: Entry[] = [];
  /** Blocks in display order: every entry's, then the streamed message's. */
  private flat: Block[] = [];
  /** `blockStart[i]` is where `flat[i]`'s lines begin in `lines`. */
  private blockStart: number[] = [];
  /** The assistant message being streamed (not yet in `session.messages`), as Pi's streamingComponent. */
  private stream: { assistant: AssistantMessageComponent; blocks: Block[] } | undefined;
  private tools = new Map<string, ToolState>();
  /** The messages array last validated. */
  private cacheMessages: readonly Message[] | undefined;
  private width = -1;
  private expanded = false;
  /** First flat index whose lines need re-assembly (`Infinity` when none). */
  private dirtyFrom = 0;
  /**
   * First entry whose blocks changed (`entries.length` for the stream's;
   * `Infinity` when none). An entry index, not a flat one, so laying out
   * after an append visits only the new blocks, however long the transcript.
   */
  private layoutFrom = 0;
  /** The streamed message as last seen, and whether it changed since the last sync. */
  private streamMsg: AssistantMessage | undefined;
  private streamChanged = false;
  /** Tool calls whose execution has started, partial results, and ids with news to apply. */
  private started = new Set<string>();
  private partials = new Map<string, ToolResultInput>();
  private pendingToolUpdates = new Set<string>();
  private syncing = false;
  private disposed = false;
  private readonly markdownTheme: MarkdownTheme;
  private readonly transformers: readonly MarkdownTransformer[];
  private readonly runner: Runner | undefined;
  private readonly cwd: string;
  /** The session has an agent state (Pi >= 1.1): the streamed message is read from it. */
  private readonly hasState: boolean;

  constructor(
    private readonly session: AgentSession,
    private readonly requestRender: () => void,
    private readonly options: ViewerRenderOptions = {},
  ) {
    // Pi's getMarkdownThemeWithSettings(). Its functions read the global theme
    // lazily, so a theme change shows on the next render without rebuilding it.
    this.markdownTheme = { ...getMarkdownTheme(), codeBlockIndent: options.codeBlockIndent ?? "  " };
    const loose = session as { extensionRunner?: Runner; sessionManager?: { getCwd?(): string } };
    let runner: Runner | undefined;
    let cwd = process.cwd();
    try {
      runner = loose.extensionRunner;
      cwd = loose.sessionManager?.getCwd?.() ?? cwd;
    } catch {
      // A disposed or partial session: draw with Pi's defaults.
    }
    this.runner = runner;
    this.cwd = cwd;
    // Pi passes its mermaid transformer first; it is not exported, so only the
    // session's extension transformers apply here.
    this.transformers = runner?.getMarkdownTransformers?.() ?? [];
    const state = this.sessionState();
    this.hasState = state !== undefined;
    this.streamMsg = this.liveStream();
    this.streamChanged = this.streamMsg !== undefined;
    for (const id of state?.pendingToolCalls ?? []) this.started.add(id);
  }

  /** True while there is anything to draw, including a message still streaming. */
  get hasContent(): boolean {
    return this.session.messages.length > 0 || this.streamMsg !== undefined;
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  /** Feed a session event. Cheap: it records what changed, `sync` applies it. */
  handleEvent(event: { type?: string; message?: Message; toolCallId?: string; partialResult?: ToolResultInput; parentToolCallId?: string }): void {
    if (this.disposed) return;
    switch (event.type) {
      case "message_start":
      case "message_update":
        if (!isAssistant(event.message)) break;
        this.streamChanged = true;
        // Without a session state (older or stub sessions) the events are the only source.
        if (!this.hasState) this.streamMsg = event.message;
        break;
      case "message_end":
      case "agent_end":
        if (event.type === "message_end" && event.message?.role !== "assistant") break;
        this.streamChanged = true;
        if (!this.hasState) this.streamMsg = undefined;
        break;
      case "tool_execution_start":
        // Nested calls (from codemode scripts) are shown inside their parent's row, as in Pi.
        if (event.parentToolCallId || !event.toolCallId) break;
        this.started.add(event.toolCallId);
        this.pendingToolUpdates.add(event.toolCallId);
        break;
      case "tool_execution_update":
        if (event.parentToolCallId || !event.toolCallId || !event.partialResult) break;
        this.partials.set(event.toolCallId, event.partialResult);
        this.pendingToolUpdates.add(event.toolCallId);
        break;
      case "tool_execution_end":
        if (event.toolCallId) this.started.delete(event.toolCallId);
        break;
    }
  }

  /** Toggle every tool, bash, summary, skill and custom block, as Pi's `app.tools.expand`. */
  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    for (const block of this.flat) {
      if (!block.expandable) continue;
      block.expandable.setExpanded(expanded);
      this.markDirty(block);
    }
  }

  /** Re-render everything on the next sync: theme change (Pi invalidates the TUI then). */
  invalidate(): void {
    for (const block of this.flat) {
      block.component.invalidate();
      block.dirty = true;
    }
    this.dirtyFrom = 0;
  }

  /**
   * Bring the cached lines up to date for `width`. Only blocks that changed are
   * rendered; the line array is re-assembled from the first changed block on.
   */
  sync(width: number): void {
    if (width !== this.width) {
      this.width = width;
      for (const block of this.flat) block.dirty = true;
      this.dirtyFrom = 0;
    }
    this.syncing = true;
    try {
      this.syncMessages();
      this.applyToolUpdates();
      this.syncStream();
      this.layout();
      this.assemble();
    } finally {
      this.syncing = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    // A tool still running with a partial result may have a renderer timer
    // (bash's elapsed clock); a final render of the same content stops it.
    for (const tool of this.tools.values()) {
      if (tool.done || !tool.partial) continue;
      try {
        tool.component.updateResult({ ...tool.partial, isError: false }, false);
      } catch {
        // Being discarded; nothing to recover.
      }
    }
  }

  // ---- Messages ----

  /** The session's streamed assistant message, from its state when it has one. */
  private liveStream(): AssistantMessage | undefined {
    if (!this.hasState) return this.streamMsg;
    const msg = this.sessionState()?.streamingMessage;
    return isAssistant(msg) ? msg : undefined;
  }

  private sessionState(): SessionState | undefined {
    try {
      return (this.session as { state?: SessionState }).state;
    } catch {
      return undefined;
    }
  }

  /**
   * Validate `entries` against `session.messages`. Pi only appends to that
   * array while it is the same object, and its messages are final once pushed,
   * so only the last one is fingerprinted (an older Pi streamed into it in
   * place); a new array (compaction) is matched by identity from the start.
   */
  private syncMessages(): void {
    const messages = this.session.messages;
    let stale = Math.min(this.entries.length, messages.length);
    const sameArray = messages === this.cacheMessages && this.entries.length <= messages.length;
    const from = sameArray ? Math.max(0, this.entries.length - 1) : 0;
    this.cacheMessages = messages;
    for (let i = from; i < stale; i++) {
      const entry = this.entries[i];
      if (entry.msg !== messages[i] || (i === this.entries.length - 1 && !sameSignature(entry.sig, signature(messages[i])))) {
        stale = i;
        break;
      }
    }
    if (stale === this.entries.length && stale === messages.length) return;

    // A dropped tool result would leave its call showing that result: rebuild the call too.
    for (let i = stale; i < this.entries.length; i++) {
      const owner = this.entries[i].owner;
      if (owner !== undefined && owner < stale) stale = owner;
    }
    for (let i = stale; i < this.entries.length; i++) {
      for (const block of this.entries[i].blocks) this.forgetTool(block);
    }
    this.entries.length = stale;
    this.layoutFrom = Math.min(this.layoutFrom, stale);

    const touched: ToolState[] = [];
    for (let i = stale; i < messages.length; i++) this.entries.push(this.buildEntry(messages[i], touched));
    // Pi's message_end: the arguments of a call still waiting for its result are
    // complete (an edit computes its preview diff from them).
    for (const tool of touched) if (!tool.done) tool.component.setArgsComplete();
  }

  /** Flat index just past the blocks of the first `count` entries. */
  private flatEnd(count: number): number {
    for (let i = Math.min(count, this.entries.length) - 1; i >= 0; i--) {
      const blocks = this.entries[i].blocks;
      if (blocks.length > 0) return blocks[blocks.length - 1].index + 1;
    }
    return 0;
  }

  private hasBlocksBefore(): boolean {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].blocks.length > 0) return true;
    return false;
  }

  /** The blocks Pi's addMessageToChat / renderSessionItems would add for `msg`. */
  private buildEntry(msg: Message, touched: ToolState[]): Entry {
    const entry: Entry = { msg, sig: signature(msg), blocks: [] };
    const index = this.entries.length;
    switch (msg.role) {
      case "user": {
        const text = sanitizeTerminalText(userText(msg));
        if (!text) break;
        const spaceBefore = this.hasBlocksBefore();
        const skill = parseSkillBlock(text);
        if (skill) {
          const component = new SkillInvocationMessageComponent(skill, this.markdownTheme, this.pad());
          component.setExpanded(this.expanded);
          entry.blocks.push(this.block(component, spaceBefore, component));
          if (skill.userMessage) {
            entry.blocks.push(this.block(new UserMessageComponent(skill.userMessage, this.markdownTheme, this.pad(), this.transformers), true));
          }
        } else {
          entry.blocks.push(this.block(new UserMessageComponent(text, this.markdownTheme, this.pad(), this.transformers), spaceBefore));
        }
        break;
      }
      case "assistant": {
        // The stream this message finished is replaced by the final rendering.
        this.endStream();
        const clean = cleanForTerminal(msg);
        entry.blocks.push(this.block(this.assistantComponent(clean, false), false));
        const failed = clean.stopReason === "aborted" || clean.stopReason === "error";
        for (const content of clean.content) {
          if (content.type !== "toolCall") continue;
          const tool = this.toolFor(content.name, content.id, content.arguments);
          tool.entry = index;
          entry.blocks.push(tool.block);
          if (failed && !tool.done) {
            tool.component.updateResult({ content: [{ type: "text", text: this.failureText(clean) }], isError: true });
            tool.done = true;
            this.markDirty(tool.block);
          }
          touched.push(tool);
        }
        break;
      }
      case "toolResult": {
        const tool = this.tools.get(msg.toolCallId);
        if (!tool || tool.done) break;
        tool.component.updateResult(cleanForTerminal(msg));
        tool.done = true;
        this.partials.delete(msg.toolCallId);
        this.markDirty(tool.block);
        entry.owner = tool.entry;
        break;
      }
      case "bashExecution": {
        const component = new BashExecutionComponent(sanitizeTerminalText(msg.command), this.blockUi(), msg.excludeFromContext, this.pad());
        // Pi's appendOutput turns \r\n and lone \r into line breaks; do that before \r is stripped.
        if (msg.output) component.appendOutput(sanitizeTerminalText(msg.output.replace(/\r\n?/g, "\n")));
        const truncation = msg.truncated ? ({ truncated: true } as Parameters<BashExecutionComponent["setComplete"]>[2]) : undefined;
        component.setComplete(msg.exitCode, msg.cancelled, truncation, msg.fullOutputPath && sanitizeTerminalText(msg.fullOutputPath));
        entry.blocks.push(this.block(component, false, component));
        break;
      }
      case "custom": {
        if (!msg.display) break;
        const renderer = this.runner?.getMessageRenderer?.(msg.customType) as ConstructorParameters<typeof CustomMessageComponent>[1];
        const component = new CustomMessageComponent(cleanForTerminal(msg), renderer, this.markdownTheme, this.pad());
        component.setExpanded(this.expanded);
        entry.blocks.push(this.block(component, false, component));
        break;
      }
      case "compactionSummary": {
        const component = new CompactionSummaryMessageComponent(cleanForTerminal(msg), this.markdownTheme, this.pad());
        component.setExpanded(this.expanded);
        entry.blocks.push(this.block(component, true, component));
        break;
      }
      case "branchSummary": {
        const component = new BranchSummaryMessageComponent(cleanForTerminal(msg), this.markdownTheme, this.pad());
        component.setExpanded(this.expanded);
        entry.blocks.push(this.block(component, true, component));
        break;
      }
      default:
        // `system`, and anything Pi does not draw.
        break;
    }
    return entry;
  }

  /** Pi's text for the tool calls of an aborted or failed assistant message. */
  private failureText(msg: AssistantMessage): string {
    if (msg.stopReason !== "aborted") return msg.errorMessage || "Error";
    const retries = (this.session as { retryAttempt?: number }).retryAttempt ?? 0;
    return retries > 0 ? `Aborted after ${retries} retry attempt${retries > 1 ? "s" : ""}` : "Operation aborted";
  }

  private pad(): number {
    return this.options.outputPad ?? 1;
  }

  private assistantComponent(msg: AssistantMessage, streaming: boolean): AssistantMessageComponent {
    const component = new AssistantMessageComponent(undefined, this.options.hideThinkingBlock ?? false, this.markdownTheme, HIDDEN_THINKING_LABEL, this.pad(), this.transformers);
    component.updateContent(msg, streaming);
    return component;
  }

  /** The tool call's component: the one made while it streamed, else a new one (Pi keys them by id). */
  private toolFor(name: string, id: string, args: unknown): ToolState {
    const existing = this.tools.get(id);
    if (existing) {
      existing.component.updateArgs(args);
      this.markDirty(existing.block);
      return existing;
    }
    const ui = { requestRender: () => {} };
    // Images stay Pi's text placeholder: an inline image cannot be clipped to a scrolled overlay.
    const component = new ToolExecutionComponent(name, id, args, { showImages: false, outputPad: this.pad() }, this.toolDefinition(name), ui as unknown as TUI, this.cwd);
    component.setExpanded(this.expanded);
    const tool: ToolState = { id, component, block: this.block(component, false, component), done: false };
    tool.block.tool = tool;
    // A renderer's own redraw (bash's elapsed clock, an edit preview landing) marks just this block.
    ui.requestRender = () => this.markDirty(tool.block);
    if (this.started.has(id)) component.markExecutionStarted();
    const partial = this.partials.get(id);
    if (partial) {
      component.updateResult({ ...partial, isError: false }, true);
      tool.partial = partial;
    }
    this.tools.set(id, tool);
    return tool;
  }

  /** Pi's getRegisteredToolDefinition, against the subagent's session. */
  private toolDefinition(name: string): ToolRenderers | undefined {
    const base = () => {
      let definition: ToolRenderers | undefined;
      try {
        definition = this.session.getToolDefinition?.(name);
      } catch {
        definition = undefined;
      }
      return withBuiltInRenderers(name, definition);
    };
    try {
      return this.runner?.resolveToolRenderers ? this.runner.resolveToolRenderers(name, base) : base();
    } catch {
      return base();
    }
  }

  private forgetTool(block: Block): void {
    if (block.tool && this.tools.get(block.tool.id) === block.tool) this.tools.delete(block.tool.id);
  }

  private applyToolUpdates(): void {
    if (this.pendingToolUpdates.size === 0) return;
    for (const id of this.pendingToolUpdates) {
      const tool = this.tools.get(id);
      if (!tool || tool.done) continue;
      if (this.started.has(id)) tool.component.markExecutionStarted();
      const partial = this.partials.get(id);
      if (partial && partial !== tool.partial) {
        tool.component.updateResult({ ...partial, isError: false }, true);
        tool.partial = partial;
      }
      this.markDirty(tool.block);
    }
    this.pendingToolUpdates.clear();
  }

  // ---- Streaming ----

  /**
   * Drop the streamed message's blocks. Its tool components stay in `tools`,
   * keyed by call id, so the final message's entry takes over the same
   * components (with their renderer state), as Pi's pendingTools does.
   */
  private endStream(): void {
    if (!this.stream) return;
    this.stream = undefined;
    this.streamChanged = true;
    // The stream's blocks followed every entry built so far.
    this.layoutFrom = Math.min(this.layoutFrom, this.entries.length);
  }

  /** The streamed assistant message and its tool calls, after every session message. */
  private syncStream(): void {
    const msg = this.liveStream();
    if (!this.streamChanged && msg === this.streamMsg) return;
    this.streamChanged = false;
    this.streamMsg = msg;
    if (!msg) {
      this.endStream();
      this.streamChanged = false;
      return;
    }
    const clean = cleanForTerminal(msg);
    let stream = this.stream;
    if (!stream) {
      stream = { assistant: this.assistantComponent(clean, true), blocks: [] };
      stream.blocks.push(this.block(stream.assistant, false));
      this.stream = stream;
      this.layoutFrom = Math.min(this.layoutFrom, this.entries.length);
    } else {
      stream.assistant.updateContent(clean, true);
      this.markDirty(stream.blocks[0]);
    }
    for (const content of clean.content) {
      if (content.type !== "toolCall") continue;
      const tool = this.toolFor(content.name, content.id, content.arguments);
      if (tool.entry === undefined && !stream.blocks.includes(tool.block)) {
        stream.blocks.push(tool.block);
        this.layoutFrom = Math.min(this.layoutFrom, this.entries.length);
      }
    }
  }

  // ---- Blocks ----

  private block(component: Component, spaceBefore: boolean, expandable?: Block["expandable"]): Block {
    return { component, spaceBefore, lines: [], widths: [], dirty: true, index: Number.MAX_SAFE_INTEGER, expandable };
  }

  /** A `TUI` stand-in for a component that redraws itself (the bash loader, stopped once complete). */
  private blockUi(): TUI {
    return { requestRender: () => { if (!this.syncing && !this.disposed) this.requestRender(); } } as unknown as TUI;
  }

  private markDirty(block: Block): void {
    block.dirty = true;
    if (block.index < this.dirtyFrom) this.dirtyFrom = block.index;
    if (!this.syncing && !this.disposed) this.requestRender();
  }

  /** Re-list blocks from entry `layoutFrom` on: the entries', then the stream's. */
  private layout(): void {
    if (this.layoutFrom === Number.POSITIVE_INFINITY) return;
    const first = Math.min(this.layoutFrom, this.entries.length);
    const from = Math.min(this.flatEnd(first), this.flat.length);
    this.flat.length = from;
    const push = (block: Block) => {
      block.index = this.flat.length;
      this.flat.push(block);
    };
    for (let i = first; i < this.entries.length; i++) for (const block of this.entries[i].blocks) push(block);
    if (this.stream) for (const block of this.stream.blocks) push(block);
    this.dirtyFrom = Math.min(this.dirtyFrom, from);
    this.layoutFrom = Number.POSITIVE_INFINITY;
  }

  /** Render dirty blocks and rebuild `lines` from the first changed one. */
  private assemble(): void {
    const from = this.dirtyFrom;
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    if (from === Number.POSITIVE_INFINITY) return;
    this.truncateLines(Math.min(from, this.flat.length));
    for (let i = from; i < this.flat.length; i++) {
      const block = this.flat[i];
      if (block.dirty) this.renderBlock(block);
      this.blockStart.push(this.lines.length);
      for (let j = 0; j < block.lines.length; j++) {
        this.lines.push(block.lines[j]);
        this.widths.push(block.widths[j]);
      }
    }
  }

  private truncateLines(flatIndex: number): void {
    const at = flatIndex < this.blockStart.length ? this.blockStart[flatIndex] : this.lines.length;
    this.lines.length = at;
    this.widths.length = at;
    if (flatIndex < this.blockStart.length) this.blockStart.length = flatIndex;
  }

  private renderBlock(block: Block): void {
    this.renders++;
    const width = this.width;
    let rendered: string[];
    try {
      rendered = block.component.render(width);
    } catch {
      // A renderer is arbitrary extension code; one that throws must not take the overlay down.
      rendered = [];
    }
    const lines: string[] = block.spaceBefore ? [""] : [];
    const widths: number[] = block.spaceBefore ? [0] : [];
    const last = rendered.length - 1;
    for (let i = 0; i <= last; i++) {
      let line = rendered[i];
      if ((i === 0 || i === last) && line.includes("\x1b]133;")) line = line.replace(OSC133, "");
      let w = visibleWidth(line);
      if (w > width) {
        line = truncateToWidth(line, width);
        w = visibleWidth(line);
      }
      lines.push(line);
      widths.push(w);
    }
    block.lines = lines;
    block.widths = widths;
    block.dirty = false;
  }
}
