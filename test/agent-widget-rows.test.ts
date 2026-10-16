/**
 * agent-widget-rows.test.ts — the widget formats only the rows it shows and
 * reuses a frame until something changes, without changing a single line.
 *
 * The snapshot was recorded from the implementation that formatted every row
 * and then dropped the overflow, so it pins the layout (connectors, overflow
 * budget, queued reservation, the "+N more" summary) across the rewrite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentActivity, AgentWidget } from "../src/ui/agent-widget.js";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };
const FINISHED_STATUSES = ["completed", "error", "steered", "stopped", "aborted"];

function fleet(running: number, queued: number, finished: number) {
  const records: any[] = [];
  const acts = new Map<string, AgentActivity>();
  let i = 0;
  const base = (status: string) => {
    const n = i++;
    return {
      id: `a${n}`,
      type: n % 2 ? "Explore" : "general-purpose",
      description: `agent ${n} doing a task with a fairly long description`,
      status,
      toolUses: n % 4,
      startedAt: T0 - 1000 * (n + 1),
      lifetimeUsage: { input: 100 * n, output: 10 * n, cacheRead: 0, cacheWrite: 0, cost: n % 3 ? 0.001 * n : 0 },
      compactionCount: n % 3,
      invocation: { modelName: "sonnet", thinking: n % 2 ? "high" : undefined, requestedThinking: n % 5 === 0 ? "max" : undefined },
      isBackground: true,
    } as any;
  };
  for (let n = 0; n < running; n++) {
    const r = base("running");
    records.push(r);
    const tools = new Map<string, string>();
    if (n % 3 === 1) tools.set("t1", "read");
    if (n % 3 === 2) { tools.set("t1", "grep"); tools.set("t2", "grep"); }
    acts.set(r.id, { activeTools: tools, toolUses: n, responseText: n % 2 ? "\n\n  first line of the reply  \nsecond" : "", turnCount: n + 1, maxTurns: n % 2 ? 20 : undefined });
  }
  for (let n = 0; n < queued; n++) records.push(base("queued"));
  for (let n = 0; n < finished; n++) {
    const r = base(FINISHED_STATUSES[n % FINISHED_STATUSES.length]);
    r.completedAt = T0 - 10;
    if (r.status === "error") r.error = "boom ".repeat(20);
    records.push(r);
  }
  return { records, acts };
}

function mount(records: any[], acts: Map<string, AgentActivity>, opts: { showCost?: boolean; showModel?: boolean } = {}) {
  const widget = new AgentWidget({ listAgents: () => records } as any, acts, () => "all", () => !!opts.showCost, () => !!opts.showModel);
  let factory: any;
  widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } });
  for (const r of records) if (r.completedAt) widget.markFinished(r.id);
  widget.update();
  return { widget, factory: () => factory };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("AgentWidget rows", () => {
  const cases: [number, number, number][] = [
    [0, 0, 1], [1, 0, 0], [0, 3, 0], [2, 1, 1], [3, 0, 4], [4, 2, 3], [5, 0, 0], [5, 1, 0],
    [6, 0, 0], [6, 3, 5], [0, 0, 11], [0, 0, 12], [0, 2, 15], [1, 0, 10], [10, 20, 30], [0, 5, 0],
  ];
  for (const [running, queued, finished] of cases) {
    for (const width of [70, 220]) {
      for (const flags of [{}, { showCost: true, showModel: true }]) {
        it(`${running} running, ${queued} queued, ${finished} finished, width ${width}${"showCost" in flags ? ", cost+model" : ""}`, () => {
          const { records, acts } = fleet(running, queued, finished);
          const { widget, factory } = mount(records, acts, flags);
          const lines = factory()?.({ terminal: { columns: width }, requestRender: () => {} }, theme).render() ?? [];
          expect(lines.join("\n")).toMatchSnapshot();
          widget.dispose();
        });
      }
    }
  }

  it("formats only the rows it shows", () => {
    const { records, acts } = fleet(100, 0, 0);
    let reads = 0;
    for (const r of records) {
      const real = r.description;
      Object.defineProperty(r, "description", { get: () => { reads++; return real; } });
    }
    const { widget, factory } = mount(records, acts);
    reads = 0;
    const lines = factory()({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render();
    expect(lines).toHaveLength(12);
    expect(reads).toBeLessThanOrEqual(5); // five running pairs fit
    widget.dispose();
  });

  it("reuses a frame until update() runs, then redraws", () => {
    const { records, acts } = fleet(2, 0, 1);
    const { widget, factory } = mount(records, acts);
    const component = factory()({ terminal: { columns: 200 }, requestRender: () => {} }, theme);
    const first = component.render();
    let listCalls = 0;
    const manager = (widget as any).manager;
    const list = manager.listAgents;
    manager.listAgents = () => { listCalls++; return list(); };

    expect(component.render()).toEqual(first);
    expect(listCalls).toBe(0);

    records[0].description = "changed";
    widget.update(); // the tick, or a status change
    expect(component.render().join("\n")).toContain("changed");
    widget.dispose();
  });

  it("redraws at a new width without waiting for a tick", () => {
    const { records, acts } = fleet(1, 0, 0);
    const { widget, factory } = mount(records, acts);
    const tui = { terminal: { columns: 200 }, requestRender: () => {} };
    const component = factory()(tui, theme);
    const wide = component.render();
    tui.terminal.columns = 40;
    const narrow = component.render();
    expect(narrow).not.toEqual(wide);
    widget.dispose();
  });
});
