/**
 * orchestration.ts — Settings and helpers for how subagents run under an
 * orchestrating parent: which tools the tool watchdog leaves alone, and which
 * tool lines of the parent's system prompt a subagent inherits.
 */

/**
 * Tools the subagent tool watchdog never stops, because they keep their own
 * deadline: a synchronous second opinion runs up to 60 minutes, and the 1200 s
 * watchdog stopped reviews that were still inside it.
 */
const DEFAULT_WATCHDOG_EXEMPT_TOOLS: readonly string[] = ["second_opinion_agent"];

let watchdogExemptTools: ReadonlySet<string> = new Set(DEFAULT_WATCHDOG_EXEMPT_TOOLS);
/** The list as the user set it (`watchdogExemptTools`), or undefined for the default. */
let watchdogSetting: string[] | undefined;

/** Tools the watchdog never stops (the `watchdogExemptTools` setting, else the default list). */
export function getWatchdogExemptTools(): ReadonlySet<string> {
  return watchdogExemptTools;
}

/** Replace the watchdog-exempt list (a setting replaces the default list; it does not add to it). */
export function setWatchdogExemptTools(names: string[]): void {
  watchdogSetting = [...names];
  watchdogExemptTools = new Set(names);
}

/** This module's settings as they would be written to `subagents.json`. */
export function orchestrationSettingsAsWritten(): { watchdogExemptTools?: string[] } {
  return { watchdogExemptTools: watchdogSetting };
}

/** A tool as the parent's system prompt lists it: its name line and its own guidelines. */
export interface PromptTool {
  name: string;
  promptGuidelines?: string[];
}

/**
 * Remove the lines of `tools` from an inherited system prompt: each tool's
 * `- name: …` line and its own guideline lines (`- guideline`). Lines are
 * matched exactly, so other text that mentions a tool name is kept.
 */
export function stripToolLines(prompt: string, tools: readonly PromptTool[]): string {
  if (tools.length === 0) return prompt;
  const prefixes = tools.map((t) => `- ${t.name}: `);
  const guidelines = new Set(tools.flatMap((t) => (t.promptGuidelines ?? []).map((g) => `- ${g.trim()}`)));
  return prompt
    .split("\n")
    .filter((line) => !prefixes.some((p) => line.startsWith(p)) && !guidelines.has(line.trim()))
    .join("\n");
}
