/**
 * conversation-viewer-incremental.test.ts — the viewer keeps rendered lines
 * between frames and only rebuilds what changed.
 *
 * The contract is that this is invisible: after any sequence of transcript
 * changes, a long-lived viewer draws exactly what a viewer built from scratch
 * over the same state draws. The work counts are the point of the change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const counts = { wrap: 0 };
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...actual,
    wrapTextWithAnsi: (...args: [string, number]) => {
      counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

const { ConversationViewer, RESULT_MAX_CHARS } = await import("../src/ui/conversation-viewer.js");

const codes: Record<string, number> = { accent: 35, dim: 90, muted: 37, error: 31, success: 32, warning: 33, border: 34 };
const theme = {
  fg: (c: string, s: string) => `\x1b[${codes[c] ?? 36}m${s}\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

const PARA = "The subagent read the module and found the render path rebuilds its content on every frame, which is fine until it is not.";

function transcript(): any[] {
  return [
    { role: "user", content: `Investigate this. ${PARA}` },
    { role: "assistant", content: [{ type: "text", text: `## Plan\n\n${PARA}\n\n- one\n- two\n\n\`\`\`ts\nconst x = 1;\n\`\`\`` }, { type: "toolCall", name: "read" }] },
    { role: "toolResult", content: [{ type: "text", text: `# not a heading\n${PARA}\n${PARA}` }] },
    { role: "toolResult", content: [{ type: "text", text: "   " }] }, // empty: skipped, no separator
    { role: "user", content: [{ type: "text", text: "  " }] }, // empty: skipped
    { role: "custom", content: "ignored" }, // unknown role: skipped
    { role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "toolCall", toolName: "grep" }] },
    { role: "toolResult", content: [{ type: "text", text: `${"long line ".repeat(2000)}\n`.repeat(2) }] }, // over the cap
    { role: "bashExecution", command: "ls -la", output: "a\nb\nc" },
    { role: "bashExecution", command: "true", output: "" },
    { role: "user", content: [{ type: "text", text: "follow-up" }] },
  ];
}

function makeViewer(session: any, record: any, activity: any, mode: () => string, rows = 40) {
  const tui = { terminal: { rows, columns: 120 }, requestRender: vi.fn() };
  const viewer = new ConversationViewer(
    tui as any, session, record, activity, theme, () => {}, undefined, undefined, undefined, false, mode as any,
  );
  return { viewer, tui };
}

function sessionOf(messages: any[]) {
  const listeners: ((e: { type: string }) => void)[] = [];
  return {
    messages,
    subscribe: (l: (e: { type: string }) => void) => { listeners.push(l); return () => {}; },
    emit: (type: string) => { for (const l of listeners) l({ type }); },
    dispose: () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  };
}

function makeRecord(status = "running") {
  return { id: "a", type: "general-purpose", description: "viewer test", status, toolUses: 0, startedAt: 0, completedAt: 1000 } as any;
}

/** Draw with the long-lived viewer and with a fresh one; they must agree. */
function expectSameAsFresh(live: any, session: any, record: any, activity: any, mode: () => string, width: number) {
  const fresh = makeViewer(sessionOf(session.messages), record, activity, mode).viewer;
  expect(live.render(width)).toEqual(fresh.render(width));
  expect(live.buildContentLines(width - 4)).toEqual(fresh.buildContentLines(width - 4));
}

beforeEach(() => { counts.wrap = 0; });
afterEach(() => vi.useRealTimers());

