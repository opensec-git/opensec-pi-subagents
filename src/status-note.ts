/**
 * status-note.ts — Honest framing for an agent result: the parenthetical status
 * note for a non-normal outcome, and the salvaged partial output of a failure.
 *
 * Lives here rather than in an index.ts closure because both entry points need
 * it — the top-level tools and the nested delegation tools, which can't import
 * from index.ts (that is the extension entry, and it already reaches these tools
 * through agent-runner).
 */

import type { AgentRecord } from "./types.js";

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted` (the
 * turn limit was hit) — the parent should treat human intervention differently
 * from a budget cutoff.
 */
export function getStatusNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER before completion — the user ended this run; output is partial and the task was NOT finished)";
    case "aborted":
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}

/**
 * Foreground variant of `getStatusNote`. A foreground caller is in a different
 * position from a background one, so it needs different text:
 *
 *   - It already holds the agent's ENTIRE output inline, whereas the background
 *     notification carries a 500-char preview. So only here can we truthfully
 *     say there is nothing more to fetch — which is the whole point, because
 *   - a parent that reads "output may be partial" as "truncated, go retrieve
 *     the rest" calls `get_subagent_result` for nothing (#174). The result does
 *     carry the agent id now (`agentIdLine`), but only so the agent can be
 *     resumed; there is still nothing more to fetch.
 *
 * Only the lead clause varies between the three, and each variation carries
 * information: `wrapped up` vs `aborted` tells the parent whether the output is
 * a considered final answer or a fragment, and `stopped` shouts because a human
 * intervening outranks everything else in the string. Only `steered` hedges on
 * completion — it was told to wrap up and did, so it may well have finished at
 * the limit; an aborted run blew through its grace turns while still working,
 * and `stopped` can only fire on a running agent, so neither ever delivered a
 * final answer. Identical confidence gets identical wording: phrasing one fact
 * two ways invites a hunt for a distinction that isn't there.
 *
 * Every clause is a statement about state, never an instruction to act, and
 * `get_subagent_result` is never named — naming the tool we steer away from only
 * raises its salience. Two instructions were tried here and cut: "re-spawn with
 * a higher max_turns" (pushes a fresh multi-minute run to save one wasted tool
 * call) and, on `stopped`, "ask before restarting it" (restates the lead, and
 * presumes someone is present to ask — false under `pi -p`, in scheduled jobs,
 * and in any background-driven run). Nothing here can measure whether wording
 * improves parent behavior, so removing a false cue (which cannot induce new
 * behavior) and adding an instruction (which can) are not equally safe bets.
 * Don't add either back without a way to measure it.
 */
export function getForegroundOutcomeNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)";
    case "steered":
      return " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
    default:
      return "";
  }
}

/**
 * The line that hands the model an inline (foreground) agent's id. The
 * background envelope already carries one; without it here a foreground agent
 * could never be resumed, and a model told it can resume would invent an id.
 */
export function agentIdLine(id: string): string {
  return `\n\nAgent ID: ${id} (pass it as \`resume\` to continue this agent)`;
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}

/**
 * Whether a terminal status means the run did not deliver its answer: a
 * failure, a hard stop at the turn limit, or a stop by the user. Results in
 * these states go back to the model with `isError`, so it does not read a
 * fragment as a finished task. `steered` is not one: it wrapped up on request.
 */
export function isFailedStatus(status: string): boolean {
  return status === "error" || status === "aborted" || status === "stopped";
}

/**
 * Where every turn of a failed run can be read: its saved session file. Empty
 * for a session kept only in memory, which leaves nothing on disk.
 */
export function sessionFileLine(record: Pick<AgentRecord, "sessionFile">): string {
  return record.sessionFile ? `\n\nSession file (every turn of this agent): ${record.sessionFile}` : "";
}

/**
 * The model and thinking level the agent's latest run ran with, as
 * "provider/id, thinking: high", or undefined before a model is known.
 */
export function runModelText(record: Pick<AgentRecord, "invocation">): string | undefined {
  const modelId = record.invocation?.modelId;
  if (!modelId) return undefined;
  const thinking = record.invocation?.thinking;
  return thinking ? `${modelId}, thinking: ${thinking}` : modelId;
}
