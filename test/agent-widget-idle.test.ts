/**
 * agent-widget-idle.test.ts — the widget's refresh timer runs only while
 * something on it moves.
 *
 * Finished rows are static: no spinner, a frozen duration. Before this, a
 * finished row kept the 80 ms interval alive until the parent's next tool call,
 * so a background agent whose completion the model answered in plain text
 * redrew the whole TUI 12.5 times a second, forever, with identical output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentActivity, AgentWidget } from "../src/ui/agent-widget.js";

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

function harness(records: ReturnType<typeof record>[]) {
  const acts = new Map(records.map(r => [r.id, activity()]));
  const widget = new AgentWidget({ listAgents: () => records } as any, acts, () => "all");
  let requestRenders = 0;
  let registered = false;
  let component: { render(): string[] } | undefined;
  const tui = { terminal: { columns: 160 }, requestRender: () => { requestRenders++; } };
  widget.setUICtx({
    setStatus: () => {},
    setWidget: (_key, content) => {
      registered = !!content;
      component = content ? content(tui, theme) : undefined;
    },
  });
  return {
    widget,
    acts,
    render: () => component?.render() ?? [],
    get registered() { return registered; },
    get requestRenders() { return requestRenders; },
    resetCount: () => { requestRenders = 0; },
    timerAlive: () => !!(widget as any).widgetInterval,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("AgentWidget refresh timer", () => {
  it("draws the same lines, and stops redrawing once only finished rows remain", () => {
    const agent = record("bg");
    const h = harness([agent]);
    h.widget.ensureTimer();
    h.widget.update();

    vi.advanceTimersByTime(1000);
    expect(h.requestRenders).toBeGreaterThan(5); // spinner ticks while running
    expect(h.render()).toEqual([
      "● Agents",
      "└─ ⠸ Agent (twin)  bg description · ↻3 · 2 tool uses · 1.2k token · 1.0s",
      "     ⎿  working",
    ]);

    // Completion, as sendIndividualNudge does it. The parent then answers in
    // text — no tool_execution_start, so no onTurnStart.
    agent.status = "completed";
    agent.completedAt = T0 + 1500;
    vi.setSystemTime(T0 + 1500);
    h.acts.delete(agent.id);
    h.widget.markFinished(agent.id);
    h.widget.update();
    const finished = h.render();
    expect(finished).toEqual([
      "○ Agents",
      "└─ ✓ Agent (twin)  bg description · 2 tool uses · 1.5s",
    ]);

    h.resetCount();
    vi.advanceTimersByTime(10_000);
    expect(h.timerAlive()).toBe(false);
    expect(h.requestRenders).toBe(0);
    expect(h.render()).toEqual(finished);
  });

  it("ages a finished row out by time when the parent makes no tool call", () => {
    const agent = record("bg", "completed");
    agent.completedAt = T0;
    const h = harness([agent]);
    h.widget.markFinished(agent.id);
    h.widget.update();
    expect(h.registered).toBe(true);

    vi.advanceTimersByTime(29_000);
    expect(h.registered).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(h.registered).toBe(false);
    expect(h.requestRenders).toBe(0);
  });

  it("lets an error row linger longer than a success, as the turn rule does", () => {
    const ok = { ...record("ok", "completed"), completedAt: T0 };
    const bad = { ...record("bad", "error"), completedAt: T0 };
    const h = harness([ok, bad]);
    h.widget.markFinished(ok.id);
    h.widget.markFinished(bad.id);
    h.widget.update();

    vi.advanceTimersByTime(31_000);
    const lines = h.render().join("\n");
    expect(lines).not.toContain("ok description");
    expect(lines).toContain("bad description");

    vi.advanceTimersByTime(30_000);
    expect(h.registered).toBe(false);
  });

  it("still ages finished rows on the parent's tool calls", () => {
    const agent = { ...record("bg", "completed"), completedAt: T0 };
    const h = harness([agent]);
    h.widget.markFinished(agent.id);
    h.widget.update();
    expect(h.registered).toBe(true);

    h.widget.onTurnStart();
    expect(h.registered).toBe(false);
  });

  it("keeps ticking while an agent is queued, and restarts when one runs again", () => {
    const q = record("q", "queued");
    const h = harness([q]);
    h.widget.update();
    expect(h.timerAlive()).toBe(true);

    q.status = "completed";
    q.completedAt = T0;
    h.widget.markFinished(q.id);
    h.widget.update();
    expect(h.timerAlive()).toBe(false);

    q.status = "running";
    h.widget.markRunning(q.id);
    h.widget.update();
    expect(h.timerAlive()).toBe(true);
    h.widget.dispose();
    expect(h.timerAlive()).toBe(false);
  });
});
