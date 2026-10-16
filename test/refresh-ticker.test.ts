/**
 * refresh-ticker.test.ts — the widget and the fleet list redraw on one shared
 * clock, and the fleet list only ticks while a row changes with time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWidget } from "../src/ui/agent-widget.js";
import { FLEET_TICK_MS, FleetList } from "../src/ui/fleet-list.js";
import { RefreshTicker } from "../src/ui/refresh-ticker.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const T0 = new Date("2026-01-01T00:00:00Z").getTime();

function record(id: string, status = "running", completedAt?: number) {
  return {
    id,
    type: "general-purpose",
    description: `${id} description`,
    status,
    toolUses: 0,
    startedAt: T0,
    completedAt,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    isBackground: true,
    session: { messages: [], subscribe: () => () => {}, getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }) },
  } as any;
}

/** A TUI that, like pi's, turns any number of requestRender calls in one tick into one frame. */
function coalescingTui() {
  let pending = false;
  const tui = {
    frames: 0,
    terminal: { columns: 120, rows: 40 },
    requestRender: () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; tui.frames++; });
    },
  };
  return tui;
}

function fleetUi(tui: any) {
  return {
    setWidget: (_k: string, f: any) => { f?.(tui, theme); },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: () => new Promise<undefined>(() => {}),
  } as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("RefreshTicker", () => {
  it("runs every subscriber on one timer at its own period, and stops when empty", () => {
    const ticker = new RefreshTicker();
    const fast = vi.fn();
    const slow = vi.fn();
    const a = {};
    const b = {};
    ticker.set(a, 80, fast);
    ticker.set(b, 1000, slow);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(2000);
    expect(fast).toHaveBeenCalledTimes(25);
    expect(slow).toHaveBeenCalledTimes(2);

    ticker.delete(a);
    vi.advanceTimersByTime(3000);
    expect(slow).toHaveBeenCalledTimes(5);
    ticker.delete(b);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates a subscriber removing another during a tick", () => {
    const ticker = new RefreshTicker();
    const a = {};
    const b = {};
    const second = vi.fn();
    ticker.set(a, 80, () => ticker.delete(b));
    ticker.set(b, 80, second);
    vi.advanceTimersByTime(80);
    expect(second).not.toHaveBeenCalled();
    ticker.clear();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("widget and fleet list on a shared clock", () => {
  it("redraw on the widget's frames only, not on a second cadence", async () => {
    const records = [record("a")];
    const manager = { listAgents: () => records, abort: () => true } as any;
    const ticker = new RefreshTicker();
    const widget = new AgentWidget(manager, new Map(), () => "all", () => false, () => false, ticker);
    const fleet = new FleetList(manager, new Map(), () => false, undefined, undefined, ticker);
    const tui = coalescingTui();
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, f) => { f?.(tui, theme); } });
    fleet.setUICtx(fleetUi(tui));
    widget.update();
    fleet.update();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    // 25 widget ticks in 2 s; the fleet's two ticks share two of those frames.
    expect(tui.frames).toBe(25);
    widget.dispose();
    fleet.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("FleetList clock", () => {
  it("does not tick for an open overlay on an agent that finished long ago", async () => {
    const rec = record("done", "completed", T0 - 60_000);
    const fleet: any = new FleetList({ listAgents: () => [rec] } as any, new Map());
    const tui = coalescingTui();
    fleet.setUICtx(fleetUi(tui));
    fleet.viewingAgentId = rec.id; // conversation overlay open on it
    fleet.update();
    const lines = fleet.renderBar(120, theme);
    expect(lines.join("\n")).toContain("done description");

    await vi.advanceTimersByTimeAsync(5000);
    expect(tui.frames).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fleet.renderBar(120, theme)).toEqual(lines);
    fleet.dispose();
  });

  it("ticks once a second while an agent runs, and drops a finished row after its linger", async () => {
    const rec = record("a");
    const fleet: any = new FleetList({ listAgents: () => [rec] } as any, new Map());
    const tui = coalescingTui();
    let registered = false;
    fleet.setUICtx({ ...fleetUi(tui), setWidget: (_k: string, f: any) => { registered = !!f; f?.(tui, theme); } });
    fleet.update();
    expect(registered).toBe(true);

    await vi.advanceTimersByTimeAsync(3 * FLEET_TICK_MS);
    expect(tui.frames).toBe(3);
    expect(fleet.renderBar(120, theme).join("\n")).toMatch(/a description\s+3s/);

    rec.status = "completed";
    rec.completedAt = Date.now();
    fleet.onAgentFinished(rec.id);
    await vi.advanceTimersByTimeAsync(5 * FLEET_TICK_MS);
    expect(registered).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
