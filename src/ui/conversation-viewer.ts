/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import { type AgentSession, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, Markdown, type MarkdownOptions, type MarkdownTheme, matchesKey, type OverlayOptions, ScrollView, type ScrollViewScrollbar, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getCachedSessionContextPercent, getLifetimeCost, getLifetimeTotal } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;
/** Fullscreen chrome: header, divider above the transcript, divider below it, footer. */
const FULLSCREEN_CHROME_LINES = 4;
const SCROLLBAR_WIDTH = 1;

/**
 * Where the viewer sits: the whole terminal under Pi's fullscreen renderer, a
 * centered floating overlay otherwise. Follows the active renderer, not a
 * setting that may need a restart to take effect.
 */
export function getConversationOverlayOptions(tui: Pick<TUI, "mode">): OverlayOptions {
  return tui.mode === "fullscreen"
    ? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
    : { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` };
}

/** Message roles the fullscreen jump marker counts as "new messages" (not streaming updates). */
const COUNTED_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

/**
 * Cap on a single tool result or bash output before the viewer elides the rest.
 *
 * The cap is not cosmetic — it bounds render cost. A message's lines are
 * rebuilt whenever the width or Markdown mode changes, and the streaming tail
 * on every frame it changes, so an uncapped 200 KB result costs ~6 ms per
 * rebuild to parse as Markdown, against ~0.5 ms once capped (best of 5, width
 * 76). 16 KB is roughly a screenful at every terminal size and still ~30x the
 * 500 characters this replaces, which was small enough to cut most real
 * results mid-sentence.
 */
export const RESULT_MAX_CHARS = 16_000;

/**
 * Session events that fire per streamed token or tool-output chunk. They are
 * coalesced into one redraw per frame; every other event redraws at once.
 */
const STREAMING_EVENTS = new Set(["message_update", "tool_execution_update"]);
/** Redraw cadence while streaming — the widget's spinner frame. */
const STREAM_FRAME_MS = 80;

/**
 * One message's rendered lines, already clamped to the width they were built
 * for. `source` is what they were built from, compared only for messages that
 * may still change (see `ConversationViewer.contentView`).
 */
type Block = { msg: object; source: string; lines: string[] | undefined };

/** The `b` affordance: whether this run can be handed to the background now, and the handoff. */
export interface ViewerBackgroundAction {
  available(): boolean;
  send(): void;
}

/** Cycle order for the viewer's `m` key. */
const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];

/** Footer labels — short, because the idle footer is already full at 80 columns. */
const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};

/**
 * Both options keep the renderer from *rewriting* source that only looks like
 * Markdown: without them `3) a / 7) b / 9) c` comes back renumbered `3. 4. 5.`
 * and backslash escapes are normalized away. Neither is a safe edit to make to
 * a tool's output, and both are cheap to switch off.
 */
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what buys syntax-highlighted code fences (it carries a
 * `highlightCode`), and it keeps this surface consistent with the notification
 * renderer, which uses the same source. It has to be *probed* rather than
 * try/caught around the call: `getMarkdownTheme()` returns arrow functions that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` — long after this returns — and takes the overlay with it. That is
 * the case in tests and any embedded session that never called `initTheme()`.
 */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 *
 * Separately because the notice is the viewer's chrome, not the tool's output.
 * Appended into the string it becomes content: a cut landing inside a fenced
 * code block — likely, on exactly the large `ctx_execute` results this is for —
 * renders the notice as a line of source inside the fence.
 */
function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

/**
 * `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000.
 *
 * The bracket is chosen against the *rounded* value, so 999,999 reads `1M`
 * rather than the `1000.0k` a naive `< 1e6` test produces.
 */
function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

