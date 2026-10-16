/**
 * The tool watchdog against tools that do and do not honour their abort.
 *
 * Pi's agent loop awaits a running tool unconditionally, so `session.abort()`
 * ends the run only if the tool listens to its signal. A watchdog that aborts
 * once and then waits forever leaves the agent — and its concurrency slot —
 * stuck; it has to escalate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { driveSession, MAX_TOOL_RECOVERIES, resumeAgent, setToolTimeoutSeconds, setWatchdogTiming } from "../src/agent-runner.js";

const DEFAULT_TIMING = { slackMs: 60_000, intervalMs: 5_000, escalateMs: 30_000 };

/**
 * A session whose every prompt starts a tool. With `honoursAbort`, the tool
 * (and the prompt) ends when the session is aborted; without, never.
 */
function hangingSession(honoursAbort: boolean) {
  const listeners = new Set<(e: any) => void>();
  let release: (() => void) | undefined;
  const s: any = {
    messages: [] as any[],
    agent: { beforeToolCall: undefined },
    subscribe(fn: (e: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    prompt: vi.fn(async () => {
      for (const l of listeners) l({ type: "tool_execution_start", toolCallId: String(Math.random()), toolName: "slow" });
      await new Promise<void>(r => { release = r; });
      for (const l of listeners) l({ type: "agent_end" });
      s.messages.push({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted" });
    }),
    abort: vi.fn(async () => { if (honoursAbort) release?.(); }),
    steer: vi.fn(async () => {}),
  };
  return s;
}

describe("tool watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
    setToolTimeoutSeconds(1200);
    setWatchdogTiming(DEFAULT_TIMING);
  });

  it("a resumed run whose tool hangs again after the last recovery ends aborted, like a first run", async () => {
    vi.useFakeTimers();
    setToolTimeoutSeconds(1);
    const s = hangingSession(true);
    const p = resumeAgent(s, "go");
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(70_000);
    const r = await p;
    expect(s.prompt).toHaveBeenCalledTimes(MAX_TOOL_RECOVERIES + 1); // initial + 3 recovery prompts
    expect(s.abort).toHaveBeenCalledTimes(MAX_TOOL_RECOVERIES + 1); // the 4th hang was killed too
    expect(r.aborted).toBe(true);
  });

  it("escalates when the stuck tool ignores the abort: the run ends aborted instead of waiting forever", async () => {
    vi.useFakeTimers();
    setToolTimeoutSeconds(1);
    setWatchdogTiming({ slackMs: 0, intervalMs: 100, escalateMs: 500 });
    const s = hangingSession(false);
    let settled = false;
    const p = driveSession(s, "go", {}).then(r => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(1_200); // past the limit: the watchdog aborts
    expect(s.abort).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600); // past the escalation delay
    const r = await p;
    expect(r.aborted).toBe(true);
    // No recovery prompt into a session that is still busy with the old one.
    expect(s.prompt).toHaveBeenCalledTimes(1);
  });

  it("does not escalate a run that a tool lets end normally", async () => {
    vi.useFakeTimers();
    setToolTimeoutSeconds(1);
    setWatchdogTiming({ slackMs: 0, intervalMs: 100, escalateMs: 500 });
    const s = hangingSession(true);
    s.prompt.mockImplementationOnce(async () => {
      s.messages.push({ role: "assistant", content: [{ type: "text", text: "quick" }], stopReason: "stop" });
    });
    const r = await driveSession(s, "go", {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r).toMatchObject({ aborted: false, responseText: "quick" });
    expect(s.abort).not.toHaveBeenCalled();
  });
});
