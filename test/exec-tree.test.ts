/**
 * Gates and worktree git calls end their whole process tree on a timeout or
 * an abort, and escalate to SIGKILL when SIGTERM is ignored.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { commandExec, execTree, useTreeKillingExec } from "../src/exec-tree.js";
import { createWorkflowHost } from "../src/workflow/host.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "exec-tree-"));
  dirs.push(dir);
  return dir;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pid a script wrote to `file`, once it exists. */
async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(20);
  const pid = Number(readFileSync(file, "utf-8").trim());
  spawned.push(pid);
  return pid;
}

/** Wait until `pid` is gone, up to `ms`. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(25);
  }
  return !alive(pid);
}

/**
 * What Pi's own `pi.exec` does: SIGTERM to the direct child only. Used as the
 * extension's API object, so the test shows what the extension adds on top.
 */
function piLikeExec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let killed = false;
    const timer = options.timeout ? setTimeout(() => { killed = true; proc.kill("SIGTERM"); }, options.timeout) : undefined;
    proc.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: "", stderr: "", code: code ?? 0, killed });
    });
  });
}

describe.skipIf(!posix)("execTree", () => {
  it("ends a background grandchild when the command times out", async () => {
    const dir = scratch();
    const pidFile = join(dir, "pid");
    const result = await execTree("sh", ["-c", `sleep 30 & echo $! > '${pidFile}'; wait`], { timeout: 300 });
    expect(result.killed).toBe(true);
    expect(await goneWithin(await pidFrom(pidFile), 2_000)).toBe(true);
  });

  it("ends the tree when its signal aborts", async () => {
    const dir = scratch();
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await execTree("sh", ["-c", `sleep 30 & echo $! > '${pidFile}'; wait`], { signal: controller.signal });
    expect(result.killed).toBe(true);
    expect(await goneWithin(await pidFrom(pidFile), 2_000)).toBe(true);
  });

  it("escalates to SIGKILL when the command ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await execTree("sh", ["-c", "trap '' TERM; sleep 30"], { timeout: 200, killGraceMs: 300 });
    expect(result.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports output and exit code like pi.exec", async () => {
    const ok = await execTree("sh", ["-c", "echo out; echo err >&2"]);
    expect(ok).toEqual({ stdout: "out\n", stderr: "err\n", code: 0, killed: false });
    const failed = await execTree("sh", ["-c", "exit 3"]);
    expect(failed.code).toBe(3);
    const missing = await execTree("definitely-not-a-command-xyz", []);
    expect(missing.code).not.toBe(0);
  });

  it("with killTreeOnExit, ends what the command left running and returns promptly", async () => {
    const dir = scratch();
    const pidFile = join(dir, "pid");
    const started = Date.now();
    const result = await execTree("sh", ["-c", `sleep 30 & echo $! > '${pidFile}'`], { killTreeOnExit: true });
    expect(result.killed).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await goneWithin(await pidFrom(pidFile), 2_000)).toBe(true);
  });

  it("is used only for the API object the extension registered", () => {
    const registered = { exec: piLikeExec };
    const other = { exec: piLikeExec };
    useTreeKillingExec(registered);
    expect(commandExec(registered)).toBe(execTree);
    expect(commandExec(other)).not.toBe(execTree);
  });
});

describe.skipIf(!posix)("workflow gates", () => {
  it("a gate that times out leaves no process behind", async () => {
    const dir = scratch();
    const pidFile = join(dir, "pid");
    const pi = { exec: piLikeExec };
    useTreeKillingExec(pi);
    const host = createWorkflowHost({
      pi: pi as never,
      ctx: { cwd: dir, model: undefined, modelRegistry: {}, ui: { notify() {} } } as never,
      manager: {} as never,
      gateTimeoutMs: 300,
    });

    const gate = await host.runGate?.(`sleep 30 & echo $! > '${pidFile}'; wait`, { agentId: "wf-agent-0", cwd: dir });

    expect(gate?.ok).toBe(false);
    expect(await goneWithin(await pidFrom(pidFile), 2_000)).toBe(true);
  });
});