describe("ConversationViewer incremental transcript", () => {
  it("draws what a fresh viewer draws through appends, edits, mode and width changes", () => {
    let mode = "assistant";
    const modeFn = () => mode;
    const session = sessionOf([]);
    const record = makeRecord();
    const activity = { activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1 };
    const { viewer } = makeViewer(session, record, activity, modeFn);

    expectSameAsFresh(viewer, session, record, activity, modeFn, 100); // waiting line
    for (const msg of transcript()) {
      session.messages.push(msg);
      for (const w of [100, 60]) expectSameAsFresh(viewer, session, record, activity, modeFn, w);
    }

    // The streaming tail grows in place (older pi streams into the message object).
    const tail = { role: "assistant", content: [{ type: "text", text: "Partial" }] };
    session.messages.push(tail);
    expectSameAsFresh(viewer, session, record, activity, modeFn, 100);
    tail.content[0].text += " answer, now longer\n\n- with a list";
    activity.responseText = "Partial answer";
    expectSameAsFresh(viewer, session, record, activity, modeFn, 100);

    // Edited and then pushed past before the next frame: the old tail must not
    // be trusted just because it is no longer last.
    tail.content[0].text = "Replaced entirely";
    session.messages.push({ role: "toolResult", content: [{ type: "text", text: "after the edit" }] });
    expectSameAsFresh(viewer, session, record, activity, modeFn, 100);

    // Running tools change only the indicator line.
    activity.activeTools.set("read_1", "read");
    expectSameAsFresh(viewer, session, record, activity, modeFn, 100);

    for (const m of ["off", "all", "assistant"]) {
      mode = m;
      for (const w of [120, 40, 100]) expectSameAsFresh(viewer, session, record, activity, modeFn, w);
    }

    // Compaction replaces the array; some message objects survive into it.
    session.messages = [{ role: "user", content: "summary of earlier work" }, ...session.messages.slice(-3)];
    expectSameAsFresh(viewer, session, record, activity, modeFn, 100);

    // Truncated in place.
    session.messages.length = 2;
    expectSameAsFresh(viewer, session, record, activity, modeFn, 100);

    // Finishing drops the indicator.
    record.status = "completed";
    expectSameAsFresh(viewer, session, record, activity, modeFn, 100);
  });

  it("does no wrapping on a frame where nothing changed, and only wraps what was appended", () => {
    const session = sessionOf(transcript());
    const { viewer } = makeViewer(session, makeRecord(), undefined, () => "off");
    viewer.render(120);
    counts.wrap = 0;
    viewer.render(120);
    viewer.render(120);
    expect(counts.wrap).toBe(0);

    session.messages.push({ role: "user", content: [{ type: "text", text: "one more" }] });
    viewer.render(120);
    expect(counts.wrap).toBe(1);

    // A width change rebuilds everything once, then the cache holds again.
    counts.wrap = 0;
    viewer.render(90);
    const rebuilt = counts.wrap;
    expect(rebuilt).toBeGreaterThan(1);
    viewer.render(90);
    expect(counts.wrap).toBe(rebuilt);
  });

  it("does not rebuild the transcript on a scroll key", () => {
    const session = sessionOf(Array.from({ length: 30 }, () => transcript()).flat());
    const { viewer } = makeViewer(session, makeRecord(), undefined, () => "off", 20);
    const first = viewer.render(120);
    counts.wrap = 0;
    viewer.handleInput("\x1b[A"); // up
    viewer.handleInput("\x1b[A");
    const after = viewer.render(120);
    expect(counts.wrap).toBe(0);
    expect(after).not.toEqual(first); // it did scroll
  });

  it("keeps the overwidth clamp on every content line", () => {
    const session = sessionOf([{ role: "toolResult", content: [{ type: "text", text: "x".repeat(RESULT_MAX_CHARS + 10) }] }]);
    const { viewer } = makeViewer(session, makeRecord(), undefined, () => "off");
    for (const line of viewer.buildContentLines(30)) expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(30);
  });
});

describe("ConversationViewer redraw throttle", () => {
  it("coalesces streaming events into one redraw per frame", () => {
    vi.useFakeTimers();
    const session = sessionOf(transcript());
    const { viewer, tui } = makeViewer(session, makeRecord(), undefined, () => "off");
    for (let i = 0; i < 100; i++) session.emit("message_update");
    expect(tui.requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    // Events that change the transcript redraw immediately.
    session.emit("message_end");
    expect(tui.requestRender).toHaveBeenCalledTimes(2);

    // Nothing fires after close.
    session.emit("tool_execution_update");
    viewer.dispose();
    vi.advanceTimersByTime(200);
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
  });
});
