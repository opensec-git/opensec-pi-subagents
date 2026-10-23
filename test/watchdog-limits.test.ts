/**
 * 0.20.7: a subagent's `bash` timeout is kept as the call sets it, the tool
 * watchdog follows each call's own limit, and `watchdogExemptTools` lists tools
 * it never stops.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundBashTimeout, callLimitSeconds, installToolTimeouts, setWatchdogTiming } from "../src/agent-runner.js";
import { codemodeDeadlineSeconds, setCodemodeTimeoutSeconds } from "../src/codemode-guard.js";
import { getWatchdogExemptTools, orchestrationSettingsAsWritten, setWatchdogExemptTools } from "../src/orchestration.js";
import { applySettings, loadSettings, type SettingsAppliers } from "../src/settings.js";

const DEFAULT_TIMING = { slackMs: 60_000, intervalMs: 5_000, escalateMs: 30_000 };

/** A session that only reports tool events; the test emits them. */
function eventSession() {
  const listeners = new Set<(e: any) => void>();
  const session: any = {
    agent: { beforeToolCall: undefined },
    subscribe(fn: (e: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    abort: vi.fn(async () => {}),
  };
  const emit = (e: any) => { for (const l of listeners) l(e); };
  return {
    session,
    start: (toolName: string, args: unknown = {}, id = toolName) => emit({ type: "tool_execution_start", toolCallId: id, toolName, args }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  setWatchdogTiming(DEFAULT_TIMING);
  setCodemodeTimeoutSeconds(1800);
  setWatchdogExemptTools(["second_opinion_agent"]);
});

describe("boundBashTimeout", () => {
  it("keeps a timeout the call sets, longer than the limit or not", () => {
    for (const fixInvalid of [true, false]) {
      const longer = { command: "make", timeout: 1800 };
      boundBashTimeout(longer, 1200, fixInvalid);
      expect(longer.timeout).toBe(1800);
      const shorter = { command: "ls", timeout: 5 };
      boundBashTimeout(shorter, 1200, fixInvalid);
      expect(shorter.timeout).toBe(5);
    }
  });

  it("gives a call with no timeout the limit", () => {
    const call: { command: string; timeout?: number } = { command: "find /" };
    boundBashTimeout(call, 1200, true);
    expect(call.timeout).toBe(1200);
  });

  it("replaces a timeout that is not a positive number only with fixInvalid", () => {
    for (const bad of [0, -5, "60", Number.NaN]) {
      const fixed: { timeout: unknown } = { timeout: bad };
      boundBashTimeout(fixed, 1200, true);
      expect(fixed.timeout).toBe(1200);
      const kept: { timeout: unknown } = { timeout: bad };
      boundBashTimeout(kept, 1200, false);
      expect(kept.timeout).toBe(bad);
    }
  });
});

describe("codemodeDeadlineSeconds", () => {
  it("reads the script's own timeout_ms", () => {
    expect(codemodeDeadlineSeconds({ code: '// @options: {"timeout_ms": 90000}\nawait bash("x")' })).toBe(90);
    expect(codemodeDeadlineSeconds({ code: '  // @options: {"timeout_ms": 1500}  ' })).toBe(1.5);
  });

  it("falls back to codemodeTimeoutSeconds, or no deadline when that is 0", () => {
    expect(codemodeDeadlineSeconds({ code: "await bash('x')" })).toBe(1800);
    expect(codemodeDeadlineSeconds({ code: '// @options: {"timeout_ms": 0}\nx' })).toBe(1800);
    expect(codemodeDeadlineSeconds({ code: "// @options: not json\nx" })).toBe(1800);
    expect(codemodeDeadlineSeconds(undefined)).toBe(1800);
    setCodemodeTimeoutSeconds(0);
    expect(codemodeDeadlineSeconds({ code: "x" })).toBeUndefined();
  });
});

describe("callLimitSeconds", () => {
  it("is a bash call's own timeout, else the tool limit", () => {
    expect(callLimitSeconds("bash", { timeout: 1800 }, 1200)).toBe(1800);
    expect(callLimitSeconds("bash", { timeout: 30 }, 1200)).toBe(30);
    expect(callLimitSeconds("bash", { timeout: -1 }, 1200)).toBe(1200);
    expect(callLimitSeconds("bash", {}, 1200)).toBe(1200);
  });

  it("is a codemode script's deadline, else the tool limit", () => {
    expect(callLimitSeconds("codemode", { code: "x" }, 1200)).toBe(1800);
    expect(callLimitSeconds("codemode", { code: '// @options: {"timeout_ms": 3600000}\nx' }, 1200)).toBe(3600);
    setCodemodeTimeoutSeconds(0);
    expect(callLimitSeconds("codemode", { code: "x" }, 1200)).toBe(1200);
  });

  it("is the tool limit for every other tool", () => {
    expect(callLimitSeconds("read", { timeout: 9999 }, 1200)).toBe(1200);
  });
});

describe("the tool watchdog follows each call's own limit", () => {
  function watch(limitSeconds: number) {
    vi.useFakeTimers();
    setWatchdogTiming({ slackMs: 1_000, intervalMs: 100, escalateMs: 60_000 });
    const s = eventSession();
    const timeouts = installToolTimeouts(s.session, limitSeconds);
    return { ...s, timeouts };
  }

  it("does not stop a bash call inside its own longer timeout", async () => {
    const w = watch(10);
    w.start("bash", { command: "make", timeout: 30 });
    await vi.advanceTimersByTimeAsync(20_000); // past 10 s + slack, inside 30 s
    expect(w.session.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12_000); // past 30 s + slack
    expect(w.session.abort).toHaveBeenCalledTimes(1);
    expect(w.timeouts.takeHung()).toMatchObject({ toolName: "bash" });
    w.timeouts.dispose();
  });

  it("does not stop a codemode script inside its deadline", async () => {
    const w = watch(10);
    w.start("codemode", { code: '// @options: {"timeout_ms": 30000}\nawait bash("x")' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(w.session.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(w.session.abort).toHaveBeenCalledTimes(1);
    w.timeouts.dispose();
  });

  it("stops any other tool at the tool limit", async () => {
    const w = watch(10);
    w.start("slow_search");
    await vi.advanceTimersByTimeAsync(11_200);
    expect(w.session.abort).toHaveBeenCalledTimes(1);
    expect(w.timeouts.takeHung()).toMatchObject({ toolName: "slow_search" });
    w.timeouts.dispose();
  });

  it("never stops second_opinion_agent by default", async () => {
    const w = watch(10);
    w.start("second_opinion_agent");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(w.session.abort).not.toHaveBeenCalled();
    w.timeouts.dispose();
  });

  it("the setting replaces the default list", async () => {
    setWatchdogExemptTools(["slow_search"]);
    const w = watch(10);
    w.start("slow_search", {}, "a");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.session.abort).not.toHaveBeenCalled();
    w.start("second_opinion_agent", {}, "b");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(w.session.abort).toHaveBeenCalledTimes(1);
    expect(w.timeouts.takeHung()).toMatchObject({ toolName: "second_opinion_agent" });
    w.timeouts.dispose();
  });
});

describe("watchdogExemptTools setting", () => {
  it("defaults to second_opinion_agent and is not written while unset", () => {
    expect([...getWatchdogExemptTools()]).toEqual(["second_opinion_agent"]);
  });

  it("keeps non-empty strings only", () => {
    const read = (value: unknown) => {
      const project = mkdtempSync(join(tmpdir(), "pi-watchdog-settings-"));
      vi.stubEnv("PI_CODING_AGENT_DIR", project);
      try {
        mkdirSync(join(project, ".pi"), { recursive: true });
        writeFileSync(join(project, ".pi", "subagents.json"), JSON.stringify({ watchdogExemptTools: value }));
        return loadSettings(project).watchdogExemptTools;
      } finally {
        vi.unstubAllEnvs();
        rmSync(project, { recursive: true, force: true });
      }
    };
    expect(read(["a", "", " ", 3, null, "b"])).toEqual(["a", "b"]);
    expect(read("a")).toBeUndefined();
    expect(read([])).toEqual([]);
  });

  it("is applied, and written back as set", () => {
    const setWatchdog = vi.fn((names: string[]) => setWatchdogExemptTools(names));
    applySettings({ watchdogExemptTools: ["x", "y"] }, { setWatchdogExemptTools: setWatchdog } as unknown as SettingsAppliers);
    expect(setWatchdog).toHaveBeenCalledWith(["x", "y"]);
    expect([...getWatchdogExemptTools()]).toEqual(["x", "y"]);
    expect(orchestrationSettingsAsWritten()).toEqual({ watchdogExemptTools: ["x", "y"] });
  });
});
