/**
 * render-invariants.perf.test.ts — the shape of the render paths, asserted as
 * operation counts rather than as time.
 *
 * These run in the normal suite, which means they run three times per CI push
 * (build, floor-Pi, latest-Pi) on shared runners. A wall-clock threshold there
 * would be a flake generator: two runs of identical code in this repo differed
 * by 7% on ordering alone. So nothing here is timed. Counting how many times a
 * render reaches a leaf is deterministic, costs milliseconds, and catches the
 * regression that actually hurts — work that stops being linear, or a frame
 * that starts touching the disk.
 *
 * Absolute numbers live in `test/perf/*.bench.ts`, where a human reads them.
 *
 * Every bound here is an upper bound, never an equality: making one of these
 * paths cheaper must not turn a test red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Counters for the pi-tui leaves the viewer wraps its text with. */
const counts = { wrap: 0, markdownNew: 0, markdownRender: 0 };

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends (actual.Markdown as any) {
    constructor(...args: any[]) {
      super(...args);
      counts.markdownNew++;
    }
    render(...args: any[]) {
      counts.markdownRender++;
      return super.render(...args);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    wrapTextWithAnsi: (...args: [string, number]) => {
      counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

// After the mock, so the subjects bind the counting versions.
const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { ConversationViewer } = await import("../../src/ui/conversation-viewer.js");
const { makeActivity, makeFleet, makeSession, mountViewer, perfTheme, perfTui, usePiTheme } = await import(
  "../helpers/perf-fixtures.js"
);

beforeEach(() => {
  counts.wrap = 0;
  counts.markdownNew = 0;
  counts.markdownRender = 0;
});

describe("ConversationViewer — cost stays linear in transcript length", () => {
  usePiTheme();
  /** Pi component renders (blocks) plus Markdown renders, for a viewer's frames. */
  const work = (viewer: any) => viewer.transcript.renders + counts.markdownRender;

  /** Leaf calls the first render makes over a transcript of `n` messages. */
  function workFor(n: number): number {
    const viewer = mountViewer(ConversationViewer, makeSession(n));
    counts.markdownRender = 0;
    viewer.render(120);
    return work(viewer);
  }

  // A first frame (or a width or expand change) renders every message's Pi
  // component, so that work is expected to grow with the transcript. What must
  // not happen is growing FASTER than it: ten times the messages, at most ~ten
  // times the work. A quadratic here is invisible on a short conversation and
  // locks the TUI on a long one.
  it("does ~10x the work for 10x the messages", () => {
    const small = workFor(30);
    const large = workFor(300);

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeLessThanOrEqual(11);
  });

  // Later frames keep each component's rendered lines: a frame where the
  // transcript did not change renders nothing, however long the transcript is.
  it("does no leaf work on a frame where nothing changed", () => {
    const viewer = mountViewer(ConversationViewer, makeSession(300));
    viewer.render(120);
    counts.markdownRender = 0;
    const before = work(viewer);
    viewer.render(120);
    viewer.render(120);
    expect(work(viewer)).toBe(before);
  });

  // Components are built once per message and kept: a frame builds no new
  // Markdown, and an appended message builds only its own.
  it("re-renders without rebuilding: components survive a frame", () => {
    const session = makeSession(60);
    const viewer = mountViewer(ConversationViewer, session);
    viewer.render(120);
    const afterFirst = counts.markdownNew;
    expect(afterFirst).toBeGreaterThan(0);

    viewer.render(120);
    viewer.render(120);
    expect(counts.markdownNew).toBe(afterFirst);

    session.messages.push({ role: "user", content: "one more", timestamp: 0 });
    viewer.render(120);
    expect(counts.markdownNew - afterFirst).toBeLessThanOrEqual(1);
  });
});

describe("AgentWidget — one frame does not rescan per agent", () => {
  /** Renders one frame over `n` agents; returns how often the manager was asked. */
  function listCallsPerRender(n: number): number {
    const records = makeFleet({ running: n });
    let listAgentsCalls = 0;
    const manager = {
      listAgents: () => {
        listAgentsCalls++;
        return records;
      },
    } as any;

    const widget = new AgentWidget(manager, makeActivity(records), () => "all", () => false, () => false);
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: string, c: any) => { factory = c; } } as any);
    widget.update();
    const tui = perfTui();
    factory?.(tui, perfTheme).render(); // prime
    listAgentsCalls = 0;
    factory?.(tui, perfTheme).render();
    widget.dispose?.();
    return listAgentsCalls;
  }

  // Today a render is exactly one scan (`update()` does the other). The bound is
  // "a constant, and the same constant at 100 agents as at 1" — a per-agent
  // lookup added to the row builder would break it, and collapsing the two
  // remaining scans into one would not.
  it("asks the manager for the agent list a constant number of times", () => {
    expect(listCallsPerRender(1)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBe(listCallsPerRender(1));
  });
});
