/**
 * conversation-viewer-fullscreen.test.ts — the fullscreen observer is built on
 * the incremental viewer, and keeps its cost profile.
 *
 * Pi-Bolt runs without a JIT, where every per-frame line of JS costs 10-36x
 * more. So the observer's interaction paths must do work proportional to the
 * screen, never to the transcript: scrolling, wheeling and dragging reuse the
 * cached lines, a frame validates only the transcript's unsettled tail, only
 * visible rows are assembled, and nothing ticks while the viewer is idle.
 */
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

// The transcript is drawn with Pi's components, which read Pi's global theme.
initTheme("dark", false);

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const COLS = 100;
const ROWS = 30;

function transcript(n: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    out.push(i % 2 === 0
      ? { role: "user", content: `question ${i}\nwith a second line`, timestamp: 0 }
      : { role: "assistant", content: [{ type: "text", text: `answer ${i}\n\nline two\n\nline three` }], stopReason: "stop", timestamp: 0 });
  }
  return out;
}

function setup(n: number, scrollbar: "auto" | "always" | "hidden" = "always") {
  const listeners: ((e: any) => void)[] = [];
  const session = {
    messages: transcript(n),
    subscribe: (l: (e: any) => void) => { listeners.push(l); return () => {}; },
    dispose: () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  };
  const record = { id: "a", type: "general-purpose", description: "fullscreen", status: "running", toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } } as any;
  const tui = { mode: "fullscreen", terminal: { rows: ROWS, columns: COLS }, requestRender: vi.fn() };
  const viewer: any = new ConversationViewer(
    tui as any, session as any, record, undefined, theme, () => {}, () => {}, undefined, () => {}, false, undefined, scrollbar,
  );
  const mouse = (event: Record<string, unknown>) => viewer.handleMouse({
    type: "wheel", button: "none", x: 10, y: 8, screenX: 10, screenY: 8, width: COLS, height: ROWS, shift: false, alt: false, ctrl: false, ...event,
  });
  const emit = (event: any) => { for (const l of listeners) l(event); };
  return { viewer, session, tui, mouse, emit };
}

afterEach(() => vi.useRealTimers());

/** Pi component renders so far (each one is a block re-rendered). */
const renders = (viewer: any): number => viewer.transcript.renders;

describe("fullscreen observer cost profile", () => {
  it("scroll keys, wheel and scrollbar drags rebuild no lines", () => {
    const { viewer, mouse } = setup(200);
    viewer.render(COLS);
    const built = renders(viewer);

    for (let i = 0; i < 20; i++) { viewer.handleInput("\x1b[A"); viewer.render(COLS); }
    for (let i = 0; i < 20; i++) { mouse({ wheelDelta: i % 2 ? 3 : -3 }); viewer.render(COLS); }
    // Grab the thumb, drag it to the top and back, release.
    const view = viewer.viewport;
    mouse({ type: "press", button: "left", x: COLS - 1, y: view.top + view.thumbTop });
    for (const y of [view.top, view.top + view.height - 1, view.top + 3]) { mouse({ type: "drag", button: "left", x: COLS - 1, y }); viewer.render(COLS); }
    mouse({ type: "release", button: "left", x: COLS - 1, y: view.top + 3 });
    viewer.render(COLS);

    expect(renders(viewer)).toBe(built);
  });

  it("validates only the unsettled tail on a frame, however long the transcript", () => {
    for (const n of [200, 2000]) {
      const { viewer, session } = setup(n);
      viewer.render(COLS);
      const built = renders(viewer);
      const lines = viewer.transcript.lines;
      const copy = [...lines];
      for (let i = 0; i < 10; i++) viewer.render(COLS);
      // Nothing re-rendered and the line array was not even rebuilt.
      expect(renders(viewer)).toBe(built);
      expect(viewer.transcript.lines).toBe(lines);
      expect(lines).toEqual(copy);

      session.messages.push({ role: "user", content: "one more", timestamp: 0 });
      viewer.render(COLS);
      expect(renders(viewer)).toBe(built + 1);
    }
  });

  it("assembles exactly one terminal screen, whatever the transcript's length", () => {
    const { viewer } = setup(2000);
    const out = viewer.render(COLS);
    expect(out).toHaveLength(ROWS);
  });

  it("re-checks every message after the array is replaced (compaction) and draws what a fresh viewer draws", () => {
    const { viewer, session } = setup(50);
    viewer.render(COLS);
    session.messages = [{ role: "user", content: "summary of earlier work" }, ...session.messages.slice(-3)];
    const fresh = setup(0);
    fresh.session.messages = session.messages;
    expect(viewer.render(COLS)).toEqual(fresh.viewer.render(COLS));
  });

  it("arms no timer while idle; the auto scrollbar's hide timer runs once after activity and is cleared on close", () => {
    vi.useFakeTimers();
    const { viewer, mouse } = setup(200, "auto");
    viewer.render(COLS);
    for (let i = 0; i < 5; i++) viewer.render(COLS);
    expect(vi.getTimerCount()).toBe(0);

    mouse({ wheelDelta: -3 });
    viewer.render(COLS);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);

    mouse({ wheelDelta: -3 });
    viewer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces streaming events into one redraw per frame, and counts only new messages while scrolled away", () => {
    vi.useFakeTimers();
    const { viewer, tui, mouse, emit } = setup(200);
    viewer.render(COLS);
    mouse({ wheelDelta: -10 });
    viewer.render(COLS);
    tui.requestRender.mockClear();

    for (let i = 0; i < 50; i++) emit({ type: "message_update" });
    expect(tui.requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_end", message: { role: "assistant" } });
    emit({ type: "message_start", message: { role: "system" } });
    expect(viewer.render(COLS).join("\n")).toContain("1 new message · Ctrl+End");
  });
});
