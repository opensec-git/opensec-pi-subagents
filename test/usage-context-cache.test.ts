/**
 * The per-frame context percentage must not call pi's O(entries)
 * `getSessionStats()` once per running agent per frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentActivity, AgentWidget } from "../src/ui/agent-widget.js";
import { getCachedSessionContextPercent } from "../src/usage.js";

function eventedSession(percent: () => number | null) {
  const listeners: ((e: { type: string }) => void)[] = [];
  const stats = vi.fn(() => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: percent() } }));
  return {
    getSessionStats: stats,
    subscribe: (l: (e: { type: string }) => void) => { listeners.push(l); return () => {}; },
    emit: (type: string) => { for (const l of listeners) l({ type }); },
    stats,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("getCachedSessionContextPercent", () => {
  it("computes once, then only after a session event that records something", () => {
    let p = 10;
    const s = eventedSession(() => p);
    for (let i = 0; i < 50; i++) expect(getCachedSessionContextPercent(s)).toBe(10);
    expect(s.stats).toHaveBeenCalledTimes(1);

    // Streaming deltas do not change the session entries the percent reads.
    p = 20;
    s.emit("message_update");
    s.emit("tool_execution_update");
    expect(getCachedSessionContextPercent(s)).toBe(10);
    expect(s.stats).toHaveBeenCalledTimes(1);

    s.emit("message_end");
    expect(getCachedSessionContextPercent(s)).toBe(20);
    expect(getCachedSessionContextPercent(s)).toBe(20);
    expect(s.stats).toHaveBeenCalledTimes(2);

    // A compaction resets the percent to unknown.
    p = null as unknown as number;
    s.emit("compaction_end");
    expect(getCachedSessionContextPercent(s)).toBeNull();
  });

  it("refreshes an evented session on a slow backstop", () => {
    let p = 10;
    const s = eventedSession(() => p);
    getCachedSessionContextPercent(s);
    p = 30;
    vi.advanceTimersByTime(4_000);
    expect(getCachedSessionContextPercent(s)).toBe(10);
    vi.advanceTimersByTime(1_000);
    expect(getCachedSessionContextPercent(s)).toBe(30);
  });

  it("polls at most once a second for a session that has no events", () => {
    let p = 10;
    const stats = vi.fn(() => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: p } }));
    const s = { getSessionStats: stats };
    getCachedSessionContextPercent(s);
    getCachedSessionContextPercent(s);
    expect(stats).toHaveBeenCalledTimes(1);
    p = 40;
    vi.advanceTimersByTime(1_000);
    expect(getCachedSessionContextPercent(s)).toBe(40);
    expect(stats).toHaveBeenCalledTimes(2);
  });

  it("returns null for no session and for stats that throw", () => {
    expect(getCachedSessionContextPercent(undefined)).toBeNull();
    expect(getCachedSessionContextPercent({ getSessionStats: () => { throw new Error("x"); } })).toBeNull();
  });
});

describe("AgentWidget frames", () => {
  it("draw the context percentage without re-reading session stats every frame", () => {
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const records = [0, 1, 2].map(i => ({
      id: `a${i}`,
      type: "general-purpose",
      description: `a${i} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
      isBackground: true,
    }));
    const sessions = records.map(() => eventedSession(() => 42));
    const acts = new Map<string, AgentActivity>(records.map((r, i) => [r.id, {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1, session: sessions[i],
    }]));
    const widget = new AgentWidget({ listAgents: () => records } as any, acts, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } });
    widget.update();
    const component = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme);
    let out: string[] = [];
    for (let i = 0; i < 30; i++) out = component.render();

    expect(out.join("\n")).toContain("1.0k token (42%)");
    for (const s of sessions) expect(s.stats).toHaveBeenCalledTimes(1);
    widget.dispose();
  });
});
