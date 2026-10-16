/**
 * project-trust.ts — Pi's project trust decision, as this extension applies it.
 *
 * Pi 1.x does not load a folder's `.pi` settings, extensions, skills or prompts
 * until the user trusts the folder. Subagents run in sessions this extension
 * builds itself, and this extension reads project files of its own (agents,
 * workflows, skills, `subagents.json`). By default (`projectTrust: "full"`) both
 * trust every project, as before 0.20.1; with `projectTrust: "pi"` in the global
 * subagents.json they follow the decision the parent session made.
 */

import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { globalProjectTrustMode } from "./settings.js";

/** Whether Pi's trust decision applies (`projectTrust: "pi"`); otherwise every project is trusted. */
function followsPiTrust(): boolean {
  try {
    return globalProjectTrustMode() === "pi";
  } catch {
    return false;
  }
}

/**
 * Whether the session behind `ctx` trusts its project.
 *
 * A context without `isProjectTrusted` comes from a Pi that predates project
 * trust and loaded every project resource itself, so the child matches it. A
 * context that throws (a session already torn down) is treated as untrusted.
 */
export function isProjectTrustedBy(ctx: { isProjectTrusted?: () => boolean } | undefined): boolean {
  if (!followsPiTrust()) return true;
  if (typeof ctx?.isProjectTrusted !== "function") return true;
  try {
    return ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

function savedDecision(cwd: string): boolean | null {
  return new ProjectTrustStore(getAgentDir()).get(cwd);
}

function defaultTrustIsAlways(cwd: string): boolean {
  return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getDefaultProjectTrust() === "always";
}

/**
 * Pi's decision for `cwd` as far as it can be known before a session exists.
 *
 * The extension activates before Pi has asked the user, so this mirrors what
 * Pi decides without asking: a folder with nothing Pi gates is trusted, and
 * otherwise a saved decision or `defaultProjectTrust: "always"` answers. A
 * folder still waiting for the prompt counts as untrusted until the session
 * reports otherwise.
 */
export function predictProjectTrust(cwd: string): boolean {
  if (!followsPiTrust()) return true;
  try {
    if (!hasTrustRequiringProjectResources(cwd)) return true;
    const saved = savedDecision(cwd);
    if (saved !== null) return saved;
    return defaultTrustIsAlways(cwd);
  } catch {
    return false;
  }
}

/**
 * Whether code from the project's own files may run here: a path entry in a
 * project agent's `extensions:`, or a saved project workflow.
 *
 * Pi trusts a folder without asking when nothing in it is gated, and
 * `.pi/agents` and `.pi/workflows` are not gated. So "trusted" alone does not
 * mean anyone agreed to run the folder's code. This also requires that Pi made
 * a decision: the folder has gated resources (so the user, a saved decision,
 * `defaultProjectTrust` or a CLI flag answered), or the trust store records the
 * folder as trusted (`/trust`).
 */
export function isProjectCodeTrusted(trusted: boolean, cwd: string): boolean {
  if (!followsPiTrust()) return true;
  if (!trusted) return false;
  try {
    return hasTrustRequiringProjectResources(cwd) || savedDecision(cwd) === true || defaultTrustIsAlways(cwd);
  } catch {
    return false;
  }
}
