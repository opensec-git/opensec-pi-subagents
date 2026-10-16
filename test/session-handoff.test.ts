/**
 * session-handoff.test.ts — the process-global slot a session switch parks a
 * manager in, and the helpers around it (see src/session-handoff.ts).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendToSessionFile,
  HANDOFF_PROTOCOL,
  isCompatible,
  isSessionSwitch,
  PACKAGE_VERSION,
  type ParkedSubagents,
  parkSubagents,
  snapshotContext,
  takeParkedSubagents,
} from "../src/session-handoff.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "session-handoff-")); });
afterEach(() => {
  // Leave no parked entry for the next test.
  takeParkedSubagents("/a.jsonl");
  takeParkedSubagents("/b.jsonl");
  rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<ParkedSubagents> = {}): ParkedSubagents {
  return {
    protocol: HANDOFF_PROTOCOL,
    version: PACKAGE_VERSION,
    reason: "new",
    sessionFile: "/a.jsonl",
    targetSessionFile: "/b.jsonl",
    manager: {},
    activity: new Map(),
    completed: [],
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

/** A persisted Pi session with a conversation, as the parent's would be. */
function sessionFile(): string {
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
  return manager.getSessionFile() as string;
}

describe("version", () => {
  it("is the package version, so a different install never adopts this manager", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("accepts only an entry parked by this very version and protocol", () => {
    expect(isCompatible(entry())).toBe(true);
    expect(isCompatible(entry({ version: "0.0.1" }))).toBe(false);
    expect(isCompatible(entry({ protocol: HANDOFF_PROTOCOL + 1 }))).toBe(false);
  });
});

describe("telling a switch from a quit", () => {
  it("treats new, resume, fork and reload as a switch; quit or nothing as a quit", () => {
    for (const reason of ["new", "resume", "fork", "reload"]) expect(isSessionSwitch(reason)).toBe(true);
    for (const reason of ["quit", undefined, "", 3]) expect(isSessionSwitch(reason)).toBe(false);
  });
});

describe("the parked slot", () => {
  it("hands the entry to the session the switch targeted, once", () => {
    const parked = entry();
    parkSubagents(parked, () => {});
    expect(takeParkedSubagents("/a.jsonl")).toBeUndefined();
    expect(takeParkedSubagents(undefined)).toBeUndefined();
    expect(takeParkedSubagents("/b.jsonl")).toBe(parked);
    expect(takeParkedSubagents("/b.jsonl")).toBeUndefined();
  });

  it("after /reload, hands it to the same session", () => {
    const parked = entry({ reason: "reload", targetSessionFile: undefined });
    parkSubagents(parked, () => {});
    expect(takeParkedSubagents("/a.jsonl")).toBe(parked);
  });

  it("stops an entry nobody took when another one is parked over it", () => {
    const stale = entry();
    parkSubagents(stale, () => {});
    parkSubagents(entry({ targetSessionFile: "/a.jsonl" }), () => {});
    expect(stale.stop).toHaveBeenCalledTimes(1);
  });
});

describe("appendToSessionFile", () => {
  it("adds an entry on the session's branch, where Pi reads it when the session is opened", () => {
    const file = sessionFile();
    expect(appendToSessionFile(file, "subagents:record", { id: "x", pending: true })).toBe(true);
    const branch = SessionManager.open(file).getBranch();
    expect(branch.at(-1)).toMatchObject({ type: "custom", customType: "subagents:record", data: { id: "x", pending: true } });
  });

  it("writes nothing for a session that is not on disk", () => {
    expect(appendToSessionFile(undefined, "t", {})).toBe(false);
    expect(appendToSessionFile(join(dir, "missing.jsonl"), "t", {})).toBe(false);
  });
});

describe("snapshotContext", () => {
  it("keeps the values a context had, after the context goes stale", () => {
    let stale = false;
    const check = () => { if (stale) throw new Error("stale ctx"); };
    const model = { provider: "p", id: "m" };
    const live = {
      get cwd() { check(); return "/work"; },
      get model() { check(); return model; },
      get thinkingLevel() { check(); return "high"; },
      get modelRegistry() { check(); return { find: () => undefined }; },
      get sessionManager() { check(); return { getSessionFile: () => "/a.jsonl" }; },
      getSystemPrompt: () => { check(); return "parent prompt"; },
      isProjectTrusted: () => { check(); return false; },
    };
    const copy = snapshotContext(live as never);
    stale = true;
    expect(copy.cwd).toBe("/work");
    expect(copy.model).toBe(model);
    expect((copy as { thinkingLevel?: string }).thinkingLevel).toBe("high");
    expect(copy.getSystemPrompt()).toBe("parent prompt");
    expect(copy.isProjectTrusted()).toBe(false);
    expect(copy.sessionManager.getSessionFile()).toBe("/a.jsonl");
  });
});
