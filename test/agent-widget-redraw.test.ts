/**
 * agent-widget-redraw.test.ts — the widget asks the TUI for a frame only when
 * its text changes.
 *
 * Every widget redraw is a whole TUI frame, and a frame costs time in
 * proportion to the main session's length. The 80 ms tick used to request one
 * on every tick while any agent ran or waited, also when the main agent was
 * idle and the text had not changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentActivity, AgentWidget, SPINNER } from "../src/ui/agent-widget.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const T0 = new Date("2026-01-01T00:00:00Z").getTime();

function record(id: string, status = "running") {
  return {
    id,
    type: "general-purpose",
    description: `${id} description`,
    status,
    toolUses: 2,
    startedAt: T0,
    completedAt: undefined as number | undefined,
    lifetimeUsage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
    isBackground: true,
  };
}

function activity(): AgentActivity {
  return { activeTools: new Map(), toolUses: 2, responseText: "working", turnCount: 3 };
}

/**
 * A TUI like pi's: requestRender() calls coalesce into one frame, which renders
 * the component; draw() is a frame the TUI makes for its own reasons (the main
 * agent streaming, a key press).
 */
function mount(records: ReturnType<typeof record>[]) {
  const acts = new Map(records.filter(r => r.status === "running").map(r => [r.id, activity()]));
  const widget = new AgentWidget({ listAgents: () => records } as any, acts, () => "all");
  let component: { render(): string[] } | undefined;
  let pending = false;
  const requested: string[][] = [];
  const shown: string[][] = [];
  const tui = {
    terminal: { columns: 160 },
    requestRender: () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        const lines = component?.render() ?? [];
        requested.push(lines);
        shown.push(lines);
      });
    },
  };
  widget.setUICtx({
    setStatus: () => {},
    setWidget: (_key, content) => {
      component = content ? content(tui, theme) : undefined;
      if (component) shown.push(component.render()); // pi draws a new widget at once
    },
  });
  widget.ensureTimer();
  widget.update();
  return {
    widget,
    acts,
    tui,
    /** Frames the widget asked for. */
    requested,
    /** Everything drawn, requested or not. */
    shown,
    draw: () => { shown.push(component?.render() ?? []); },
  };
}

const spinnerOf = (lines: string[]) => SPINNER.find(g => lines[1]?.includes(` ${g} `));
const elapsedOf = (lines: string[]) => lines[1]?.match(/ (\d+\.\d)s$/)?.[1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("AgentWidget redraws", () => {
  it("with the main agent idle, steps the spinner and clock once every third tick", async () => {
    const h = mount([record("bg")]);
    await vi.advanceTimersByTimeAsync(2400); // 30 ticks
    expect(h.requested).toHaveLength(10);
    // Each requested frame shows the next spinner glyph and a clock 0.24 s on.
    const glyphs = h.requested.map(spinnerOf);
    for (let i = 1; i < glyphs.length; i++) {
      expect(SPINNER.indexOf(glyphs[i]!)).toBe((SPINNER.indexOf(glyphs[i - 1]!) + 1) % SPINNER.length);
    }
    expect(h.requested.map(elapsedOf)).toEqual(["0.2", "0.5", "0.7", "1.0", "1.2", "1.4", "1.7", "1.9", "2.2", "2.4"]);
    // No requested frame repeats the one before it.
    for (let i = 1; i < h.shown.length; i++) expect(h.shown[i]).not.toEqual(h.shown[i - 1]);
    h.widget.dispose();
  });

  it("requests no frame while nothing on it moves, though the timer runs for a queued agent", async () => {
    const h = mount([record("q", "queued")]);
    expect(h.shown).toEqual([["● Agents", "└─ ◦ 1 queued"]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((h.widget as any).ticker.has(h.widget)).toBe(true);
    expect(h.requested).toHaveLength(0);
    h.widget.dispose();
  });

  it("shows another change on the next tick, leaving the spinner and clock to their cadence", async () => {
    const agent = record("bg");
    const h = mount([agent]);
    await vi.advanceTimersByTimeAsync(240); // the first idle step
    expect(h.requested).toHaveLength(1);
    const before = h.requested[0];

    h.acts.get(agent.id)!.responseText = "reading the config";
    await vi.advanceTimersByTimeAsync(80);
    expect(h.requested).toHaveLength(2);
    const after = h.requested[1];
    expect(after[2]).toContain("reading the config");
    expect(spinnerOf(after)).toBe(spinnerOf(before));
    expect(elapsedOf(after)).toBe("0.2");

    // The next step is three ticks after the last one.
    await vi.advanceTimersByTimeAsync(80);
    expect(h.requested).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(80);
    expect(h.requested).toHaveLength(3);
    expect(SPINNER.indexOf(spinnerOf(h.requested[2])!)).toBe((SPINNER.indexOf(spinnerOf(before)!) + 1) % SPINNER.length);
    h.widget.dispose();
  });

  it("steps the spinner on every tick while the TUI draws frames anyway", async () => {
    const h = mount([record("bg")]);
    const stream = setInterval(h.draw, 16); // the main agent streaming at 60 fps
    await vi.advanceTimersByTimeAsync(800); // 10 ticks
    clearInterval(stream);
    // A new glyph and clock on each tick, as before this change, carried by the
    // TUI's own frames: the widget asks for none.
    const glyphs = [...new Set(h.shown.map(spinnerOf))];
    expect(glyphs.length).toBe(SPINNER.length);
    expect(new Set(h.shown.map(elapsedOf))).toContain("0.8");
    expect(h.requested).toHaveLength(0);
    h.widget.dispose();
  });

  it("goes back to the idle cadence when the TUI stops drawing", async () => {
    const h = mount([record("bg")]);
    const stream = setInterval(h.draw, 16);
    await vi.advanceTimersByTimeAsync(800);
    clearInterval(stream);
    await vi.advanceTimersByTimeAsync(80); // the tick that sees the last streamed frame moves the clock
    expect(h.requested).toHaveLength(0);
    // The next tick draws that step, then every third tick draws the next.
    await vi.advanceTimersByTimeAsync(80);
    expect(h.requested).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2400);
    expect(h.requested).toHaveLength(11);
    h.widget.dispose();
  });

  it("adds no frame for Pi's own 80 ms frames, and moves with them", async () => {
    const h = mount([record("bg")]);
    await vi.advanceTimersByTimeAsync(37);
    const loader = setInterval(h.draw, 80); // Pi's working indicator, out of phase with the tick
    await vi.advanceTimersByTimeAsync(800);
    clearInterval(loader);
    expect(h.requested).toHaveLength(0);
    expect(new Set(h.shown.map(spinnerOf)).size).toBe(SPINNER.length);
    h.widget.dispose();
  });

  it("does not add a frame for a single frame the TUI draws (a key press): it shifts the next step", async () => {
    const h = mount([record("bg")]);
    await vi.advanceTimersByTimeAsync(1000);
    h.draw();
    await vi.advanceTimersByTimeAsync(1400);
    expect(h.requested).toHaveLength(10); // as many as with no key press
    h.widget.dispose();
  });

  it("requests a frame at once for a status change, without waiting for a tick", async () => {
    const agent = record("bg");
    const h = mount([agent]);
    await vi.advanceTimersByTimeAsync(10);
    agent.status = "completed";
    agent.completedAt = Date.now();
    h.acts.delete(agent.id);
    h.widget.markFinished(agent.id);
    h.widget.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requested).toEqual([["○ Agents", "└─ ✓ Agent (twin)  bg description · 2 tool uses · 0.0s"]]);
    h.widget.dispose();
  });
});
