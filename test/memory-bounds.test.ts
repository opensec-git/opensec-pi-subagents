/**
 * Long sessions: what is kept per run stays bounded, and transcript writes
 * stay cheap.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appendCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
      appendCalls.count++;
      return actual.appendFileSync(...args);
    },
  };
});

import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import { createWorkflowTask, MAX_SETTLED_WORKFLOW_TASKS, pruneSettledWorkflowTasks, type WorkflowTask } from "../src/workflow/task.js";

describe("settled workflow runs", () => {
  const task = (id: string, status: WorkflowTask["status"]): WorkflowTask => {
    const t = createWorkflowTask({ id, script: "", meta: { name: id, description: id } as any });
    t.status = status;
    return t;
  };

  it("are capped, oldest first, and live runs are never dropped", () => {
    const tasks = new Map<string, WorkflowTask>();
    tasks.set("live-old", task("live-old", "running"));
    tasks.set("paused", task("paused", "paused"));
    for (let i = 0; i < MAX_SETTLED_WORKFLOW_TASKS + 5; i++) tasks.set(`done-${i}`, task(`done-${i}`, i % 2 ? "completed" : "failed"));
    pruneSettledWorkflowTasks(tasks);
    expect(tasks.has("live-old")).toBe(true);
    expect(tasks.has("paused")).toBe(true);
    expect([...tasks.keys()].filter(k => k.startsWith("done-"))).toHaveLength(MAX_SETTLED_WORKFLOW_TASKS);
    expect(tasks.has("done-0")).toBe(false);
    expect(tasks.has("done-4")).toBe(false);
    expect(tasks.has("done-5")).toBe(true);
  });
});

describe("transcript streaming", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "memory-bounds-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes a turn's messages in one append, with the same lines as before", () => {
    const path = join(dir, "a.output");
    writeInitialEntry(path, "a", "prompt", dir);
    const listeners: Array<(e: any) => void> = [];
    const session: any = {
      messages: [{ role: "user", content: "prompt" }],
      subscribe: (fn: (e: any) => void) => { listeners.push(fn); return () => {}; },
    };
    const cleanup = streamToOutputFile(session, path, "a", dir);
    for (let i = 0; i < 6; i++) {
      session.messages.push(i % 2 === 0
        ? { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "read", arguments: {} }] }
        : { role: "toolResult", toolCallId: `t${i - 1}`, toolName: "read", content: [{ type: "text", text: `r${i}` }] });
    }
    appendCalls.count = 0;
    for (const l of listeners) l({ type: "turn_end" });
    expect(appendCalls.count).toBe(1);
    cleanup();
    const lines = readFileSync(path, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.map(l => l.type)).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "assistant", "toolResult"]);
    expect(lines.every(l => l.agentId === "a" && l.isSidechain === true)).toBe(true);
  });
});
