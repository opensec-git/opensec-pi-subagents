/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EnvInfo } from "./types.js";

/**
 * How long a detection is reused for the same `pi` and cwd. Every spawn needs
 * this, and it costs two sequential git processes (~25 ms), which is most of a
 * child's startup; a workflow fan-out asked the same question dozens of times
 * within a second. Short, so a branch switch shows up in the next spawns.
 */
const ENV_CACHE_MS = 10_000;

const envCache = new WeakMap<object, Map<string, { at: number; env: Promise<EnvInfo> }>>();

export function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const byCwd = envCache.get(pi) ?? new Map<string, { at: number; env: Promise<EnvInfo> }>();
  envCache.set(pi, byCwd);
  const now = Date.now();
  for (const [key, entry] of byCwd) if (now - entry.at >= ENV_CACHE_MS) byCwd.delete(key);
  const cached = byCwd.get(cwd);
  if (cached) return cached.env;
  // The promise is cached, so concurrent spawns share one detection.
  const env = detectEnvUncached(pi, cwd);
  byCwd.set(cwd, { at: now, env });
  return env;
}

async function detectEnvUncached(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  let isGitRepo = false;
  let branch = "";

  try {
    const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000 });
    isGitRepo = result.code === 0 && result.stdout.trim() === "true";
  } catch {
    // Not a git repo or git not installed
  }

  if (isGitRepo) {
    try {
      const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5000 });
      branch = result.code === 0 ? result.stdout.trim() : "unknown";
    } catch {
      branch = "unknown";
    }
  }

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}