export class ConversationViewer implements Component, Focusable {
  private scrollOffset = 0;
  private autoScroll = true;
  /** Set by the TUI while the viewer has keyboard focus; forwarded to the composer's cursor. */
  focused = false;
  /** Pi's fullscreen renderer is active: the viewer fills the terminal and takes the mouse. */
  private readonly fullscreen: boolean;
  /**
   * Fullscreen scroll state and scrollbar visibility, as Pi's own transcript
   * keeps them. Used as a state machine only — never rendered — so scrolling
   * reads the cached lines instead of re-rendering a copy of the transcript.
   */
  private readonly scrollView: ScrollView;
  /** Fullscreen geometry from the last frame, for mouse hit-testing. */
  private viewport: { width: number; top: number; height: number; maxScroll: number; thumbTop: number; thumbHeight: number } | undefined;
  /** Set while the scrollbar thumb is dragged: where in the thumb it was grabbed. */
  private scrollbarGrabOffset: number | undefined;
  /** Fullscreen footer controls from the last frame, by column. */
  private footerTargets: { start: number; end: number; key: string }[] = [];
  /** The fullscreen jump-to-latest marker from the last frame, when shown. */
  private latestTarget: { row: number; start: number; end: number } | undefined;
  /** Messages that arrived while scrolled away from the end (fullscreen). */
  private newMessages = 0;
  private readonly requestRender = () => {
    if (!this.closed) this.tui.requestRender();
  };
  /**
   * Chrome rows (header, dividers, footer) from earlier frames, one entry per
   * slot, rebuilt only when their inputs change. Their box-drawing and `·`
   * characters take pi-tui's slow width path, which without a JIT cost more
   * than the whole transcript area.
   */
  private readonly chromeCache = new Map<string, { key: string; value: unknown }>();
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
  private readonly markdownTheme: MarkdownTheme;
  /** Set by the `m` key. Wins over the setting so `m` works without a persist hook. */
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  /**
   * One `Markdown` per message, so its own text/width cache does the work. A
   * fresh instance per render would re-parse the whole transcript on every
   * keystroke — the component caches, but only across calls to the same object.
   * Weak so a compacted-away message doesn't pin its render.
   */
  private readonly markdownCache = new WeakMap<object, { md: Markdown; text: string; failed?: boolean }>();
  /**
   * The transcript, kept between frames. `blocks[i]` renders `messages[i]`;
   * `lines` holds every block's lines (and separators) in order, and
   * `blockStart[i]` is where block `i`'s part of it begins. All of it is valid
   * for `cacheWidth` and `cacheMode` only.
   */
  private blocks: Block[] = [];
  private blockStart: number[] = [];
  private lines: string[] = [];
  /** `lineWidths[i]` is the visible width of `lines[i]`, measured once when the line is built. */
  private lineWidths: number[] = [];
  /**
   * The messages array the cache was last validated against. Pi only appends
   * to that array and replaces it wholesale otherwise, so while it is the same
   * object only the unsettled tail needs checking — what keeps a frame's cost
   * flat however long the transcript gets.
   */
  private cacheMessages: readonly unknown[] | undefined;
  private cacheWidth = -1;
  private cacheMode: ViewerMarkdownMode | undefined;
  /** Messages from this index on may still change in place; earlier ones are settled. */
  private unsettledFrom = 0;
  /** Pending coalesced redraw for streaming events. */
  private streamRenderTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    private showCost = false,
    /**
     * The current `viewerMarkdown` setting. Read live rather than captured,
     * unlike `showCost`: `m` changes it while the overlay is on screen.
     * Omitted → `assistant`.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m`, so the key and `/agents → Settings` mean
     * the same thing. Omitted → `m` still cycles, viewer-locally.
     */
    private onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
    /**
     * Hand this run to the background. `available` is read live — it turns
     * false the instant the handoff lands or the run ends. Omitted → no `b`
     * affordance (history views).
     */
    private onBackground?: ViewerBackgroundAction,
    /** Pi's `fullscreenScrollbar` preference, captured when the viewer opens. */
    scrollbarMode: ScrollViewScrollbar = "auto",
  ) {
    this.fullscreen = tui.mode === "fullscreen";
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.scrollView = new ScrollView(
      { render: () => [], invalidate: () => {} },
      { follow: "end", scrollbar: this.fullscreen ? scrollbarMode : "hidden" },
    );
    this.unsubscribe = session.subscribe((event) => {
      if (this.closed) return;
      const e = event as { type?: string; message?: { role?: string } } | undefined;
      if (this.fullscreen && e?.type === "message_start" && !this.scrollView.isFollowingEnd && COUNTED_ROLES.has(e.message?.role ?? "")) {
        this.newMessages++;
      }
      if (STREAMING_EVENTS.has(e?.type ?? "")) {
        // A token delta changes at most the activity line; one redraw per
        // frame is enough, and unthrottled it was one per token.
        this.streamRenderTimer ??= setTimeout(() => {
          this.streamRenderTimer = undefined;
          if (!this.closed) this.tui.requestRender();
        }, STREAM_FRAME_MS);
        return;
      }
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.fullscreen && (matchesKey(data, "ctrl+end") || (!this.composer && matchesKey(data, "end")))) {
      this.jumpToLatest();
      return;
    }
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Hand a live foreground run to the background. Single press, unlike stop:
    // the transition is one-way but keeps the agent working, so a stray key
    // costs a notification rather than the run.
    if (matchesKey(data, "b") && this.canSendToBackground()) {
      this.stopArmed = false;
      this.onBackground?.send();
      this.tui.requestRender();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }

    // Cycle raw → assistant-only → everything. The escape hatch that makes
    // Markdown rendering safe to default on: a result the renderer reshapes
    // (a diff, an indented log, a `#`-commented script) is one key from verbatim.
    if (matchesKey(data, "m")) {
      this.stopArmed = false;
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.tui.requestRender();
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    // Cached: this validates the transcript, it does not rebuild it.
    const totalLines = this.contentLength(this.contentView(this.lastInnerW));
    const viewportHeight = this.viewportHeight();
    if (this.fullscreen) {
      this.scrollView.updateLayout(totalLines, viewportHeight, this.requestRender);
      if (this.keys.scrollUp(data)) this.scrollView.scrollBy(-1);
      else if (this.keys.scrollDown(data)) this.scrollView.scrollBy(1);
      else if (this.keys.pageUp(data)) this.scrollView.scrollBy(-viewportHeight);
      else if (this.keys.pageDown(data)) this.scrollView.scrollBy(viewportHeight);
      else if (matchesKey(data, "home")) this.scrollView.scrollToStart();
      return;
    }
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  /** Follow the conversation again and clear the new-message count (fullscreen `Ctrl+End`). */
  private jumpToLatest(): void {
    this.scrollView.scrollToEnd();
    this.newMessages = 0;
    this.stopArmed = false;
    this.requestRender();
  }

  /**
   * Fullscreen mouse: wheel scrolling, the draggable scrollbar, the jump
   * marker and the footer controls. Every cell belongs to the viewer, so even
   * an unused click or drag is consumed rather than reaching Pi's transcript
   * selection, scrolling or editor underneath. Nothing here rebuilds lines.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (!this.fullscreen) return { handled: false };
    if (this.closed || !this.viewport) return { handled: true, render: false };
    const view = this.viewport;
    const onScrollbar = this.scrollView.scrollbar !== "hidden" && event.x >= view.width - SCROLLBAR_WIDTH && event.x < view.width
      && event.y >= view.top && event.y < view.top + view.height;
    if (event.type === "move") {
      this.scrollView.setScrollbarActive(onScrollbar);
      return { handled: true, render: false };
    }
    if (event.type === "wheel") {
      this.stopArmed = false;
      this.scrollView.scrollBy(event.wheelDelta ?? 0);
      return { handled: true, render: true };
    }
    if (event.type === "release") {
      const wasDragging = this.scrollbarGrabOffset !== undefined;
      this.scrollbarGrabOffset = undefined;
      this.scrollView.setScrollbarActive(onScrollbar);
      return { handled: true, render: wasDragging };
    }
    if (event.type === "drag" && this.scrollbarGrabOffset !== undefined) {
      const travel = view.height - view.thumbHeight;
      const position = Math.max(0, Math.min(travel, event.y - view.top - this.scrollbarGrabOffset));
      this.scrollView.scrollTo(travel > 0 ? Math.round((position / travel) * view.maxScroll) : 0);
      return { handled: true, render: true };
    }
    if (event.type === "press" && event.button === "left") {
      this.scrollbarGrabOffset = undefined;
      this.scrollView.setScrollbarActive(onScrollbar);
      const latest = this.latestTarget;
      if (latest && event.y === latest.row && event.x >= latest.start && event.x < latest.end) {
        this.jumpToLatest();
        return { handled: true, render: true };
      }
      if (event.y === this.tui.terminal.rows - 1) {
        const target = this.footerTargets.find(t => event.x >= t.start && event.x < t.end);
        if (target) {
          this.handleInput(target.key);
          return { handled: true, render: true };
        }
      }
      this.stopArmed = false;
      if (this.composer && event.y === this.tui.terminal.rows - 2) {
        this.composer.handleMouse({ ...event, x: event.x - 1, y: 0, width: this.lastInnerW, height: 1 });
        return { handled: true, render: true };
      }
      if (onScrollbar && view.maxScroll > 0) {
        const y = event.y - view.top;
        if (y >= view.thumbTop && y < view.thumbTop + view.thumbHeight) {
          this.scrollbarGrabOffset = y - view.thumbTop;
          return { handled: true, capture: true, render: true };
        }
        this.scrollView.scrollBy(y < view.thumbTop ? -view.height : view.height);
        // A track click pages; holding it then drags the thumb from its middle.
        this.scrollbarGrabOffset = Math.floor(view.thumbHeight / 2);
        return { handled: true, capture: true, render: true };
      }
      return { handled: true, render: true };
    }
    return { handled: true, render: false };
  }

  render(width: number): string[] {
    return this.fullscreen ? this.renderFullscreen(width) : this.renderRegular(width);
  }

  /** A chrome row for `slot`, reused while `key` is unchanged. */
  private chrome<T>(slot: string, key: string, build: () => T): T {
    const hit = this.chromeCache.get(slot);
    if (hit && hit.key === key) return hit.value as T;
    const value = build();
    this.chromeCache.set(slot, { key, value });
    return value;
  }

  /** Everything the header row depends on, as a cheap ASCII key. */
  private headerKey(): string {
    const r = this.record;
    const percent = getLifetimeTotal(r.lifetimeUsage) > 0 ? getCachedSessionContextPercent(this.activity?.session) : undefined;
    return `${r.status}|${this.activity?.toolUses ?? r.toolUses}|${formatDuration(r.startedAt, r.completedAt)}|${getLifetimeTotal(r.lifetimeUsage)}|${percent}|${r.compactionCount}|${this.showCost ? getLifetimeCost(r.lifetimeUsage) : ""}`;
  }

  /** The header's status line: icon, agent, description, then tools, duration, tokens and cost. */
  private headerText(): string {
    const th = this.theme;
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    // Spend from the record, context from the live session: the record is the
    // only total that survives the agent finishing and the only one carrying a
    // nested child's spend.
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getCachedSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);

    return `${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}  ${th.fg("muted", sanitizeTerminalText(this.record.description))} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`;
  }

  /** Content line `at` (transcript, then activity tail) with its visible width; "" past the end. */
  private contentLine(content: { base: string[]; tail: string[] }, at: number): { text: string; width: number } {
    if (at < content.base.length) {
      const text = content.base[at];
      // The cached transcript has its widths; the empty-session placeholder does not.
      return { text, width: content.base === this.lines ? this.lineWidths[at] : visibleWidth(text) };
    }
    const text = content.tail[at - content.base.length] ?? "";
    return { text, width: text ? visibleWidth(text) : 0 };
  }

  /** The floating viewer (Pi's regular renderer): a bordered box, keyboard only. */
  private renderRegular(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const border = th.fg("border", "│");
    const row = (content: string) =>
      border + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + border;
    const hrTop = this.chrome("r:top", `${width}`, () => th.fg("border", `╭${"─".repeat(width - 2)}╮`));
    const hrBot = this.chrome("r:bottom", `${width}`, () => th.fg("border", `╰${"─".repeat(width - 2)}╯`));
    const hrMid = this.chrome("r:divider", `${width}`, () => row(th.fg("dim", "─".repeat(innerW))));

    lines.push(hrTop);
    lines.push(this.chrome("r:header", `${width}|${this.headerKey()}`, () => row(this.headerText())));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(this.chrome("r:invocation", `${width}|${invocationLine}`, () => row(invocationLine)));
    lines.push(hrMid);

    // Content area — cached lines, rebuilt only where the transcript changed.
    // Each is already clamped to innerW and its width known, so a row is
    // padded from the cache rather than measured and truncated every frame.
    const content = this.contentView(innerW);
    const totalLines = this.contentLength(content);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    for (let i = 0; i < viewportHeight; i++) {
      const { text, width: w } = this.contentLine(content, visibleStart + i);
      lines.push(border + " " + text + " ".repeat(Math.max(0, innerW - w)) + " " + border);
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      const scrollPct = totalLines <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / totalLines) * 100)}%`;
      const footerKey = `${width}|${this.canSteer()}|${this.canSendToBackground()}|${this.isStoppable()}|${this.stopArmed}|${this.markdownMode()}|${totalLines}|${scrollPct}`;
      lines.push(this.chrome("r:footer", footerKey, () => {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      // Abbreviated for the same reason as the Markdown group below.
      if (this.canSendToBackground()) actions.push(th.fg("dim", "b bg"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      // Abbreviated (`raw`/`md`/`md+`) because the idle footer is already full
      // at 80 columns with steer + stop present, and this group has no
      // degradation step below "drop the line-count readout".
      actions.push(th.fg("dim", `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`));
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
      const count = th.fg("dim", `${totalLines} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      return row(footerLeft + " ".repeat(footerGap) + footerRight);
      }));
    }
    lines.push(hrBot);

    return lines;
  }

  /**
   * The fullscreen observer (Pi's fullscreen renderer): the whole terminal,
   * borderless, with mouse scrolling, a scrollbar, clickable footer controls
   * and a jump-to-latest marker.
   *
   * Per-frame work is independent of the transcript's length: the cache is
   * validated from its unsettled tail only, rows come from cached lines and
   * widths, and only the visible rows are assembled. The scrollbar column is
   * reserved whenever the scrollbar can appear, so showing or hiding it never
   * re-wraps the transcript.
   */
  private renderFullscreen(width: number): string[] {
    this.footerTargets = [];
    this.latestTarget = undefined;
    this.viewport = undefined;
    const rows = Math.max(0, this.tui.terminal.rows);
    if (width <= SCROLLBAR_WIDTH + 1) return Array.from({ length: rows }, () => " ".repeat(Math.max(0, width)));
    const th = this.theme;
    const reserveBar = this.scrollView.scrollbar !== "hidden";
    const innerW = width - 1 - (reserveBar ? SCROLLBAR_WIDTH : 0);
    this.lastInnerW = innerW;
    const lines: string[] = [];
    const row = (content: string) => " " + truncateToWidth(content, width - 1, "...", true);
    const divider = this.chrome("f:divider", `${width}|${innerW}`, () => row(th.fg("dim", "─".repeat(innerW))));

    lines.push(this.chrome("f:header", `${width}|${this.headerKey()}`, () => row(this.headerText())));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(this.chrome("f:invocation", `${width}|${invocationLine}`, () => row(invocationLine)));
    lines.push(divider);

    const content = this.contentView(innerW);
    const totalLines = this.contentLength(content);
    const viewportHeight = this.viewportHeight();
    this.scrollView.updateLayout(totalLines, viewportHeight, this.requestRender);
    if (this.scrollView.isFollowingEnd) this.newMessages = 0;
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    const visibleStart = this.scrollView.scrollTop;
    // Pi's scrollbar geometry: rounded size, at least two rows when available.
    const thumbHeight = Math.min(viewportHeight, Math.max(2, Math.round((viewportHeight * viewportHeight) / Math.max(1, totalLines))));
    const thumbTop = maxScroll > 0 ? Math.round((visibleStart / maxScroll) * (viewportHeight - thumbHeight)) : 0;
    this.viewport = { width, top: lines.length, height: viewportHeight, maxScroll, thumbTop, thumbHeight };

    const showBar = this.scrollView.isScrollbarVisible;
    const track = showBar ? th.fg("scrollbarTrack", "│") : "";
    const thumb = showBar ? th.fg("scrollbarThumb", this.scrollView.isScrollbarActive ? "█" : "┃") : "";
    for (let i = 0; i < viewportHeight; i++) {
      const { text, width: w } = this.contentLine(content, visibleStart + i);
      if (!showBar) {
        lines.push(" " + text);
        continue;
      }
      const bar = i >= thumbTop && i < thumbTop + thumbHeight ? thumb : track;
      lines.push(" " + text + " ".repeat(Math.max(0, innerW - w)) + bar);
    }

    // The divider stays pinned above the footer, with the jump marker centered
    // in it while scrolled away; neither scrolling nor new messages move it.
    if (!this.scrollView.isFollowingEnd && maxScroll > 0) {
      const marker = this.chrome("f:marker", `${width}|${innerW}|${this.newMessages}`, () => {
        const text = this.newMessages > 0
          ? `${this.newMessages} new message${this.newMessages === 1 ? "" : "s"}`
          : "Jump to latest message";
        const label = truncateToWidth(`[ ↓ ${text} · Ctrl+End ]`, innerW, "…");
        const labelWidth = visibleWidth(label);
        const padding = Math.floor((innerW - labelWidth) / 2);
        return {
          start: padding + 1,
          end: padding + 1 + labelWidth,
          line: row(th.fg("dim", "─".repeat(padding)) + th.fg("accent", label) + th.fg("dim", "─".repeat(Math.max(0, innerW - padding - labelWidth)))),
        };
      });
      this.latestTarget = { row: lines.length, start: marker.start, end: marker.end };
      lines.push(marker.line);
    } else {
      lines.push(divider);
    }

    if (this.composer) {
      this.composer.focused = this.focused;
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
    }
    const scrollPct = totalLines <= viewportHeight
      ? "100%"
      : `${Math.round(((visibleStart + viewportHeight) / totalLines) * 100)}%`;
    const footerKey = this.composer
      ? `${width}|composer`
      : `${width}|${this.canSteer()}|${this.canSendToBackground()}|${this.isStoppable()}|${this.stopArmed}|${this.markdownMode()}|${totalLines}|${scrollPct}`;
    const { footer, targets } = this.chrome("f:footer", footerKey, () => this.fullscreenFooter(innerW, totalLines, scrollPct, row));
    this.footerTargets = targets;

    // The footer stays on screen even in a terminal shorter than the chrome.
    return rows > 0 ? [...lines.slice(0, rows - 1), footer] : [];
  }

  /** The fullscreen footer row and its clickable controls, by column. */
  private fullscreenFooter(
    innerW: number,
    totalLines: number,
    scrollPct: string,
    row: (content: string) => string,
  ): { footer: string; targets: { start: number; end: number; key: string }[] } {
    const th = this.theme;
    const footerActions: { label: string; key: string }[] = [];
    let footer: string;
    if (this.composer) {
      footerActions.push({ label: "Enter send", key: "\r" }, { label: "Esc cancel", key: "\x1b" });
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      footer = row(composeLeft + " ".repeat(Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint))) + composeHint);
    } else {
      const sep = th.fg("dim", " · ");
      if (this.canSteer()) footerActions.push({ label: "Enter steer", key: "\r" });
      if (this.canSendToBackground()) footerActions.push({ label: "b bg", key: "b" });
      if (this.isStoppable()) footerActions.push({ label: this.stopArmed ? "x again to STOP" : "x stop", key: "x" });
      footerActions.push({ label: `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`, key: "m" });
      const actions = footerActions.map(a => th.fg(a.key === "x" && this.stopArmed ? "error" : "dim", a.label));
      footerActions.push({ label: "Esc close", key: "\x1b" });
      const footerRight = th.fg("dim", "wheel/↑↓ scroll · PgUp/PgDn · Esc close");
      const count = th.fg("dim", `${totalLines} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW ? withCount : actions.join(sep);
      footer = row(footerLeft + " ".repeat(Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight))) + footerRight);
    }

    const targets: { start: number; end: number; key: string }[] = [];
    const footerText = stripTerminalSequences(footer);
    for (const action of footerActions) {
      const index = footerText.indexOf(action.label);
      if (index < 0) continue; // a clipped label is not a clickable control
      const start = visibleWidth(footerText.slice(0, index));
      targets.push({ start, end: start + visibleWidth(action.label), key: action.key });
    }
    return { footer, targets };
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /**
   * Asked of the owner rather than derived from the record: only the caller
   * blocked on this run knows it can let go of it, and `blocking` alone also
   * matches spawns nobody can hand off (the agent generator).
   */
  private canSendToBackground(): boolean {
    return this.onBackground?.available() === true;
  }

  /** The mode in force: an `m` press, else the setting, else the default. */
  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  /** Wrap `text` literally — the pre-Markdown path, and the fallback from it. */
  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(sanitizeTerminalText(text), width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  /** Render `text` as Markdown, reusing this message's component instance. */
  private markdownLines(msg: AgentSession["messages"][number], raw: string, width: number, dim: boolean): string[] {
    const text = sanitizeTerminalText(raw);
    let entry = this.markdownCache.get(msg);
    if (!entry) {
      entry = {
        md: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          // Keeps result prose visually receded, the way the raw path's
          // per-line `fg("dim", …)` did. Fenced code is the exception and is
          // left alone deliberately: pi's theme highlights it with its own
          // colors, which this would otherwise flatten.
          dim ? { color: (t: string) => this.theme.fg("dim", t) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
      };
      this.markdownCache.set(msg, entry);
    } else if (entry.text !== text) {
      // Streaming: the message object is stable, its text grows. A failed
      // prefix remains unsafe after append-only deltas, so retry only when the
      // content was replaced or truncated.
      const shouldRetry = !text.startsWith(entry.text);
      entry.md.setText(text);
      entry.text = text;
      if (shouldRetry) entry.failed = false;
    }
    if (entry.failed) return this.rawLines(text, width, dim);

    try {
      return entry.md.render(width);
    } catch {
      // The parser is recursive and this is arbitrary tool output: ~54 nested
      // blockquotes overflow the stack, and no amount of fuzzing proves that is
      // the only such input. `render()` is on the TUI's critical path, so a
      // throw here takes the overlay down for content the literal path shows
      // fine — degrade to that instead, and remember, since the throw would
      // otherwise repeat on every render and every scroll key.
      entry.failed = true;
      return this.rawLines(text, width, dim);
    }
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cacheWidth = -1;
    this.chromeCache.clear();
  }

  dispose(): void {
    this.closed = true;
    this.scrollView.setScrollbar("hidden"); // clears the scrollbar's auto-hide timer
    if (this.streamRenderTimer) {
      clearTimeout(this.streamRenderTimer);
      this.streamRenderTimer = undefined;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    if (this.fullscreen) return Math.max(0, this.tui.terminal.rows - this.chromeLines());
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return (this.fullscreen ? FULLSCREEN_CHROME_LINES : CHROME_LINES_BASE) + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    // Canonical id here, short label everywhere else: this overlay is opened to
    // inspect one agent and has the width for it, and two providers can serve
    // models whose short names read alike.
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = model ? [model, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  /** Every content line, transcript then activity indicator, as one copy. Rendering uses `contentView`. */
  buildContentLines(width: number): string[] {
    const { base, tail } = this.contentView(width);
    return [...base, ...tail];
  }

  private contentLength(view: { base: string[]; tail: string[] }): number {
    return view.base.length + view.tail.length;
  }

  /**
   * The content area as cached transcript lines (`base`, owned by the viewer —
   * do not mutate) plus the live activity indicator (`tail`).
   *
   * Only messages that changed are rebuilt. A message is matched to its block
   * by identity; messages from `unsettledFrom` on (the last one when the
   * previous frame was drawn, and anything after it) are also compared by
   * content, because older pi streams into the last message in place and a
   * message can be edited and then pushed past before the next frame. Earlier
   * messages are settled: pi never rewrites a message once another follows it,
   * and compaction replaces the objects, which the identity check catches.
   */
  private contentView(width: number): { base: string[]; tail: string[] } {
    if (width <= 0) return { base: [], tail: [] };
    const th = this.theme;
    const messages = this.session.messages;

    if (messages.length === 0) {
      return { base: [truncateToWidth(th.fg("dim", "(waiting for first message...)"), width)], tail: [] };
    }

    const mode = this.markdownMode();
    if (width !== this.cacheWidth || mode !== this.cacheMode) {
      this.blocks = [];
      this.blockStart = [];
      this.lines = [];
      this.lineWidths = [];
      this.cacheWidth = width;
      this.cacheMode = mode;
      this.unsettledFrom = 0;
      this.cacheMessages = undefined;
    }

    // First block that no longer matches its message. The same array as last
    // frame has only grown at its end, so its settled part needs no check.
    let stale = Math.min(this.blocks.length, messages.length);
    const from = messages === this.cacheMessages && this.blocks.length <= messages.length ? Math.min(this.unsettledFrom, stale) : 0;
    this.cacheMessages = messages;
    for (let i = Math.max(0, from); i < stale; i++) {
      const block = this.blocks[i];
      if (block.msg !== messages[i] || (i >= this.unsettledFrom && block.source !== this.messageSource(messages[i]))) {
        stale = i;
        break;
      }
    }

    if (stale < this.blocks.length || stale < messages.length) {
      this.lines.length = stale < this.blockStart.length ? this.blockStart[stale] : this.lines.length;
      this.lineWidths.length = this.lines.length;
      this.blocks.length = stale;
      this.blockStart.length = stale;
      // Any line before the first rebuilt block means a block rendered there.
      let needsSeparator = this.lines.length > 0;
      const separator = truncateToWidth(th.fg("dim", "───"), width);
      const separatorWidth = visibleWidth(separator);
      for (let i = stale; i < messages.length; i++) {
        const msg = messages[i];
        const source = this.messageSource(msg);
        const body = this.messageLines(msg, width, mode);
        this.blocks.push({ msg, source, lines: body });
        this.blockStart.push(this.lines.length);
        if (!body) continue;
        if (needsSeparator) {
          this.lines.push(separator);
          this.lineWidths.push(separatorWidth);
        }
        for (const line of body) {
          this.lines.push(line);
          this.lineWidths.push(visibleWidth(line));
        }
        needsSeparator = true;
      }
    }
    this.unsettledFrom = messages.length - 1;

    // Streaming indicator for running agents
    const tail: string[] = [];
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      tail.push("", truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", sanitizeTerminalText(act)), width));
    }

    return { base: this.lines, tail };
  }

  /**
   * Everything a message's rendered lines depend on, besides width and mode.
   * Cheap next to rendering: string joins, no wrapping or parsing.
   */
  private messageSource(msg: AgentSession["messages"][number]): string {
    const m = msg as any;
    switch (m.role) {
      case "user":
        return typeof m.content === "string" ? m.content : extractText(m.content);
      case "assistant": {
        let out = "";
        for (const c of m.content) {
          if (c.type === "text" && c.text) out += `t${c.text.length}:${c.text}`;
          else if (c.type === "toolCall") out += `c${c.name ?? c.toolName ?? "unknown"}\n`;
        }
        return out;
      }
      case "toolResult":
        return extractText(m.content);
      case "bashExecution":
        return `${String(m.command)}\n${m.output ?? ""}`;
      default:
        return "";
    }
  }

  /** One message's lines without its separator, clamped to `width`; undefined when it renders nothing. */
  private messageLines(msg: AgentSession["messages"][number], width: number, mode: ViewerMarkdownMode): string[] | undefined {
    const th = this.theme;
    const lines: string[] = [];
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (!text.trim()) return undefined;
      lines.push(th.fg("accent", "[User]"));
      for (const line of wrapTextWithAnsi(sanitizeTerminalText(text.trim()), width)) {
        lines.push(line);
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") {
          toolCalls.push((c as any).name ?? (c as any).toolName ?? "unknown");
        }
      }
      lines.push(th.bold("[Assistant]"));
      if (textParts.length > 0) {
        const text = textParts.join("\n").trim();
        lines.push(...(mode === "off"
          ? this.rawLines(text, width, false)
          : this.markdownLines(msg, text, width, false)));
      }
      for (const name of toolCalls) {
        lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${sanitizeTerminalText(name)}]`), width));
      }
    } else if (msg.role === "toolResult") {
      const { text, elided } = capResult(extractText(msg.content).trim());
      if (!text) return undefined;
      lines.push(th.fg("dim", "[Result]"));
      lines.push(...(mode === "all"
        ? this.markdownLines(msg, text, width, true)
        : this.rawLines(text, width, true)));
      if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
    } else if ((msg as any).role === "bashExecution") {
      const bash = msg as any;
      lines.push(truncateToWidth(th.fg("muted", `  $ ${sanitizeTerminalText(String(bash.command))}`), width));
      if (bash.output?.trim()) {
        // Same cap as a tool result, never Markdown: command output is the one
        // thing here that is definitionally not authored as Markdown.
        const { text, elided } = capResult(bash.output.trim());
        lines.push(...this.rawLines(text, width, true));
        if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
      }
    } else {
      return undefined;
    }
    return lines.map(l => truncateToWidth(l, width));
  }
}
