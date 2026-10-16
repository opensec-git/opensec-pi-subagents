import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { detectEnv } from "../src/env.js";

/** Minimal mock of pi.exec() that shells out via child_process. */
function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execSync(`${command} ${args.join(" ")}`, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (err: any) {
        return { stdout: "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

describe("detectEnv", () => {
  it("detects git repo in current project", async () => {
    const env = await detectEnv(mockPi(), process.cwd());
    expect(env.isGitRepo).toBe(true);
    expect(env.platform).toBe(process.platform);
  });

  it("returns branch name when on a branch", async () => {
    // Create a temp repo on a known branch to test branch detection
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-env-branch-"));
    try {
      execSync("git init && git config user.email test@test.com && git config user.name Test && git checkout -b test-branch && git commit --allow-empty -m init", {
        cwd: tmpDir, stdio: "pipe",
      });
      const env = await detectEnv(mockPi(), tmpDir);
      expect(env.isGitRepo).toBe(true);
      expect(env.branch).toBe("test-branch");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects non-git directory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-env-test-"));
    try {
      const env = await detectEnv(mockPi(), tmpDir);
      expect(env.isGitRepo).toBe(false);
      expect(env.branch).toBe("");
      expect(env.platform).toBe(process.platform);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("detectEnv cache", () => {
  function countingPi() {
    const calls: string[] = [];
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        calls.push(args.join(" "));
        return args[0] === "rev-parse"
          ? { stdout: "true\n", stderr: "", code: 0, killed: false }
          : { stdout: "main\n", stderr: "", code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;
    return { pi, calls };
  }

  it("runs git once for concurrent and back-to-back spawns in one cwd", async () => {
    const { pi, calls } = countingPi();
    const envs = await Promise.all(Array.from({ length: 8 }, () => detectEnv(pi, "/repo")));
    await detectEnv(pi, "/repo");
    expect(calls).toEqual(["rev-parse --is-inside-work-tree", "branch --show-current"]);
    for (const env of envs) expect(env).toEqual({ isGitRepo: true, branch: "main", platform: process.platform });
  });

  it("detects separately per cwd, and again once the entry is stale", async () => {
    vi.useFakeTimers();
    try {
      const { pi, calls } = countingPi();
      await detectEnv(pi, "/repo");
      await detectEnv(pi, "/repo/worktree");
      expect(calls).toHaveLength(4);
      vi.advanceTimersByTime(10_000);
      await detectEnv(pi, "/repo");
      expect(calls).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
