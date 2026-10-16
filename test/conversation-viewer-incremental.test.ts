/**
 * conversation-viewer-incremental.test.ts — the viewer keeps rendered lines
 * between frames and only rebuilds what changed.
 *
 * The contract is that this is invisible: after any sequence of transcript
 * changes, a long-lived viewer draws exactly what a viewer built from scratch
 * over the same state draws. The work counts (Pi component renders) are the
 * point of the change.
 */
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

// The transcript is drawn with Pi's components, which read Pi's global theme.
initTheme("dark", false);

const codes: Record<string, number> = { accent: 35, dim: 90, muted: 37, error: 31, success: 32, warning: 33, border: 34 };
const theme = {
  fg: (c: string, s: string) => `\x1b[${codes[c] ?? 36}m${s}\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

const PARA = "The subagent read the module and found the render path rebuilds its content on every frame, which is fine until it is not.";

function transcript(): any[] {
  return [
    { role: "user", content: `Investigate this. ${PARA}`, timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: `## Plan\n\n${PARA}\n\n- one\n- two\n\n\`\`\`ts\nconst x = 1;\n\`\`\`` }, { type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse", timestamp: 0 },
    { role: "toolResult", toolCallId: "r1", toolName: "read", isError: false, timestamp: 0, content: [{ type: "text", text: `# not a heading\n${PARA}\n${PARA}` }] },
    { role: "toolResult", toolCallId: "nope", toolName: "read", isError: false, timestamp: 0, content: [{ type: "text", text: "   " }] }, // no call: nothing drawn
    { role: "user", content: [{ type: "text", text: "  " }], timestamp: 0 }, // empty: skipped
    { role: "custom", customType: "note", content: "ignored", display: false, timestamp: 0 }, // not displayed
    { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }, { type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } }], stopReason: "toolUse", timestamp: 0 },
    { role: "toolResult", toolCallId: "b1", toolName: "bash", isError: false, timestamp: 0, content: [{ type: "text", text: `${"long line ".repeat(2000)}\n`.repeat(2) }] },
    { role: "bashExecution", command: "ls -la", output: "a\nb\nc", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
    { role: "bashExecution", command: "true", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "follow-up" }], timestamp: 0 },
  ];
}

function makeViewer(session: any, record: any, activity: any, rows = 40) {
  const tui = { terminal: { rows, columns: 120 }, requestRender: vi.fn() };
  const viewer = new ConversationViewer(tui as any, session, record, activity, theme, () => {});
  return { viewer, tui };
}

/** Pi component renders so far (each one is a block re-rendered). */
const renders = (viewer: any): number => viewer.transcript.renders;

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
function expectSameAsFresh(live: any, session: any, record: any, activity: any, width: number, expanded = false) {
  const fresh = makeViewer(sessionOf(session.messages), record, activity).viewer;
  if (expanded) fresh.handleInput("\x0f");
  expect(live.render(width)).toEqual(fresh.render(width));
  expect(live.buildContentLines(width - 4)).toEqual(fresh.buildContentLines(width - 4));
}

afterEach(() => vi.useRealTimers());

describe("ConversationViewer incremental transcript", () => {
  it("draws what a fresh viewer draws through appends, edits, expand and width changes", () => {
    const session = sessionOf([]);
    const record = makeRecord();
    const activity = { activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1 };
    const { viewer } = makeViewer(session, record, activity);

    expectSameAsFresh(viewer, session, record, activity, 100); // waiting line
    for (const msg of transcript()) {
      session.messages.push(msg);
      for (const w of [100, 60]) expectSameAsFresh(viewer, session, record, activity, w);
    }

    // The last message grows in place (an older Pi streamed into the message object).
    const tail = { role: "assistant", content: [{ type: "text", text: "Partial" }], stopReason: "stop", timestamp: 0 };
    session.messages.push(tail);
    expectSameAsFresh(viewer, session, record, activity, 100);
    tail.content[0].text += " answer, now longer\n\n- with a list";
    activity.responseText = "Partial answer";
    expectSameAsFresh(viewer, session, record, activity, 100);

    // Edited and then pushed past before the next frame: the old tail must not
    // be trusted just because it is no longer last.
    tail.content[0].text = "Replaced entirely";
    session.messages.push({ role: "user", content: "after the edit", timestamp: 0 });
    expectSameAsFresh(viewer, session, record, activity, 100);

    // Running tools change only the indicator line.
    activity.activeTools.set("read_1", "read");
    expectSameAsFresh(viewer, session, record, activity, 100);

    viewer.handleInput("\x0f"); // expand
    for (const w of [120, 40, 100]) expectSameAsFresh(viewer, session, record, activity, w, true);
    viewer.handleInput("\x0f"); // collapse
    expectSameAsFresh(viewer, session, record, activity, 100);

    // Compaction replaces the array; some message objects survive into it.
    session.messages = [{ role: "compactionSummary", summary: "earlier work", tokensBefore: 1000, timestamp: 0 }, ...session.messages.slice(-3)];
    expectSameAsFresh(viewer, session, record, activity, 100);

    // Truncated in place, then a tool call whose result had been dropped.
    session.messages.length = 2;
    expectSameAsFresh(viewer, session, record, activity, 100);
    session.messages.push(...transcript().slice(0, 3));
    expectSameAsFresh(viewer, session, record, activity, 100);
    session.messages.length = 4; // drops r1's result: its call shows pending again
    expectSameAsFresh(viewer, session, record, activity, 100);

    // Finishing drops the indicator.
    record.status = "completed";
    expectSameAsFresh(viewer, session, record, activity, 100);
  });

  it("renders nothing on a frame where nothing changed, and only what was appended", () => {
    const session = sessionOf(transcript());
    const { viewer } = makeViewer(session, makeRecord(), undefined);
    viewer.render(120);
    const built = renders(viewer);
    viewer.render(120);
    viewer.render(120);
    expect(renders(viewer)).toBe(built);

    session.messages.push({ role: "user", content: [{ type: "text", text: "one more" }], timestamp: 0 });
    viewer.render(120);
    expect(renders(viewer)).toBe(built + 1);

    // A width change re-renders everything once, then the cache holds again.
    const before = renders(viewer);
    viewer.render(90);
    const rebuilt = renders(viewer) - before;
    expect(rebuilt).toBeGreaterThan(1);
    viewer.render(90);
    expect(renders(viewer)).toBe(before + rebuilt);
  });

  it("does not re-render the transcript on a scroll key", () => {
    const session = sessionOf(Array.from({ length: 30 }, () => transcript()).flat());
    const { viewer } = makeViewer(session, makeRecord(), undefined, 20);
    const first = viewer.render(120);
    const built = renders(viewer);
    viewer.handleInput("\x1b[A"); // up
    viewer.handleInput("\x1b[A");
    const after = viewer.render(120);
    expect(renders(viewer)).toBe(built);
    expect(after).not.toEqual(first); // it did scroll
  });

  it("keeps the overwidth clamp on every content line", () => {
    const session = sessionOf([{ role: "user", content: "x".repeat(20_000), timestamp: 0 }]);
    const { viewer } = makeViewer(session, makeRecord(), undefined);
    for (const line of viewer.buildContentLines(30)) expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(30);
  });
});

describe("ConversationViewer redraw throttle", () => {
  it("coalesces streaming events into one redraw per frame", () => {
    vi.useFakeTimers();
    const session = sessionOf(transcript());
    const { viewer, tui } = makeViewer(session, makeRecord(), undefined);
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
