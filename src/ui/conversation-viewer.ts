/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates. The
 * transcript is drawn with Pi's own chat components (`viewer-transcript.ts`),
 * so it looks exactly like Pi's main session; the frame around it (header,
 * footer, scrolling, steering) is the viewer's.
 */

import { type AgentSession, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, matchesKey, type OverlayOptions, ScrollView, type ScrollViewScrollbar, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { getCachedSessionContextPercent, getLifetimeCost, getLifetimeTotal } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";
import { PiTranscript, type ViewerRenderOptions } from "./viewer-transcript.js";

export type { ViewerRenderOptions } from "./viewer-transcript.js";

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

/** Footer click target for the expand toggle, which may be bound to any key. */
const EXPAND_TARGET = "expand";

/** Message roles the fullscreen jump marker counts as "new messages" (not streaming updates). */
const COUNTED_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

/**
 * Session events that fire per streamed token or tool-output chunk. They are
 * coalesced into one redraw per frame; every other event redraws at once.
 */
const STREAMING_EVENTS = new Set(["message_update", "tool_execution_update"]);
/** Redraw cadence while streaming — the widget's spinner frame. */
const STREAM_FRAME_MS = 80;

/** The `b` affordance: whether this run can be handed to the background now, and the handoff. */
export interface ViewerBackgroundAction {
  available(): boolean;
  send(): void;
}

/**
 * Whether Pi's global theme is initialized. Pi's components read it while they
 * are built and rendered, and throw without it; Pi's interactive mode always
 * has one, tests and embedded sessions may not.
 */
function piThemeReady(): boolean {
  try {
    getMarkdownTheme().heading("probe");
    return true;
  } catch {
    return false;
  }
}

/**
 * The footer's left group, dropping what fits least first: the line-count
 * readout, then the expand hint (Pi's components already say "ctrl+o to
 * expand" beside anything collapsed), never the actions.
 */
function fitFooterLeft(count: string, actions: string[], expand: string | undefined, sep: string, room: number): string {
  const tail = expand ? [...actions, expand] : actions;
  for (const parts of [[count, ...tail], tail]) {
    const text = parts.join(sep);
    if (visibleWidth(text) <= room) return text;
  }
  return actions.join(sep);
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
  /**
   * The transcript drawn with Pi's components, its lines cached between
   * frames. Undefined when Pi's theme is not initialized (see `plainLines`).
   */
  private readonly transcript: PiTranscript | undefined;
  /** The plain fallback's lines and what they were built for. */
  private plain: { messages: readonly unknown[]; count: number; width: number; lines: string[]; widths: number[] } | undefined;
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
     * Hand this run to the background. `available` is read live — it turns
     * false the instant the handoff lands or the run ends. Omitted → no `b`
     * affordance (history views).
     */
    private onBackground?: ViewerBackgroundAction,
    /** Pi's `fullscreenScrollbar` preference, captured when the viewer opens. */
    scrollbarMode: ScrollViewScrollbar = "auto",
    /** Pi's chat settings (thinking blocks, padding, code indent), read when the viewer opens. */
    renderOptions?: ViewerRenderOptions,
  ) {
    this.fullscreen = tui.mode === "fullscreen";
    this.keys = createViewerKeys(keybindings);
    this.transcript = piThemeReady() ? new PiTranscript(session, this.requestRender, renderOptions) : undefined;
    this.scrollView = new ScrollView(
      { render: () => [], invalidate: () => {} },
      { follow: "end", scrollbar: this.fullscreen ? scrollbarMode : "hidden" },
    );
    this.unsubscribe = session.subscribe((event) => {
      if (this.closed) return;
      const e = event as Parameters<PiTranscript["handleEvent"]>[0] | undefined;
      if (e) this.transcript?.handleEvent(e);
      if (this.fullscreen && e?.type === "message_start" && !this.scrollView.isFollowingEnd && COUNTED_ROLES.has(e.message?.role ?? "")) {
        this.newMessages++;
      }
      if (STREAMING_EVENTS.has(e?.type ?? "")) {
        // A token delta redraws only the streamed message's block; one redraw
        // per frame is enough, and unthrottled it was one per token.
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

    // Expand or collapse tool output, as Pi's ctrl+o (`app.tools.expand`).
    if (this.keys.toggleExpand(data)) {
      this.toggleExpand();
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
          if (target.key === EXPAND_TARGET) this.toggleExpand();
          else this.handleInput(target.key);
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
  private contentLine(content: { base: string[]; widths: number[] | undefined; tail: string[] }, at: number): { text: string; width: number } {
    if (at < content.base.length) {
      const text = content.base[at];
      // The cached transcript has its widths; the empty-session placeholder does not.
      return { text, width: content.widths ? content.widths[at] : visibleWidth(text) };
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
      const footerKey = `${width}|${this.canSteer()}|${this.canSendToBackground()}|${this.isStoppable()}|${this.stopArmed}|${this.transcript?.isExpanded}|${totalLines}|${scrollPct}`;
      lines.push(this.chrome("r:footer", footerKey, () => {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      // Abbreviated: the idle footer is already full at 80 columns.
      if (this.canSendToBackground()) actions.push(th.fg("dim", "b bg"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      const expand = this.expandHint();
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
      const count = th.fg("dim", `${totalLines} lines · ${scrollPct}`);
      const footerLeft = fitFooterLeft(count, actions, expand && th.fg("dim", expand.label), sep, innerW - visibleWidth(footerRight) - 1);

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
      : `${width}|${this.canSteer()}|${this.canSendToBackground()}|${this.isStoppable()}|${this.stopArmed}|${this.transcript?.isExpanded}|${totalLines}|${scrollPct}`;
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
      const actions = footerActions.map(a => th.fg(a.key === "x" && this.stopArmed ? "error" : "dim", a.label));
      const expand = this.expandHint();
      if (expand) footerActions.push(expand);
      footerActions.push({ label: "Esc close", key: "\x1b" });
      const footerRight = th.fg("dim", "wheel/↑↓ scroll · PgUp/PgDn · Esc close");
      const count = th.fg("dim", `${totalLines} lines · ${scrollPct}`);
      const footerLeft = fitFooterLeft(count, actions, expand && th.fg("dim", expand.label), sep, innerW - visibleWidth(footerRight) - 1);
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

  /** Expand or collapse every tool, bash and summary block, as Pi's `app.tools.expand`. */
  private toggleExpand(): void {
    this.stopArmed = false;
    this.transcript?.setExpanded(!this.transcript.isExpanded);
    this.tui.requestRender();
  }

  /** The expand toggle's footer control: the key bound to it and what it does next. */
  private expandHint(): { label: string; key: string } | undefined {
    if (!this.transcript || !this.keys.expandLabel) return undefined;
    return { label: `${this.keys.expandLabel} ${this.transcript.isExpanded ? "collapse" : "expand"}`, key: EXPAND_TARGET };
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
    // Pi invalidates the TUI on a theme change: every block re-renders.
    this.transcript?.invalidate();
    this.plain = undefined;
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
    this.transcript?.dispose();
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
   * The content area as cached transcript lines (`base`, owned by the
   * transcript — do not mutate) with their widths, plus the live activity
   * indicator (`tail`). Only blocks that changed are re-rendered, so a frame
   * where nothing changed costs a few comparisons however long the transcript.
   */
  private contentView(width: number): { base: string[]; widths: number[] | undefined; tail: string[] } {
    if (width <= 0) return { base: [], widths: undefined, tail: [] };
    const th = this.theme;
    const transcript = this.transcript;
    if (transcript ? !transcript.hasContent : this.session.messages.length === 0) {
      return { base: [truncateToWidth(th.fg("dim", "(waiting for first message...)"), width)], widths: undefined, tail: [] };
    }

    let base: string[];
    let widths: number[];
    if (transcript) {
      transcript.sync(width);
      base = transcript.lines;
      widths = transcript.widths;
    } else {
      ({ lines: base, widths } = this.plainLines(width));
    }

    // Streaming indicator for running agents
    const tail: string[] = [];
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      tail.push("", truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", sanitizeTerminalText(act)), width));
    }

    return { base, widths, tail };
  }

  /**
   * The transcript as plain wrapped text, for a process whose Pi theme is not
   * initialized (Pi's components cannot render there). Never the case in Pi's
   * interactive mode; it keeps the viewer usable rather than throwing.
   */
  private plainLines(width: number): { lines: string[]; widths: number[] } {
    const messages = this.session.messages;
    const cached = this.plain;
    if (cached && cached.messages === messages && cached.count === messages.length && cached.width === width) return cached;
    const lines: string[] = [];
    for (const raw of messages) {
      const msg = raw as { role?: string; content?: unknown; command?: unknown; output?: unknown; summary?: unknown };
      let text = "";
      if (msg.role === "user" || msg.role === "toolResult" || msg.role === "custom") {
        text = typeof msg.content === "string" ? msg.content : extractText(msg.content as Parameters<typeof extractText>[0]);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        text = (msg.content as { type?: string; text?: string; name?: string }[])
          .map(c => c.type === "text" ? c.text ?? "" : c.type === "toolCall" ? `[${c.name ?? "tool"}]` : "")
          .filter(Boolean)
          .join("\n");
      } else if (msg.role === "bashExecution") {
        text = `$ ${String(msg.command)}\n${String(msg.output ?? "")}`;
      } else if (msg.role === "compactionSummary" || msg.role === "branchSummary") {
        text = String(msg.summary ?? "");
      }
      text = sanitizeTerminalText(text).trim();
      if (!text) continue;
      if (lines.length > 0) lines.push("");
      for (const line of wrapTextWithAnsi(text, width)) lines.push(truncateToWidth(line, width));
    }
    const plain = { messages, count: messages.length, width, lines, widths: lines.map(l => visibleWidth(l)) };
    this.plain = plain;
    return plain;
  }
}
