/**
 * Spend and control across a resume, for workflow and nested children.
 *
 * A record's counters are lifetime figures: they accumulate across every run of
 * the agent. Reporting them as one resumed call's own figures counts the first
 * run again on every resume.
 */
import { describe, expect, it, vi } from "vitest";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { runWorkflow } from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "probe", description: "budget probe" };\n';
const ctx: any = { cwd: process.cwd(), model: undefined, modelRegistry: { find: () => undefined, getAvailable: () => [] } };

describe("workflow agent({ resume })", () => {
  it("counts only the resumed run's tokens and tool calls", async () => {
    // One record, as AgentManager keeps it: lifetimeUsage accumulates across runs.
    const record: any = {
      id: "r1", status: "completed", result: "first", toolUses: 2,
      lifetimeUsage: { input: 0, output: 100, cacheWrite: 0 },
    };
    const manager: any = {
      async spawnAndWait(_pi: any, _ctx: any, _t: string, _p: string, _o: any, onSpawned?: (id: string) => void) {
        onSpawned?.(record.id);
        return { id: record.id, record };
      },
      async resume() {
        record.lifetimeUsage.output += 50; // the resumed run spends 50
        record.toolUses += 1;
        record.result = "second";
        return record;
      },
      abort() { return true; },
      getRecord() { return record; },
    };
    const host = createWorkflowHost({ pi: {} as any, ctx, manager });
    const result = await runWorkflow({
      script: `${HEAD}await agent("a", { label: "L" });\nawait agent("b", { resume: "L" });\nreturn budget.spent();`,
      host,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe(150); // 100 + 50, not 100 + 150
    const rows = result.progress.filter((e: any) => e.state === "done");
    expect(rows.map((e: any) => e.toolCalls)).toEqual([2, 1]);
    expect(rows.map((e: any) => e.tokens)).toEqual([100, 50]);
  });
});

describe("workflow skip while a child is still creating its worktree", () => {
  it("stops the child (reported as skipped) instead of being lost", async () => {
    const manager: any = {
      // Stand-in for startup: the manager issues no id (onSpawned) until the
      // worktree exists, and settles the record as stopped if the spawn's
      // signal fires first.
      spawnAndWait: vi.fn(async (_pi: any, _ctx: any, _t: string, _p: string, options: any) => {
        await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        const record = { id: "m1", status: "stopped", toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } };
        return { id: "m1", record };
      }),
      abort: vi.fn(),
      getRecord: () => undefined,
    };
    const host = createWorkflowHost({ pi: {} as any, ctx, manager });
    const pending = host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "l", agentType: "general-purpose" });
    await new Promise(r => setTimeout(r, 10));
    host.abortAgent("wf-agent-0");
    const result = await Promise.race([pending, new Promise(r => setTimeout(() => r("still waiting"), 1_000))]);
    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(manager.abort).not.toHaveBeenCalled(); // no id existed to abort
  });
});

describe("nested foreground resume", () => {
  it("books the resumed run's spend into every ancestor, like a nested spawn", async () => {
    const root: any = { id: "root", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } };
    const parent: any = { id: "parent", parentAgentId: "root", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } };
    const child: any = { id: "child", parentAgentId: "parent", status: "completed", result: "ok", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } };
    const records: Record<string, any> = { root, parent, child };
    const manager: any = {
      getRecord: (id: string) => records[id],
      resume: vi.fn(async (_id: string, _prompt: string, _signal: unknown, options: any) => {
        options?.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0 });
        return child;
      }),
    };
    const tools = createNestedSubagentTools({
      manager, pi: {} as any, parentAgentId: "parent", depth: 2, maxSubagentDepth: 3,
      allowedSubagents: "all", configCwd: process.cwd(),
    });
    const agentTool = tools.find(t => t.name === "Agent")!;
    await agentTool.execute("tc", { prompt: "more", description: "d", subagent_type: "x", resume: "child" } as any, undefined, undefined, ctx);
    expect(parent.lifetimeUsage).toMatchObject({ input: 10, output: 5 });
    expect(root.lifetimeUsage).toMatchObject({ input: 10, output: 5 });
  });
});
