/**
 * foreground-stream-throttle.test.ts — a foreground agent's inline progress is
 * pushed to pi once per spinner frame, not once per streamed token.
 *
 * Each push runs every extension's `tool_execution_update` handlers and pi's
 * renderResult; at token rate that was hundreds a second per agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

describe("foreground Agent progress", () => {
  it("coalesces streamed deltas into the spinner frame and still shows the latest activity", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;

    let finish: () => void = () => {};
    let stream: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any, opts: any) => new Promise<any>(resolve => {
      opts.onSessionCreated?.({ dispose: vi.fn(), subscribe: vi.fn(() => () => {}), messages: [], getActiveToolNames: vi.fn(() => []) });
      stream = () => {
        let text = "\n  First line of the answer  \n";
        for (let i = 0; i < 500; i++) {
          text += `token ${i} `;
          opts.onTextDelta?.(`token ${i} `, text);
        }
        opts.onToolActivity?.({ type: "start", toolName: "read" });
        opts.onToolActivity?.({ type: "end", toolName: "read" });
        opts.onTurnEnd?.(2);
      };
      finish = () => resolve({ responseText: `${prompt}-RESULT`, session: { dispose: vi.fn() }, aborted: false, steered: false });
    }) as any);

    const updates: any[] = [];
    const run = b.tools.get("Agent").execute(
      "tc-1",
      { prompt: "p", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      (u: any) => updates.push(u),
      ctx(),
    );
    await vi.waitFor(() => expect(stream).toBeDefined());

    const before = updates.length;
    stream?.();
    expect(updates.length - before).toBe(0); // none synchronously, however many tokens

    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(before));
    const last = updates[updates.length - 1].details;
    expect(last.activity).toBe("First line of the answer");
    expect(last.toolUses).toBe(1);
    expect(last.turnCount).toBe(2);

    finish();
    expect(textOf(await run)).toContain("p-RESULT");

    // The spinner stops with the run.
    const settled = updates.length;
    await new Promise(r => setTimeout(r, 200));
    expect(updates.length).toBe(settled);
  });
});
