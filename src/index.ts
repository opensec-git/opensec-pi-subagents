/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, isKeyRelease, Key, type KeyId, matchesKey, type ScrollViewScrollbar, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { abortable } from "./abortable.js";
import { hasAgentBadge, renderAgentName } from "./agent-color.js";
import { buildNewAgentFile, disableInContent, enableInContent, isEmptyStub, locateAgentFile, personalAgentsDir, projectAgentsDir, serializeAgentFile } from "./agent-file-toggle.js";
import { AgentManager, type CompactionInfo, isTopLevelAgent, type ManagerObservers, managerServices, RECORD_ENTRY_TYPE, RESUME_ENTRY_TYPE, resumeStateOf, resumeStatesFromEntries } from "./agent-manager.js";
import { boundBashTimeout, getAgentConversation, getDefaultMaxTurns, getGraceTurns, getRememberAgents, getToolTimeoutSeconds, normalizeMaxTurns, resolveEffectiveMaxTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns, setRememberAgents, setToolTimeoutSeconds, steerAgent } from "./agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, getConfig, getFallbackSubagent, isDefaultsDisabled, NO_FALLBACK, registerAgents, resolveSpawnType, resolveType, setDefaultsDisabled, setFallbackSubagent } from "./agent-types.js";
import { inChildSessionContext } from "./child-context.js";
import { boundCodemodeTimeout, CODEMODE_TOOL_NAME, createCodemodeAudit, getCodemodeTimeoutSeconds, setCodemodeTimeoutSeconds } from "./codemode-guard.js";
import { CompletionOutbox, NOTIFICATION_HOLD_MS } from "./completion-outbox.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { useTreeKillingExec } from "./exec-tree.js";
import { GroupJoinManager } from "./group-join.js";
import { isModelOverrideAllowed, isolationParam, resolveAgentInvocationConfig, resolveJoinMode, setModelOverrideAllowed } from "./invocation-config.js";
import { describeMention, handleBase, isReservedHandle, parseMention, resolveHandleToType, stripAgentPrefix } from "./mention.js";
import { runMentionClone } from "./mention-clone.js";
import { describeModel, type ModelRegistry, resolveModel, resolveModelDetailed, unresolvedModelNote, unresolvedReason } from "./model-resolver.js";
import { checkModelScope, isScopeModelsEnabled, setScopeModelsEnabled } from "./model-scope.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "./nested-tools.js";
import { orchestrationSettingsAsWritten, setWatchdogExemptTools } from "./orchestration.js";
import { createOutputFilePath, ensureOutputFile, getOutputTranscriptDefault, sessionTaskDir, setOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { isProjectCodeTrusted, isProjectTrustedBy, predictProjectTrust } from "./project-trust.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { readSavedResult } from "./session-file.js";
import { appendToSessionFile, type EntryWriter, HANDOFF_PROTOCOL, isCompatible, isSessionOnDisk, isSessionSwitch, PACKAGE_VERSION, type ParkedSubagents, parkSubagents, sessionFileOf, takeParkedSubagents } from "./session-handoff.js";
import { applyAndEmitLoaded, applySettings, loadSettings, type SettingsAppliers, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { agentIdLine, getForegroundOutcomeNote, getStatusNote, isFailedStatus, partialOutputSuffix, resumeHintXml, runModelText, sessionFileLine } from "./status-note.js";
import { AGENT_ARG_SHAPE, argumentRepair, RESULT_ARG_SHAPE, STEER_ARG_SHAPE } from "./tool-args.js";
import { type AgentConfig, type AgentInvocation, type AgentMentionMode, type AgentRecord, type AgentResumeState, type JoinMode, type NotificationDetails, type SubagentType, type WidgetMode } from "./types.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatCost,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type Theme,
  type UICtx,
} from "./ui/agent-widget.js";
import { ConversationViewer, getConversationOverlayOptions, type ViewerBackgroundAction, type ViewerRenderOptions } from "./ui/conversation-viewer.js";
import { FleetList, type FleetUICtx, type FleetWorkflow } from "./ui/fleet-list.js";
import { RefreshTicker } from "./ui/refresh-ticker.js";
import { showSchedulesMenu } from "./ui/schedule-menu.js";
import { selectItem } from "./ui/select-item.js";
import { renderWorkflowCard, renderWorkflowEntryCard } from "./ui/workflow-card.js";
import { openWorkflowFromFleet, showWorkflowsMenu, type WorkflowMenuDeps } from "./ui/workflow-menu.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, PendingUsagePool, toReportedUsage } from "./usage.js";
import { decideWorkflowCollision, FOREIGN_WORKFLOW_TOOL_NAMES } from "./workflow/collisions.js";
import { WORKFLOW_ENTRY_TYPE, type WorkflowEntryData, workflowEntryData } from "./workflow/entry.js";
import { createWorkflowHost } from "./workflow/host.js";
import { appendJournal, readJournal, type WorkflowJournalEntry } from "./workflow/journal.js";
import { extractMeta, type WorkflowMeta, workflowCallName } from "./workflow/meta.js";
import { elapsedMs } from "./workflow/progress.js";
import { runWorkflow } from "./workflow/runtime.js";
import { resolveWorkflowScript } from "./workflow/saved.js";
import { readWorkflowScriptFile } from "./workflow/script-file.js";
import { completeWorkflowTask, createWorkflowTask, failWorkflowTask, formatWorkflowNotification, pruneSettledWorkflowTasks, resolveResumeTarget, updateWorkflowProgressBatch, type WorkflowTask, workflowResultText, workflowRunId } from "./workflow/task.js";
import { workflowToolDescription } from "./workflow/tool-description.js";
import { isWorktreeIsolationEnabled, MERGED_BRANCH_MAX_AGE_DAYS, pruneMergedAgentBranches, recoverLeftoverWorktrees, setWorktreeIsolationEnabled } from "./worktree.js";
import { escapeXml } from "./xml.js";

// ---- Shared helpers ----

/**
 * Tool execute return value for a text response. `isError` reports a failure
 * without throwing: the model reads the text as an error result, while
 * `details` still reaches the renderer.
 */
function textResult(msg: string, details?: AgentDetails, isError = false) {
  return {
    content: [{ type: "text" as const, text: msg }],
    details: details as any,
    ...(isError ? { isError: true } : {}),
  };
}

/** A refusal or lookup failure: an error result with no agent details. */
function errorResult(msg: string) {
  return textResult(msg, undefined, true);
}

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

/**
 * What a background spawn or resume tells the model about the result. The
 * notification is the signal: get_subagent_result is for the full text after
 * it, and calling it before only invites a polling loop.
 */
const BACKGROUND_FOLLOW_UP =
  "You will be notified when this agent completes — continue with other work meanwhile, and do not poll it.\n" +
  "After the notification, get_subagent_result returns its full result. steer_subagent sends it a message mid-run.";

/** What get_subagent_result says of an agent whose run is not over yet. */
function stillRunningText(state: "running" | "queued" | "stopping"): string {
  const lead = state === "stopping"
    ? "Agent was stopped and is still winding down."
    : `Agent is still ${state}.`;
  return `${lead} A completion notification will arrive on its own when it finishes — continue with other work ` +
    "meanwhile, and do not call get_subagent_result for this agent again until that notification arrives.";
}

/** How long a foreground `Agent` call runs before its row offers the background key. */
const BACKGROUND_HINT_DELAY_MS = 2000;

/** The `backgroundKey` default: Claude Code's ctrl+b (`task:background`). */
const DEFAULT_BACKGROUND_KEY = "ctrl+b";

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(maxTurns?: number) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    // Spend is accumulated on the AgentRecord (agent-manager), which is what
    // every surface reads. Surfaces pick changes up on their next frame (the
    // widget tick, the foreground spinner) rather than one push per event.
    onAssistantUsage: (_usage: LifetimeUsage) => {},
  };

  return { state, callbacks };
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Lines of a result a completion notification carries; get_subagent_result has the rest. */
const NOTIFICATION_PREVIEW_LINES = 10;

/**
 * The head of a result for a notification: its first `maxLines` lines, cut at
 * `maxLen` characters as well so one huge line cannot flood the parent's
 * context. When anything is left out, a note says how much and where the rest
 * is.
 */
export function previewResult(result: string, maxLen: number, maxLines: number): string {
  const lines = result.split("\n");
  let head = lines.slice(0, maxLines).join("\n");
  if (head.length > maxLen) head = head.slice(0, maxLen);
  if (head.length === result.length) return result;
  // A line cut part-way counts as not shown: its end is missing.
  const headLines = head.split("\n").length;
  const fullLines = result[head.length] === "\n" ? headLines : headLines - 1;
  const totalBytes = Buffer.byteLength(result, "utf8");
  const missingBytes = totalBytes - Buffer.byteLength(head, "utf8");
  return `${head}\n...(truncated: ${lines.length - fullLines} of ${lines.length} lines and ${missingBytes} of ${totalBytes} bytes ` +
    "not shown; use get_subagent_result for the full output)";
}

/**
 * Format a structured task notification matching Claude Code's <task-notification> XML.
 * The result is previewed by lines (`maxLines`) within `resultMaxLen` characters.
 */
function formatTaskNotification(
  record: AgentRecord,
  resultMaxLen: number,
  showCost = false,
  maxLines = NOTIFICATION_PREVIEW_LINES,
): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";
  // Only under `showCost`: this is LLM context, and a figure the orchestrator
  // did not ask for is a figure it may start reporting unprompted.
  const cost = showCost ? getLifetimeCost(record.lifetimeUsage) : 0;
  const costXml = cost > 0 ? `<estimated_cost_usd>${cost.toFixed(4)}</estimated_cost_usd>` : "";

  const resultPreview = record.result ? previewResult(record.result, resultMaxLen, maxLines) : "No output.";
  // The whole result's size, so the parent can judge whether fetching the rest is worth it.
  const resultBytes = record.result ? `<result_bytes>${Buffer.byteLength(record.result, "utf8")}</result_bytes>` : null;

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    // A failed run's every turn is in its saved session.
    record.sessionFile && isFailedStatus(record.status) ? `<session-file>${escapeXml(record.sessionFile)}</session-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    // What the run actually ran on, which a fuzzy model name or a fallback can change.
    record.invocation?.modelId ? `<model>${escapeXml(record.invocation.modelId)}</model>` : null,
    record.invocation?.modelId && record.invocation.thinking ? `<thinking>${escapeXml(record.invocation.thinking)}</thinking>` : null,
    // The agent file's model did not resolve and the run used another.
    record.modelNote ? `<model-note>${escapeXml(record.modelNote)}</model-note>` : null,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status, record.stopCause)}</summary>`,
    // A run that did not finish keeps its context: name the id to resume it with.
    resumeHintXml(record),
    `<result>${escapeXml(resultPreview)}</result>`,
    resultBytes,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}${costXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any; lifetimeUsage: LifetimeUsage },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    // Raw, and unconditional: `tokens` is preformatted because it is one stat,
    // but a cost is joined by "·" in one surface, "," in another and "|" in a
    // third — so it travels as a number and each renderer punctuates its own.
    cost: getLifetimeCost(record.lifetimeUsage),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    // Carried unconditionally; the renderer gates on the setting. Details are
    // data, and a notification rendered before a mid-session toggle should not
    // be stuck with the old answer.
    totalCost: getLifetimeCost(record.lifetimeUsage),
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

/** Session entry marking `pending` results (see {@link recordEntryData}) as delivered. */
const DELIVERED_ENTRY_TYPE = "subagents:delivered";

/**
 * A top-level agent's `subagents:record` entry. `pending`: its session has not
 * been notified yet — it finished while another session was open — and
 * delivers the notification when it starts; the extra figures let it render
 * one from the entry alone.
 */
function recordEntryData(record: AgentRecord, pending = false): Record<string, unknown> {
  return {
    id: record.id, type: record.type, description: record.description,
    status: record.status, result: record.result, error: record.error,
    ...(record.status === "stopped" && record.stopCause ? { stopCause: record.stopCause } : {}),
    startedAt: record.startedAt, completedAt: record.completedAt,
    resume: resumeStateOf(record),
    ...(pending
      ? { pending: true, toolUses: record.toolUses, lifetimeUsage: { ...record.lifetimeUsage }, outputFile: record.outputFile, toolCallId: record.toolCallId }
      : {}),
  };
}

/** An owned child's `subagents:resume` entry, or undefined without a session file to reopen. */
function resumeEntryData(record: AgentRecord): { resume: ReturnType<typeof resumeStateOf> } | undefined {
  const resume = resumeStateOf(record);
  return resume ? { resume } : undefined;
}

/**
 * The `pending` results among a session's entries that no later
 * `subagents:delivered` entry covers, in order, as record-shaped objects a
 * notification can be rendered from.
 */
export function pendingResultsFromEntries(entries: readonly unknown[]): AgentRecord[] {
  const pending = new Map<string, AgentRecord>();
  for (const entry of entries) {
    const e = entry as { type?: unknown; customType?: unknown; data?: Record<string, unknown> } | null;
    if (e?.type !== "custom" || !e.data) continue;
    if (e.customType === RECORD_ENTRY_TYPE && e.data.pending === true && typeof e.data.id === "string") {
      const d = e.data;
      pending.set(d.id as string, {
        id: d.id as string,
        type: String(d.type ?? ""),
        description: String(d.description ?? ""),
        status: (d.status as AgentRecord["status"]) ?? "completed",
        stopCause: d.stopCause === "session-end" || d.stopCause === "user" ? d.stopCause : undefined,
        sessionFile: typeof (d.resume as { sessionFile?: unknown } | undefined)?.sessionFile === "string" ? (d.resume as { sessionFile: string }).sessionFile : undefined,
        result: typeof d.result === "string" ? d.result : undefined,
        error: typeof d.error === "string" ? d.error : undefined,
        startedAt: typeof d.startedAt === "number" ? d.startedAt : 0,
        completedAt: typeof d.completedAt === "number" ? d.completedAt : undefined,
        toolUses: typeof d.toolUses === "number" ? d.toolUses : 0,
        lifetimeUsage: (d.lifetimeUsage as LifetimeUsage | undefined) ?? { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
        outputFile: typeof d.outputFile === "string" ? d.outputFile : undefined,
        toolCallId: typeof d.toolCallId === "string" ? d.toolCallId : undefined,
      });
    } else if (e.customType === DELIVERED_ENTRY_TYPE && Array.isArray(e.data.ids)) {
      for (const id of e.data.ids) if (typeof id === "string") pending.delete(id);
    }
  }
  return [...pending.values()];
}

/** Session entry recording that the restart notice named these agents (see {@link interruptedAgentsFromEntries}). */
const INTERRUPTED_NOTICE_ENTRY_TYPE = "subagents:interrupted-notice";

/** An agent the parent session's end interrupted, as the restart notice names it. */
export interface InterruptedAgent {
  id: string;
  type: string;
  description: string;
}

/**
 * The agents of a session that its last end interrupted (`stopped` with
 * `stopCause: "session-end"` in their latest `subagents:record` entry) and that
 * can be resumed (a saved session), less those a `subagents:interrupted-notice`
 * entry already named. A later record of the same agent (resumed and finished,
 * stopped by the user) replaces the earlier one.
 */
export function interruptedAgentsFromEntries(entries: readonly unknown[]): InterruptedAgent[] {
  const interrupted = new Map<string, InterruptedAgent>();
  for (const entry of entries) {
    const e = entry as { type?: unknown; customType?: unknown; data?: Record<string, unknown> } | null;
    if (e?.type !== "custom" || !e.data) continue;
    if (e.customType === RECORD_ENTRY_TYPE && typeof e.data.id === "string") {
      const d = e.data;
      const resume = d.resume as { sessionFile?: unknown; stopCause?: unknown } | undefined;
      const cause = d.stopCause ?? resume?.stopCause;
      interrupted.delete(d.id as string);
      if (d.status === "stopped" && cause === "session-end" && typeof resume?.sessionFile === "string") {
        interrupted.set(d.id as string, { id: d.id as string, type: String(d.type ?? ""), description: String(d.description ?? "") });
      }
    } else if (e.customType === INTERRUPTED_NOTICE_ENTRY_TYPE && Array.isArray(e.data.ids)) {
      for (const id of e.data.ids) if (typeof id === "string") interrupted.delete(id);
    }
  }
  return [...interrupted.values()];
}

/**
 * The notice the first run after a restart gets, ahead of its prompt: which
 * agents the session's end interrupted, and that they are resumed, not replaced.
 */
export function formatInterruptedNotice(agents: readonly InterruptedAgent[]): string {
  const lines = agents.map((a) => `- ${a.id} (${a.type}): ${a.description}`);
  return [
    `<interrupted-agents>`,
    `${agents.length === 1 ? "1 background agent" : `${agents.length} background agents`} of this session ${agents.length === 1 ? "was" : "were"} still running when the session last ended, and ${agents.length === 1 ? "was" : "were"} interrupted by that, not stopped by anyone. Each keeps its whole context: to finish its task, resume it with the Agent tool (\`resume: "<id>"\` and a prompt to continue) instead of starting a fresh agent, which would redo its work.`,
    ...lines,
    `</interrupted-agents>`,
  ].join("\n");
}

/**
 * Stop a parked manager's agents with this (the parking instance's) code and
 * record each in its own session, as a quit would. For an adopter of another
 * version, or a parked manager something else replaced. Touches no instance
 * state: the instance that parked it is gone.
 */
async function stopParkedAgents(manager: AgentManager, entry: ParkedSubagents, write?: EntryWriter): Promise<void> {
  manager.setObservers({});
  const put = (record: AgentRecord, pending: boolean): void => {
    const [type, data] = isTopLevelAgent(record)
      ? [RECORD_ENTRY_TYPE, recordEntryData(record, pending)]
      : [RESUME_ENTRY_TYPE, resumeEntryData(record)];
    if (!data) return;
    if (!write?.(record.ownerSession, type, data)) appendToSessionFile(record.ownerSession, type, data);
  };
  for (const record of entry.completed.splice(0) as AgentRecord[]) put(record, isTopLevelAgent(record) && !record.resultConsumed);
  const interrupted = manager.listAllAgents().filter(r => r.status === "running" || r.status === "queued");
  manager.abortAll("session-end");
  await manager.awaitWorktreeCleanup(15_000);
  for (const record of interrupted) put(record, false);
  await manager.dispose();
}

/**
 * The process is exiting with a manager still parked (no instance took it
 * over): record what can be recorded, synchronously — results that settled
 * while parked, and the running agents as stopped. Worktrees cannot be
 * committed this late; a later start recovers them (`recoverLeftoverWorktrees`).
 */
function recordParkedAgentsAtExit(manager: AgentManager, entry: ParkedSubagents): void {
  manager.setObservers({});
  const put = (record: AgentRecord, pending: boolean): void => {
    const data = isTopLevelAgent(record) ? recordEntryData(record, pending) : resumeEntryData(record);
    if (data) appendToSessionFile(record.ownerSession, isTopLevelAgent(record) ? RECORD_ENTRY_TYPE : RESUME_ENTRY_TYPE, data);
  };
  for (const record of entry.completed.splice(0) as AgentRecord[]) put(record, isTopLevelAgent(record) && !record.resultConsumed);
  for (const record of manager.listAllAgents()) {
    if (record.status !== "running" && record.status !== "queued") continue;
    record.status = "stopped";
    record.stopCause = "session-end";
    record.completedAt ??= Date.now();
    put(record, false);
  }
}

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools (the shipped defaults); `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see test/fixtures/.pi/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}

/** CLI flag that runs a workflow script at session start. */
export const WORKFLOW_FILE_FLAG = "subagents-workflow-file";

/**
 * Re-exported from where they now live, because this is where they were
 * defined and a consumer (or a test) that matched a session entry on
 * {@link WORKFLOW_ENTRY_TYPE} imports it from here.
 */
export { FOREIGN_WORKFLOW_TOOL_NAMES, WORKFLOW_ENTRY_TYPE, type WorkflowEntryData, workflowEntryData };

const PACKAGE_NAME = "@kushalkhemka/opensec-pi-subagents";
/** Shared with opensec-pi-swarm: which of the two packages is active in this process. */
const OWNER_KEY = Symbol.for("pi-subagents:owner");
const CONFLICT_WARNED_KEY = Symbol.for("pi-subagents:owner-conflict-warned");

interface OwnerClaim { package: string; activations: number }

/**
 * Claim the process for this package, or report that the other fork holds it
 * and return undefined. A claim by this same package (another activation) is
 * shared, counted, and released by the last of them. Returns the release.
 */
function claimSubagentsOwner(pi: ExtensionAPI, packageName: string): (() => void) | undefined {
  const global = globalThis as Record<symbol, unknown>;
  const owner = global[OWNER_KEY] as OwnerClaim | undefined;
  if (owner && owner.package !== packageName) {
    const message = `${packageName} is disabled: ${owner.package} is already loaded and registers the same tools. ` +
      "They cannot run together; uninstall one of them.";
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else if (!global[CONFLICT_WARNED_KEY]) {
        global[CONFLICT_WARNED_KEY] = true;
        console.warn(`[pi-subagents] ${message}`);
      }
    });
    return undefined;
  }
  const claim = owner ?? { package: packageName, activations: 0 };
  claim.activations++;
  global[OWNER_KEY] = claim;
  let released = false;
  // Called on shutdown, so the next activation (/reload, /new) can claim.
  return () => {
    if (released) return;
    released = true;
    if (global[OWNER_KEY] === claim && --claim.activations <= 0) delete global[OWNER_KEY];
  };
}

export default function (pi: ExtensionAPI) {
  // Child AgentSessions load normal extensions. Re-entering this extension there
  // would create another manager and leak handlers. Nested orchestration is
  // injected as scoped custom tools by the existing manager instead.
  if (inChildSessionContext()) return;

  // opensec-pi-subagents and opensec-pi-swarm (a fork of it) register the same
  // tool names, `subagents:*` RPC events and process-global manager registry,
  // so only one of them can be active in a process: the first to load claims
  // it, and the other disables itself with a warning.
  const releaseOwner = claimSubagentsOwner(pi, PACKAGE_NAME);
  if (!releaseOwner) return;

  // Gates and worktree git calls run so a timeout or stop ends their whole
  // process tree, which Pi's own `pi.exec` does not do (see exec-tree.ts).
  useTreeKillingExec(pi);

  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (showCost) {
          const costText = formatCost(d.totalCost ?? 0);
          if (costText) parts.push(costText);
        }
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        // Line 4: output file link (if present)
        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      const rendered = all.map(renderOne);
      // A group of agents lands as one notification, and the number a user wants
      // from it is what the batch cost — not four figures to add up by hand.
      // Derived from the per-agent details rather than carried alongside them:
      // one source, so the total can never disagree with the rows above it.
      if (showCost && all.length > 1) {
        const total = formatCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
        if (total) {
          const tokens = all.reduce((sum, a) => sum + a.totalTokens, 0);
          rendered.unshift(theme.fg("dim", `${all.length} agents · ${formatTokens(tokens)} · ${total}`));
        }
      }
      return new Text(rendered.join("\n"), 0, 0);
    }
  );

  // ---- Workflow run rendered as a session entry ----
  // A workflow launched from the CLI flag has no tool call to hang its result
  // card on, so it renders here instead — through the SAME layout the tool
  // result uses, not a second one. Custom entries with no registered renderer
  // are silently dropped by the host, which is why this is registered at
  // activation rather than lazily.
  pi.registerEntryRenderer<WorkflowEntryData>(WORKFLOW_ENTRY_TYPE, (entry, _options, theme) =>
    renderWorkflowEntryCard(entry.data, theme));

  // Registered at activation; READ from session_start. The host applies CLI
  // values after every extension factory has run, so `getFlag` here would only
  // ever hand back the registered default (see the read site below).
  pi.registerFlag(WORKFLOW_FILE_FLAG, {
    type: "string",
    description:
      `Run a workflow script at startup: --${WORKFLOW_FILE_FLAG}=<path>. ` +
      "Use the `=` form — the space form consumes the next argument, which would swallow a following prompt.",
  });

  // Whether this extension may read the project's own files (agents, skills,
  // workflows, subagents.json). The extension activates before Pi has asked the
  // user about trust, so startup goes by Pi's predicted decision and
  // session_start replaces it with the real one (`syncProjectTrust`).
  let projectTrusted = predictProjectTrust(process.cwd());

  // Read directly rather than waiting for applyAndEmitLoaded below: this decides
  // the initial load, which happens hundreds of lines before settings are applied.
  let strictAgentFiles = loadSettings(process.cwd(), projectTrusted).strictAgentFiles === true;

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict, { project: projectTrusted });
    registerAgents(userAgents);
  };

  // Initial load — the only strict one. A bad edit mid-session must not kill the
  // session on the next unrelated spawn, so every later reload keeps warning.
  reloadCustomAgents(strictAgentFiles);

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Usage reporting (both off by default; see SubagentsSettings) ----
  /** Attach subagent spend to tool results, so the parent session counts it. */
  let reportUsage = false;
  function isReportUsageEnabled(): boolean { return reportUsage; }
  function setReportUsage(b: boolean): void {
    reportUsage = b;
    // Whatever accumulated while it was on is stale the moment it goes off:
    // draining it later would bill the parent for a window the user opted out
    // of, in one lump, on some unrelated later tool call.
    if (!b) pendingUsage.drain();
  }
  /** Show `~$X` next to token counts in the subagent surfaces. */
  let showCost = false;
  function isShowCostEnabled(): boolean { return showCost; }
  function setShowCost(b: boolean): void { showCost = b; widget.update(); fleet.update(); }
  /** Name the model and thinking level on the widget's running rows. */
  let showModel = false;
  function isShowModelEnabled(): boolean { return showModel; }
  function setShowModel(b: boolean): void { showModel = b; widget.update(); }
  /** The `backgroundKey` setting as written; undefined means the default. Persisted as written. */
  let backgroundKeySetting: string | undefined;
  function setBackgroundKey(key: string): void { backgroundKeySetting = key; }
  /** The key that hands foreground `Agent` calls to the background, or undefined when it is off. */
  function getBackgroundKey(): string | undefined {
    const key = backgroundKeySetting ?? DEFAULT_BACKGROUND_KEY;
    return key === "off" ? undefined : key;
  }
  const pendingUsage = new PendingUsagePool();

  /**
   * Set once this activation's session is shutting down (`/new`, `/resume`,
   * `/reload`, quit). Pi invalidates `pi` and every ctx then, and a call on a
   * stale one throws — from a detached completion that is an unhandled
   * rejection, which ends pi. Every detached path checks it first.
   */
  let disposed = false;
  /** Bumped at every shutdown: work started under an older value belongs to a torn-down session. */
  let sessionGeneration = 0;
  /** Off-screen mention clones in flight, aborted at shutdown so they stop spending. */
  const mentionClones = new Set<AbortController>();

  /**
   * Hand pending subagent spend to the parent session as a `usage` entry, which
   * pi counts in `getSessionStats()` (footer, statusline, `/cost`) without
   * putting it in the LLM context. For spend no subagent tool result will carry
   * back: background and workflow agents that finish after the last such call,
   * and the `@mention` clone's own turn. Pi < 1.0 has no `appendUsage`, and the
   * spend then waits for the next tool result as before.
   */
  function flushPendingUsage(ctx: ExtensionContext | undefined = currentCtx): void {
    if (!reportUsage || disposed || !ctx) return;
    try {
      type UsageWriter = { appendUsage?: (kind: string, provider: string, model: string, usage: unknown, note?: string) => unknown };
      const sessionManager = ctx.sessionManager as unknown as UsageWriter;
      if (typeof sessionManager.appendUsage !== "function") return;
      const usage = pendingUsage.drain();
      if (usage) sessionManager.appendUsage("subagents", "pi-subagents", "subagents", usage, "subagent spend");
    } catch { /* a session going away cannot record anything */ }
  }

  /** Flush now if the parent is between turns; otherwise `agent_end` or the next tool result will. */
  function flushPendingUsageIfIdle(): void {
    try {
      if (currentCtx?.isIdle()) flushPendingUsage();
    } catch { /* stale ctx */ }
  }

  // ---- Completion delivery ----
  // Every completion notification goes through the outbox, which sends what is
  // pending as one message at the parent's next boundary (see
  // completion-outbox.ts). Each is built when the agent finishes, and reading
  // the result (get_subagent_result, rpc consume) cancels it before it is sent.
  const outbox = new CompletionOutbox(
    (message) => {
      // A torn-down session cannot take a message (`pi` is stale).
      if (disposed) return;
      pi.sendMessage<NotificationDetails>({
        customType: "subagent-notification",
        content: message.content,
        display: true,
        details: message.details,
      }, { deliverAs: "steer", triggerTurn: true });
    },
    () => parentTurnActive(),
  );

  /** Whether the parent has a run in flight, so a `turn_end` is coming. A stale ctx has none. */
  function parentTurnActive(): boolean {
    try {
      return currentCtx?.signal !== undefined;
    } catch {
      return false;
    }
  }
  // A queued result wait must observe completion before its held notification
  // can fire, so successful waits can still suppress that redundant nudge.
  const QUEUE_WAIT_POLL_MS = Math.floor(NOTIFICATION_HOLD_MS / 4);

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    fleet.onAgentFinished(record.id);
    // Built now, so a resume before the send cannot rewrite it. A record that
    // cannot be formatted is skipped, as a failed send always was.
    try {
      const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';
      const message = {
        content: formatTaskNotification(record, 500, showCost) + footer,
        details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
      };
      outbox.add({ ids: [record.id], build: () => message });
    } catch { /* ignore stale completion side-effect errors */ }
    widget.update();
  }

  // ---- Group join manager (`group` join mode only) ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); fleet.onAgentFinished(r.id); }

      const members = records.filter(r => !r.resultConsumed).flatMap(r => {
        try {
          return [{ id: r.id, text: formatTaskNotification(r, 300, showCost), details: buildNotificationDetails(r, 300, agentActivity.get(r.id)) }];
        } catch { return []; /* as in sendIndividualNudge */ }
      });
      if (members.length > 0) {
        outbox.add({
          ids: members.map(m => m.id),
          build: (ids) => {
            const unread = members.filter(m => ids.includes(m.id));
            const notifications = unread.map(m => m.text).join('\n\n');
            const label = partial
              ? `${unread.length} agent(s) finished (partial — others still running)`
              : `${unread.length} agent(s) finished`;

            const [first, ...rest] = unread;
            const details = first.details;
            if (rest.length > 0) details.others = rest.map(m => m.details);
            return {
              content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
              details,
            };
          },
        });
      }
      widget.update();
    },
    30_000,
  );

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    // The whole run's spend as a pi `Usage` — pi's convention for handing spend
    // to a consumer, so `usage.cost.total` and `usage.cacheRead` are where a
    // listener already expects them and anything pi adds to `Usage` arrives
    // without a change here. Omitted when nothing was spent, so "spent nothing"
    // and "never ran" stay distinguishable. Ungated by `showCost`: that setting
    // governs what a human is shown, not what the event carries.
    //
    // `tokens` above is the other convention, kept as it shipped: a flat view
    // model like pi's own `SessionStats`, carrying the DISPLAY total, which
    // excludes cacheRead (#38). The two answer different questions and neither
    // derives from the other.
    const usage = toReportedUsage(u);
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      usage,
    };
  }

  /**
   * The session this activation belongs to: its session file, or undefined for
   * one kept in memory. Agents spawned here carry it as `ownerSession`; a
   * background agent that outlives a session switch (session-handoff.ts)
   * reports to its owner, not to whichever session is open.
   */
  let currentSession: string | undefined;
  /** Agents the last end of the current session interrupted, for the next run's notice (see `before_agent_start`). */
  let interruptedNotice: InterruptedAgent[] = [];
  const ownedHere = (record: Pick<AgentRecord, "ownerSession">): boolean => record.ownerSession === currentSession;

  /**
   * Write a custom entry into the session `owner`: through `pi` while that is
   * the session this instance has open (Pi keeps it in memory), otherwise by
   * appending to the owner's file, which Pi reads when it is opened again.
   * Guarded: it also runs while the session is shutting down, and after.
   */
  function writeEntry(owner: string | undefined, customType: string, data: unknown): boolean {
    if (owner === currentSession) {
      try {
        pi.appendEntry(customType, data);
        return true;
      } catch { /* torn down: the session is no longer open, so its file is safe to append to */ }
    }
    return appendToSessionFile(owner, customType, data);
  }

  // Background completion: route through group join or send individual nudge
  /**
   * Write a top-level agent's final record into the session it belongs to.
   * `resume` carries what reopening it needs (session file, handle, model,
   * directory, worktree, isolation, turn limit); `session_start` reads it back,
   * so the agent stays resumable after a restart, `/resume`, `/fork` or
   * `/reload`. `pending` marks a result its session has not been told about
   * yet (it finished while another session was open); that session delivers it
   * when it starts.
   */
  function appendRecordEntry(record: AgentRecord, pending = false): void {
    writeEntry(record.ownerSession, RECORD_ENTRY_TYPE, recordEntryData(record, pending));
  }

  /**
   * Write an owned child's resume state (a nested agent's, a workflow's) into
   * the session it belongs to, so `session_start` can rebuild it after a
   * restart, `/resume`, `/fork` or `/reload`: its owner can then reopen it from
   * its session file — the parent agent's nested tools, or a workflow's
   * `agent({ resume })`. Only the resume state, never the result: the owner
   * already has that, and the entry stays small. Nothing for an agent without
   * a session file.
   */
  function appendResumeEntry(record: AgentRecord): void {
    const data = resumeEntryData(record);
    if (data) writeEntry(record.ownerSession, RESUME_ENTRY_TYPE, data);
  }

  /**
   * A top-level agent of another session finished while this one is open: its
   * result belongs to that session. Record it there, marked for delivery; no
   * notification, event or row here.
   */
  function completeForeignAgent(record: AgentRecord): void {
    agentActivity.delete(record.id);
    appendRecordEntry(record, !record.resultConsumed);
  }

  function onAgentComplete(record: AgentRecord): void {
    // After shutdown `pi` is stale, and the shutdown handler records the
    // agents it interrupted itself.
    if (disposed) return;
    // Owned children — nested, or a workflow's — report only through their
    // owner: the parent's scoped tools, or the workflow's card, notification
    // and dialog. Keep them out of top-level lifecycle, transcript,
    // notification, and UI channels. Their resume state is still recorded.
    if (!isTopLevelAgent(record)) {
      flushPendingUsageIfIdle();
      appendResumeEntry(record);
      return;
    }
    if (!ownedHere(record)) {
      completeForeignAgent(record);
      return;
    }
    // Spend that landed after the parent's last subagent tool result.
    flushPendingUsageIfIdle();

    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction, and the
    // state needed to resume the agent after a restart or session switch.
    appendRecordEntry(record);

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      fleet.onAgentFinished(record.id);
      widget.update();
      return;
    }

    // A `group` spawn whose turn has not ended yet: its group is registered at
    // that turn's end, which picks this completion up retroactively.
    if (turnGroupSpawns.includes(record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    widget.update();
  }

  function onAgentStart(record: AgentRecord): void {
    if (disposed || !isTopLevelAgent(record) || !ownedHere(record)) return;
    // Agent-tool spawns refresh these surfaces in their tool handler, but RPC
    // and scheduler spawns enter through the manager directly.
    if (currentCtx?.hasUI) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }

  function onAgentCompact(record: AgentRecord, info: CompactionInfo): void {
    if (disposed || !isTopLevelAgent(record) || !ownedHere(record)) return;
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }

  function onAgentUsage(record: AgentRecord, usage: LifetimeUsage): void {
    // Every assistant message from every agent — nested included, exactly once.
    // Parked here until a tool result can carry it back to the parent session;
    // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
    // pool grows in a session that will never drain it. Another session's
    // agents bill that session, not this one.
    if (reportUsage && ownedHere(record)) pendingUsage.add(usage);
  }

  const managerObservers: ManagerObservers = {
    onComplete: onAgentComplete,
    onStart: onAgentStart,
    onCompact: onAgentCompact,
    onUsage: onAgentUsage,
  };

  /**
   * Replaced at `session_start` by a manager the previous session parked, so
   * its background agents keep running (see session-handoff.ts). Everything
   * reads it through this binding, never a copy.
   */
  let manager = new AgentManager(onAgentComplete, undefined, onAgentStart, onAgentCompact, onAgentUsage);

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  // Documented for callers in docs/rpc.md ("The manager registry").
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  // Process-external callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by scoped tools.
  /**
   * Resolve the agent type and spawn. Trusts its options — every caller must
   * either be in-process or have gone through `spawnTopLevel` first.
   */
  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Reload first so an agent file added mid
    // session is spawnable here too, not only through the Agent tool.
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    // Every programmatic spawn lands here — cross-extension RPC, both `@handle`
    // mention paths, and the `Symbol.for("pi-subagents:manager")` registry — and
    // none came through the Agent tool, which is where the UI activity tracker is
    // otherwise created. Without one the widget and FleetView have no tool name
    // and no turn count, so the row reads `thinking…` for the agent's whole life
    // while the header's tool-use count climbs beside it (#181). Double-tracking
    // is not possible: the Agent tool calls `manager.spawn` directly. The tracker
    // callbacks are the funnel's own — a caller's are not honoured, since a
    // half-wired tracker renders worse than none.
    //
    // The turn limit is resolved rather than read off `options`, which a mention
    // spawn deliberately omits so the agent's own config can decide: a tracker
    // built with `undefined` renders `↻3` where the Agent tool renders `↻3≤20`.
    // Like the tool's own, it is a prediction — editing the agent file mid-run
    // leaves the displayed ceiling stale.
    const { state, callbacks } = createActivityTracker(resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns));
    // Repaints are left to the manager's `onStart` callback, which already starts
    // the widget/fleet timers for agents that enter this way.
    const id = manager.spawn(piRef, ctxRef, dispatch.type, prompt, { ...options, ...callbacks });
    agentActivity.set(id, state);
    return id;
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    // Internal too: a forged value would hide an RPC-spawned agent inside
    // someone else's workflow, and take it out of the concurrency pool with it.
    delete safeOptions.workflowId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Worse than rootSessionId: this one names a file to OPEN and replay as a
    // conversation. Only the mention dispatcher may set it, and only from a
    // path this extension itself recorded — never from anything a caller sent.
    delete safeOptions.resumeSessionFile;
    // Bypasses handle allocation, so a forged value would duplicate a live
    // agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
    delete safeOptions.reclaim;
    // Internal to a reopen, like `reclaim`: it seeds an agent's lifetime figures.
    delete safeOptions.carry;
    // A caller's model and thinking level are per-call overrides, which
    // `allowModelOverride` (off by default) refuses on every spawn path: the
    // agent then runs on the parent's current model and level, or its agent
    // file's.
    if (!isModelOverrideAllowed()) {
      delete safeOptions.model;
      delete safeOptions.thinkingLevel;
    }
    // Every spawn through here is DETACHED — the caller gets an id back and
    // awaits nothing. A forged `blocking` would charge it to the foreground
    // pool and could defer it behind a queue whose gate nobody is holding.
    delete safeOptions.blocking;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Ids are tried first, keeping the
   * existing behaviour exact — a handle is only consulted when the string is
   * not an id at all. Only live records: a tombstone has nothing to steer and
   * no result to read. Callers still enforce the nested-ownership rejection.
   */
  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = manager.getRecord(ref);
    // Another session's agent is not this session's to read or steer.
    if (byId) return manager.isVisible(byId) ? byId : undefined;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => {
      const record = manager.getRecord(id);
      return record !== undefined && isTopLevelAgent(record) && manager.isVisible(record) ? record : undefined;
    },
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;
  /** Whether the `@handle` autocomplete wrapper has been stacked on pi's provider. */
  let mentionProviderRegistered = false;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    currentCtx = ctx;
    currentSession = sessionFileOf(ctx);
    // First: everything below works on `manager`, which this may replace.
    adoptParkedAgents();
    manager.setVisibleOwner(currentSession);
    syncProjectTrust(ctx);
    void tidyAgentWorktrees(ctx);
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui as any);
      watchHandoffKey(ctx.ui);
    }
    manager.clearCompleted(true);
    // Agents of this session from before a restart, `/resume`, `/fork` or
    // `/reload`: resumable again, by the model and by `@handle`. The branch,
    // not every entry: a fork keeps only the agents on its own path.
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    manager.restoreTombstones(resumeStatesFromEntries(branch));
    // Results of this session's agents that finished while another session
    // was open, recorded here for delivery now.
    deliverPendingResults(branch);
    // Agents the last end of this session interrupted, named once to the next
    // run so it resumes them rather than starting fresh ones. Not those whose
    // result is about to be delivered, nor any running again (a /reload).
    const pendingIds = new Set(pendingResultsFromEntries(branch).map((r) => r.id));
    interruptedNotice = interruptedAgentsFromEntries(branch).filter((a) => {
      if (pendingIds.has(a.id)) return false;
      const live = manager.getRecord(a.id);
      return !(live && (live.status === "running" || live.status === "queued" || manager.isRunActive(a.id)));
    });
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager: {
          spawn: spawnTopLevel,
          awaitStartup: (id) => manager.awaitStartup(id),
          getRecord: (id) => {
            const record = manager.getRecord(id);
            return record && manager.isVisible(record) ? record : undefined;
          },
          // Unguarded on purpose: the stop handler now runs the top-level check
          // itself off `getRecord`, and reports the refusal instead of the
          // "Agent not found" a false from here used to be read as.
          abort: (id) => manager.abort(id),
          consumeResult: (id) => {
            const record = resolveAgentRef(id);
            // Same guard as get_subagent_result: a running agent has no result
            // to consume, and its notification is still the caller's only
            // signal that it finished.
            if (!record || record.parentAgentId) return false;
            // Includes a stopped agent still winding down: its partial result
            // has not landed yet.
            if (manager.isRunActive(record.id)) return false;
            record.resultConsumed = true;
            outbox.cancel(record.id);
            return true;
          },
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
    // Stack `@handle` suggestions on pi's built-in autocomplete. Registered at
    // most once per activation: pi appends wrappers to a list it never prunes,
    // so a second call would layer a duplicate provider on the first. TUI only
    // — print mode has no such method, and RPC mode's is a no-op.
    if (ctx.mode === "tui" && !mentionProviderRegistered) {
      mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider(current =>
        createMentionProvider(
          current,
          // Plain text, not renderAgentName: the same label FleetView and the
          // widget show, but the autocomplete description cannot carry ANSI.
          () => mentionRoster(manager, mentionTypes(), type => getConfig(type).displayName),
          isAgentMentionsEnabled,
        ),
      );
    }
    // Last, and only here: CLI flag values are applied by the host AFTER every
    // extension factory has run, so this is the earliest point the real value
    // exists. Detached inside — a workflow must not hold up session startup.
    resolveWorkflowCollisions(ctx);
    runWorkflowFlag(ctx);
  });

  /** Agent types `@` can start, in the shape the roster wants. */
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map(name => ({ name, description: getAgentConfig(name)?.description ?? name }));

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model — Claude Code's prompt mention, same grammar (see mention.ts).
   *
   * The handle names the *agent*, not one process, so one syntax covers its
   * whole lifecycle: message it while it runs, resume it once it has finished,
   * start it if it never ran. Everything that isn't an agent mention falls
   * through untouched, which is what keeps `@src/foo.ts summarize this`, a bare
   * `@handle`, and ordinary prose working. A delivered mention costs no
   * main-model turn; the answer arrives through the ordinary completion
   * notification either way.
   */
  pi.on("input", async (event, ctx) => {
    // Never hijack text the extension layer itself submitted (pi.sendMessage,
    // scheduled prompts) — only something a person typed can be a mention.
    if (event.source === "extension" || !isAgentMentionsEnabled()) return { action: "continue" };
    // Claiming the turn is TUI only, matching the `@` completion that teaches
    // the syntax. Pi defaults `session.prompt()` to source "interactive", so a
    // headless `pi -p "@explore …"` reaches here too — and claiming it would
    // answer with silence, which the background hold cannot fix: `handled`
    // returns from prompt() before any turn starts, so the loop that patch wraps
    // never runs (it holds subagents spawned by the Agent tool MID-turn, a
    // different path). The agent would detach, `ctx.ui.notify` is a no-op
    // outside the TUI, and print mode would exit having printed nothing.
    //
    // `model` mode has none of that problem: it queues a reminder and lets the
    // turn run, so the answer is the model's own, printed as usual. It is the
    // only branch allowed to act headlessly; everything else falls through to
    // the main model exactly as it did before mentions existed.
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && getAgentMentionMode() !== "model") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    // `@main` addresses the main conversation, never a subagent — the one name
    // `assignHandle` refuses to allocate. An explicit escape hatch for text
    // that would otherwise read as a mention, so the prefix is dropped and the
    // rest goes to the model with its attachments intact.
    if (isReservedHandle(mention.handle)) {
      return { action: "transform", text: mention.message, ...(event.images && { images: event.images }) };
    }

    // As typed first, so an agent actually called `agent-foo` wins over Claude
    // Code's `@agent-` + `foo` spelling rather than being shadowed by it.
    const alias = stripAgentPrefix(mention.handle);
    const resolved = manager.resolveMention(mention.handle)
      ?? (alias ? manager.resolveMention(alias) : undefined);

    // Steering and resuming are direct in every mode, so headless they are not
    // available at all. Falling through here rather than dropping to the start
    // path below matters: the handle names an agent that already exists, and
    // asking the model to start another one is not what was typed.
    if (resolved && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.alias ?? record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        // Steering interrupts after the current tool call, exactly like the
        // steer_subagent tool. Un-consume the result so the agent's reply to
        // this message is still relayed even if the LLM read its last answer.
        record.resultConsumed = false;
        manager.steer(record.id, mention.message);
        pi.events.emit("subagents:steered", { id: record.id, message: mention.message });
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        // Both derived from the record's OWN type: a mention names an existing
        // agent, so its frontmatter is what governs — `output_transcript: false`
        // must keep holding, since record.outputFile is the sole gate every
        // downstream consumer keys off and a resume must not re-open it.
        // No turn limit here: the resumed run keeps the one its first run had.
        let resumedRecord: AgentRecord | undefined;
        try {
          resumedRecord = await startBackgroundResume(ctx, record.id, mention.message, {
            outputTranscript: resumeWritesTranscript(record.type),
          });
        } catch (err) {
          ctx.ui.notify(`Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`, "warning");
          return { action: "handled" };
        }
        ctx.ui.notify(
          resumedRecord ? `Resuming ${target}` : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
      // A live record with no session never got far enough to continue, so it
      // falls through to the start-fresh path below, like Claude's
      // `no_transcript`.
    }

    // Evicted, but its conversation is still on disk: reopen it — the same
    // path the model's `Agent({ resume })` takes. The reopened record keeps the
    // agent's id and takes back the names the tombstone was holding, and runs
    // with the agent's own model, directory, worktree and isolation.
    if (resolved?.kind === "tombstone") {
      const entry = resolved.entry;
      const target = `@${entry.alias ?? entry.handle}`;

      // Checked here for the specific wording; the manager checks again. A
      // `/new` in another pi window or a manual delete makes the conversation
      // unrecoverable (Claude Code's `not_reachable`), so drop the entry — a
      // row that can only ever fail is worse than none — and say so rather
      // than quietly sending this message to an unrelated agent.
      if (!existsSync(entry.sessionFile)) {
        manager.dropTombstone(entry.id);
        ctx.ui.notify(`Could not resume ${target} — its session is gone.`, "warning");
        return { action: "handled" };
      }
      // The tombstone stays: re-enabling the agent makes the handle work
      // again, which a drop would foreclose.
      if (reopenTypeProblem(entry.type)) {
        ctx.ui.notify(`Could not resume ${target} — the ${entry.type} agent is no longer available.`, "warning");
        return { action: "handled" };
      }

      try {
        // Awaited past startup, so a failure (an unreadable session file, a
        // worktree that cannot be restored) lands in the catch below instead
        // of being announced as a resume. The tombstone stays on failure.
        await startBackgroundResume(ctx, entry.id, mention.message, {
          outputTranscript: resumeWritesTranscript(entry.type),
        });
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return { action: "handled" };
    }

    // No agent under that handle — but the name may still be an agent type, in
    // which case the mention starts one.
    const typeHandle = mention.handle;
    const type = resolveHandleToType(typeHandle, getAvailableTypes())
      ?? (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    // Claude Code never starts the agent itself: `@agent-<type>` becomes an
    // attachment asking the main model to do it, and the model writes the
    // agent's prompt from the conversation rather than forwarding the typed
    // text. That buys a real `Agent` tool call — transcript, per-tool widget
    // detail, tool-use-id correlation, join grouping — and a prompt with the
    // context a cold spawn lacks.
    //
    // It also costs a visible turn, spent narrating a decision the user already
    // made by typing the handle. So the turn is taken by a clone of this
    // conversation instead (mention-clone.ts): same messages, same system
    // prompt, off-screen, holding only the `Agent` tool. Nothing reaches the
    // chat, and what it starts is an ordinary top-level agent.
    if (getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      // "Prompting", not "Starting": in this mode nothing starts until the
      // off-screen clone has taken a whole model turn writing the agent's
      // prompt, and that wait is the one thing the chat cannot show. `direct`
      // says "Started" because by then it has. The distinction tells the user
      // which of the two they are waiting on.
      ctx.ui.notify(`Prompting ${label}…`, "info");
      // Not awaited: the clone runs a full model turn, and prompt() is blocked
      // until this hook returns. The user gets their prompt back immediately
      // and the agent appears in the widget when it starts.
      //
      // The clone can outlive this session (`/new`, `/resume`, `/reload` while
      // it thinks), and then `ctx` and `pi` are stale and throw: everything
      // after it checks the generation, and the chain ends in a catch, since an
      // unhandled rejection ends pi. Shutdown aborts the clone itself.
      const generation = sessionGeneration;
      const live = () => generation === sessionGeneration && !disposed;
      const cloneStop = new AbortController();
      mentionClones.add(cloneStop);
      void runMentionClone({
        ctx,
        type,
        message: mention.message,
        agentTool: registeredAgentTool,
        signal: cloneStop.signal,
        // The clone's turn is real spend on the main model.
        onUsage: (usage) => { if (reportUsage && live()) pendingUsage.add(usage); },
      })
        .then(async (result) => {
          if (!live()) return;
          flushPendingUsageIfIdle();
          if (result.spawned) return;
          // A clone that could not run must not swallow the mention: start the
          // agent the direct way rather than leaving the user with a toast and
          // nothing running.
          try {
            const id = spawnTopLevel(pi, ctx, type, mention.message, {
              description: describeMention(mention.message),
              isBackground: true,
            });
            // Same reason as the direct path below: the agent may still be
            // starting, and a failure there must reach this catch.
            await manager.awaitStartup(id);
            if (live()) ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
          } catch (err) {
            if (live()) {
              ctx.ui.notify(
                `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
            }
          }
        })
        .catch(() => { /* the session went away mid-flight */ })
        .finally(() => { mentionClones.delete(cloneStop); });
      return { action: "handled" };
    }

    try {
      // Nothing else to pass: runAgent resolves model, thinking and max turns
      // from the agent's own config when the spawn omits them, and the
      // manager's onStart/onComplete callbacks own the widget, the fleet list
      // and the completion notification — the same contract the scheduler and
      // cross-extension RPC spawns run under.
      const id = spawnTopLevel(pi, ctx, type, mention.message, {
        description: describeMention(mention.message),
        isBackground: true,
      });
      // The agent may still be starting (a worktree copy is an awaited git
      // call) — report a failure that lands there as a failed start, not as a
      // "Started" toast for an agent that never ran.
      await manager.awaitStartup(id);
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(`Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return { action: "handled" };
  });

  pi.on("session_before_switch", () => {
    // This event can be canceled, or target-session validation can fail after
    // it returns. Pi confirms replacement by emitting session_shutdown; keep
    // the current schedules and agent records intact until then.
  });

  /**
   * Take over the manager the previous session parked at its switch, if it was
   * parked for this session by this same version: its background agents keep
   * running and show here when they are this session's. Another version cannot
   * share the manager's code, so it stops its agents itself, as a quit would.
   * See session-handoff.ts.
   */
  function adoptParkedAgents(): void {
    const parked = takeParkedSubagents(currentSession);
    if (!parked) return;
    if (!isCompatible(parked)) {
      void parked.stop(writeEntry).catch(() => { /* best effort */ });
      return;
    }
    const adopted = parked.manager as AgentManager;
    const fresh = manager;
    // New work runs with this instance's modules (agent registry, settings).
    adopted.useServices(managerServices());
    adopted.setObservers(managerObservers);
    adopted.setMaxConcurrent(fresh.getMaxConcurrent());
    adopted.setMaxConcurrentForeground(fresh.getMaxConcurrentForeground());
    manager = adopted;
    widget.setManager(adopted);
    fleet.setManager(adopted);
    for (const [id, state] of parked.activity) {
      if (!agentActivity.has(id)) agentActivity.set(id, state as AgentActivity);
    }
    void fresh.dispose();
    // Runs that settled between the two instances, handled as if just now —
    // once this start has finished setting up.
    const settled = parked.completed as AgentRecord[];
    if (settled.length > 0) setTimeout(() => { for (const record of settled) onAgentComplete(record); }, 0);
  }

  /**
   * At a session switch: leave the background agents running in a manager
   * parked for the next instance (session-handoff.ts). Nothing parked here
   * may touch this instance's `pi` or ctx, which Pi invalidates next: until
   * adopted, completions are queued in the entry.
   */
  function parkAgents(reason: string, targetSessionFile: string | undefined): void {
    const parkedManager = manager;
    const entry: ParkedSubagents = {
      protocol: HANDOFF_PROTOCOL,
      version: PACKAGE_VERSION,
      reason,
      sessionFile: currentSession,
      targetSessionFile,
      manager: parkedManager,
      activity: new Map(agentActivity),
      completed: [],
      stop: (write) => stopParkedAgents(parkedManager, entry, write),
    };
    parkedManager.setObservers({ onComplete: (record) => { entry.completed.push(record); } });
    parkedManager.detachPendingContexts();
    parkedManager.setVisibleOwner(null);
    parkSubagents(entry, () => recordParkedAgentsAtExit(parkedManager, entry));
  }

  /**
   * Notify this session of its agents that finished while another session was
   * open (`pending` record entries), once, after this start: a turn follows,
   * as for any background completion. Marked delivered at once, so a second
   * start does not repeat it.
   */
  function deliverPendingResults(branch: readonly unknown[]): void {
    const pending = pendingResultsFromEntries(branch);
    if (pending.length === 0) return;
    const ids = pending.map(r => r.id);
    try {
      pi.appendEntry(DELIVERED_ENTRY_TYPE, { ids });
    } catch {
      return;
    }
    // The record still in memory carries more (context, compactions) than its entry.
    const records = pending.map(entry => {
      const live = manager.getRecord(entry.id);
      return live && manager.isVisible(live) ? live : entry;
    });
    // Through the completion outbox, like every other completion: delivered at
    // this session's next boundary (a turn when idle), coalesced with anything
    // else that finished, and cancelled per agent by get_subagent_result.
    // An entry is all there is of an evicted agent's record, so its whole
    // result goes in (up to 20 000 characters), not a preview: its saved
    // session holds the agent's text, but not what the record added to it,
    // such as the note naming its worktree branch.
    const live = (r: AgentRecord) => manager.getRecord(r.id) === r;
    for (const r of records) {
      agentActivity.delete(r.id);
      widget.markFinished(r.id);
      fleet.onAgentFinished(r.id);
    }
    const parts = records.flatMap(r => {
      try {
        const text = live(r)
          ? formatTaskNotification(r, 500, showCost)
          : formatTaskNotification(r, 20_000, showCost, Number.POSITIVE_INFINITY);
        return [{ id: r.id, text, details: buildNotificationDetails(r, 300) }];
      } catch { return []; /* as in sendIndividualNudge */ }
    });
    if (parts.length > 0) {
      outbox.add({
        ids: parts.map(p => p.id),
        build: (unreadIds) => {
          const unread = parts.filter(p => unreadIds.includes(p.id));
          const [first, ...rest] = unread;
          const details = { ...first.details };
          if (rest.length > 0) details.others = rest.map(p => p.details);
          const label = unread.length === 1 ? "An agent" : `${unread.length} agents`;
          return {
            content: `${label} of this session finished while another session was open.\n\n${unread.map(p => p.text).join("\n\n")}`,
            details,
          };
        },
      });
    }
    widget.update();
  }

  // On shutdown: on a session switch, background agents keep running (parked
  // for the next instance); on quit, every agent is stopped and recorded.
  pi.on("session_shutdown", async (event) => {
    // Spend no tool result carried back yet: record it while the session can.
    flushPendingUsage();
    disposed = true;
    interruptedNotice = [];
    sessionGeneration++;
    for (const stop of mentionClones) stop.abort();
    mentionClones.clear();
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle?.unsubConsume();
    rpcHandle = undefined;
    currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    releaseOwner();
    scheduler.stop();
    // Before abortAll, and not folded into it: a workflow owns a worker thread
    // as well as its children, and only its own signal terminates that.
    for (const task of workflowTasks.values()) task.abortController.abort();
    workflowTasks.clear();

    // Runs Pi's shutdown aborted just before this (foreground agents) and the
    // workflow children aborted above are stopped but still winding down: the
    // session's end interrupted them, not the user.
    const cutShort = manager.listAllAgents().filter(r => r.status === "stopped" && r.stopCause === undefined && manager.isRunActive(r.id));
    for (const record of cutShort) record.stopCause = "session-end";

    const live = manager.listAllAgents().filter(r => r.status === "running" || r.status === "queued");
    // Pi says why (Pi >= 1.0): `new`, `resume`, `fork` and `reload` replace the
    // session within this process; `quit` (also /quit and SIGTERM/SIGHUP) or no
    // reason ends it. On a switch, a background agent whose session is on disk
    // keeps running — its results can still be recorded there — along with
    // the agents it owns. Foreground agents (Pi aborted their tool call before
    // this), workflows and agents of a session kept in memory stop as before.
    const { reason, targetSessionFile } = (event ?? {}) as { reason?: unknown; targetSessionFile?: string };
    // The next instance finds the parked manager by the session it starts, so
    // a switch must name it (Pi 1.0 does; `/reload` keeps this one).
    const switching = isSessionSwitch(reason)
      && (reason === "reload" ? currentSession !== undefined : typeof targetSessionFile === "string");
    const kept = new Set(switching
      ? live.filter(r => isTopLevelAgent(r) && r.isBackground !== false && isSessionOnDisk(r.ownerSession)).map(r => r.id)
      : []);
    const rootOf = (record: AgentRecord): string => {
      let current = record;
      for (let parent = current.parentAgentId; parent !== undefined; parent = current.parentAgentId) {
        const next = manager.getRecord(parent);
        if (!next) break;
        current = next;
      }
      return current.id;
    };
    const interrupted = [...cutShort, ...live.filter(r => !kept.has(rootOf(r)))];
    // Also worth keeping: another session's agents that finished while this
    // one was open, so their session shows them in full when it is reopened.
    const carried = switching && manager.listAllAgents().some(r =>
      isTopLevelAgent(r) && !ownedHere(r) && !r.resultConsumed && !manager.isRunActive(r.id) && isSessionOnDisk(r.ownerSession));
    const parking = kept.size > 0 || carried;
    if (kept.size > 0) {
      for (const record of interrupted) manager.abort(record.id, "session-end");
    } else {
      manager.abortAll("session-end");
    }
    // A stopped worktree agent still commits its changes to a branch while it
    // settles; dispose() does not wait for that, and the process may exit next.
    await manager.awaitWorktreeCleanup(15_000, kept.size > 0 ? new Set(interrupted.map(r => r.id)) : undefined);
    // Each recorded as stopped and resumable, in the session it belongs to.
    for (const record of interrupted) {
      if (isTopLevelAgent(record)) appendRecordEntry(record);
      else appendResumeEntry(record);
    }
    if (parking) parkAgents(reason as string, targetSessionFile);

    // Completions still waiting for this session's next boundary (a busy or
    // interrupted parent): marked pending in the session they belong to, so
    // its next start (a switch back, a restart) delivers them like any result
    // that landed while another session was open.
    for (const id of outbox.pendingIds()) {
      const record = manager.getRecord(id);
      if (record && isTopLevelAgent(record) && !record.resultConsumed && !manager.isRunActive(id)) appendRecordEntry(record, true);
    }
    // Neither may fire into a torn-down instance (or hold `pi -p` open).
    outbox.dispose();
    groupJoin.dispose();
    turnGroupSpawns = [];
    fleet.dispose();
    unsubHandoffKey?.();
    unsubHandoffKey = undefined;
    handoffKeyUi = undefined;
    foregroundHandoffs.clear();
    // Its 80 ms refresh interval otherwise outlives the session across /reload.
    // The interval is cleared first; the UI calls after it may meet a context
    // that is already gone.
    try { widget.dispose(); } catch { /* stale UI context at shutdown */ }
    refreshTicker.clear();
    // A parked manager lives on, with its agents' sessions.
    if (parking) return;
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await manager.dispose(pi);
  });

  // Live widget: show running agents above editor.
  // widgetMode (default "background") selects what the widget shows: "all" =
  // every agent; "background" = hide foreground (they already render inline as
  // the Agent tool result, so showing them here too is a duplicate, #118), keep
  // everything else; "off" = hide the widget entirely. Read live at render time.
  let widgetMode: WidgetMode = "background";
  function getWidgetMode(): WidgetMode { return widgetMode; }
  // One clock for the widget, the fleet list and the inline foreground
  // spinners, so their redraws share a frame.
  const refreshTicker = new RefreshTicker();
  const widget = new AgentWidget(manager, agentActivity, getWidgetMode, isShowCostEnabled, isShowModelEnabled, refreshTicker);
  function setWidgetMode(m: WidgetMode): void { widgetMode = m; widget.update(); }

  /**
   * Foreground `Agent` calls whose run can be handed to the background, by
   * agent id. Each entry wakes its blocked tool call, which then returns as a
   * background spawn would. Only the Agent tool registers here, so a spawn with
   * no tool call to return — the agent generator, a workflow's agents, nested
   * children — never offers the handoff.
   */
  const foregroundHandoffs = new Map<string, () => void>();

  /** Hand these runs to the background and wake their tool calls; returns how many took. */
  function sendForegroundToBackground(ids: Iterable<string>): number {
    let sent = 0;
    for (const id of [...ids]) {
      const wake = foregroundHandoffs.get(id);
      if (!wake || !manager.sendToBackground(id)) continue;
      foregroundHandoffs.delete(id);
      wake();
      sent++;
      // It is a background agent from here on, so announce it as one — as a
      // detached resume re-announces an existing id.
      const record = manager.getRecord(id);
      if (record) {
        pi.events.emit("subagents:created", {
          id,
          type: record.type,
          description: record.description,
          isBackground: true,
        });
      }
    }
    if (sent > 0) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    return sent;
  }

  /** The conversation viewer's `b`: hand just this run to the background. */
  function backgroundActionFor(record: AgentRecord, notify: (message: string) => void): ViewerBackgroundAction {
    return {
      // Registered while the run is live, removed the moment its call returns.
      available: () => foregroundHandoffs.has(record.id),
      send: () => {
        if (sendForegroundToBackground([record.id]) > 0) notify(`Sent "${record.description}" to the background.`);
      },
    };
  }

  // Claude Code's ctrl+b (`task:background`), configurable as `backgroundKey`:
  // hand every running foreground `Agent` call to the background. Claimed only
  // while one is pending and the prompt editor has focus, so the rest of the
  // time the key keeps its editor meaning (ctrl+b is pi's cursor-left).
  let handoffKeyUi: ExtensionContext["ui"] | undefined;
  let unsubHandoffKey: (() => void) | undefined;
  function watchHandoffKey(ui: ExtensionContext["ui"]): void {
    if (ui === handoffKeyUi) return;
    unsubHandoffKey?.();
    handoffKeyUi = ui;
    unsubHandoffKey = ui.onTerminalInput(data => {
      // Cheapest checks first: this listener sees every key the user types.
      if (foregroundHandoffs.size === 0) return undefined;
      const key = getBackgroundKey();
      // Kitty reports a release too, and matchesKey matches it — act on the
      // press only, or a refused handoff would be retried by its own release.
      if (key === undefined || isKeyRelease(data) || !matchesKey(data, key as KeyId)) return undefined;
      // Listeners run before the focused component, so a dialog or the
      // viewer's composer would lose the key. The viewer has its own `b`.
      if (!fleet.editorHasFocus()) return undefined;
      const sent = sendForegroundToBackground(foregroundHandoffs.keys());
      if (sent > 0) ui.notify(`Sent ${sent === 1 ? "1 agent" : `${sent} agents`} to the background.`, "info");
      return { consume: true };
    });
  }

  /**
   * Pi's fullscreen scrollbar preference, read from the main session's live,
   * trust-aware settings and normalized as Pi's own `getFullscreenScrollbar()` does.
   */
  function getFullscreenScrollbar(): ScrollViewScrollbar {
    try {
      const mode = pi.getSettings().fullscreenScrollbar;
      return mode === "always" || mode === "hidden" ? mode : "auto";
    } catch {
      return "auto";
    }
  }

  /**
   * Pi's chat settings the conversation viewer draws with, read from the main
   * session's live settings and normalized as Pi's SettingsManager getters do,
   * so a subagent's transcript looks like the main one.
   */
  function getViewerRenderOptions(): ViewerRenderOptions {
    try {
      const settings = pi.getSettings();
      return {
        hideThinkingBlock: settings.hideThinkingBlock ?? false,
        outputPad: settings.outputPad === 0 ? 0 : 1,
        codeBlockIndent: settings.markdown?.codeBlockIndent ?? "  ",
      };
    } catch {
      return {};
    }
  }

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  // The render options keep a conversation overlay opened here identical to one
  // opened from `/agents`.
  const fleet = new FleetList(manager, agentActivity, isShowCostEnabled, getViewerRenderOptions, refreshTicker,
    backgroundActionFor, getFullscreenScrollbar);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean { return fleetViewEnabled; }
  function setFleetViewEnabled(b: boolean): void { fleetViewEnabled = b; fleet.setEnabled(b); }

  // Claude Code-style `@handle message` prompt mentions. Read live by both the
  // `input` hook and the stacked autocomplete provider, so the toggle applies
  // immediately — the provider itself can never be unregistered (pi's wrapper
  // list is append-only), it just delegates everything when this is off.
  let agentMentionMode: AgentMentionMode = "model";
  function getAgentMentionMode(): AgentMentionMode { return agentMentionMode; }
  function setAgentMentionMode(mode: AgentMentionMode): void { agentMentionMode = mode; }
  // `model` and `direct` differ only in who starts a not-yet-running agent, so
  // everything that just asks "are mentions live at all" — the suggestion list,
  // the steer and resume branches — reads this instead of the mode.
  function isAgentMentionsEnabled(): boolean { return agentMentionMode !== "off"; }

  // Project/global default for writing the subagent .output transcript lives in
  // output-file.ts (both spawn paths read it). A custom agent's
  // `output_transcript` frontmatter overrides it per spawn; when the frontmatter
  // is silent, this default applies. Read live at spawn time.

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // What an unqualified top-level spawn means. Defaults to background,
  // following Claude Code; `backgroundByDefault: false` restores the previous
  // foreground default. Nested spawns ignore this — see nested-tools.ts.
  let backgroundByDefault = true;
  function getBackgroundByDefault(): boolean { return backgroundByDefault; }
  function setBackgroundByDefault(b: boolean) { backgroundByDefault = b; }

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean { return schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { schedulingEnabled = b; }

  // Master switch for scripted workflows. Defaults to ON. Off means the
  // `SubagentWorkflow` tool is never registered: the model is not told the
  // feature exists (zero context cost) and has nothing to call. The
  // `/agents → Workflows` view and `--subagents-workflow-file` are refused too, so
  // there is no second door into the same machinery.
  //
  // `workflowsPinned` records that the answer came from the user — a boolean in
  // subagents.json, or the settings toggle — rather than from this default. It
  // is what `resolveWorkflowCollisions` checks before yielding to another
  // extension's workflow tool: a default may be overridden by what else is
  // loaded, an explicit choice may not.
  let workflowsEnabled = true;
  let workflowsPinned = false;
  function isWorkflowsEnabled(): boolean { return workflowsEnabled; }
  function isWorkflowsPinned(): boolean { return workflowsPinned; }
  function setWorkflowsEnabled(b: boolean) {
    workflowsEnabled = b;
    workflowsPinned = true;
  }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // ---- Turn batches for `group` join mode ----
  // Background spawns the parent made in its current turn. The turn's end is
  // the batch boundary: every `Agent` call of the batch has returned by then,
  // so a spawn whose startup failed has already thrown and was never recorded,
  // and a slow worktree copy cannot split the batch.
  let turnGroupSpawns: string[] = [];
  let turnGroupCounter = 0;

  /** Record a `group`-mode spawn made inside a parent turn. */
  function joinTurnGroup(id: string, joinMode: JoinMode | undefined) {
    // Outside a parent turn (an `@handle` mention) no turn end is coming, and a
    // group of one is delivered exactly like a single completion.
    if (joinMode === 'group' && parentTurnActive()) turnGroupSpawns.push(id);
  }

  /** Register the ending turn's `group` spawns, two or more, as one group. */
  function registerTurnGroup() {
    const ids = turnGroupSpawns;
    turnGroupSpawns = [];
    // One spawn is no group: it reports like any single completion.
    if (ids.length < 2) {
      const record = ids.length === 1 ? manager.getRecord(ids[0]) : undefined;
      if (record?.completedAt != null && !record.resultConsumed) sendIndividualNudge(record);
      return;
    }
    const groupId = `turn-${++turnGroupCounter}`;
    groupJoin.registerGroup(groupId, ids);
    // Members that finished before their turn ended had their completion
    // deferred (see the manager's onComplete); feed them in now.
    for (const id of ids) {
      const record = manager.getRecord(id);
      if (!record) continue;
      record.groupId = groupId;
      if (record.completedAt != null && !record.resultConsumed) {
        groupJoin.onAgentComplete(record);
      }
    }
  }

  /**
   * Refuse to reopen an evicted agent under a substitute: the Agent tool falls
   * back to general-purpose for a type it cannot resolve (#183), which covers a
   * deleted file AND a merely disabled one. Reopening the conversation under
   * another agent's prompt and tools is not continuing it.
   */
  function reopenTypeProblem(type: string): string | undefined {
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    return !dispatch.ok || dispatch.fellBackFrom !== undefined
      ? `the ${type} agent is no longer available.`
      : undefined;
  }

  /** Whether a resumed agent writes its `.output` transcript: its OWN type decides. */
  function resumeWritesTranscript(type: string): boolean {
    return getAgentConfig(type)?.outputTranscript ?? getOutputTranscriptDefault();
  }

  /**
   * The per-run wiring every resume needs, live or reopened: the transcript
   * (appended to, never truncated) and the activity tracker's session.
   *
   * `onRecord` runs before the run starts; `onStarted` once the session exists
   * and before the prompt is sent, so the stream is anchored past the turns
   * already on disk and the resumed prompt is written exactly once.
   */
  function resumeWiring(
    ctx: ExtensionContext,
    id: string,
    opts: { outputTranscript: boolean; toolCallId?: string; joinMode?: JoinMode },
    state: AgentActivity,
  ): { onRecord: (rec: AgentRecord) => void; onStarted: () => void } {
    return {
      onRecord: (rec) => {
        // Assigned unconditionally: the completion notification carries this as
        // `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR
        // the id left by the spawn that created the record. Keeping it would
        // point the orchestrator's new result at a tool call answered runs ago.
        rec.toolCallId = opts.toolCallId;
        if (opts.joinMode) rec.joinMode = opts.joinMode;
        // Reuse the agent's transcript rather than starting a fresh one: the
        // path is deterministic per agent+session, so writing an initial entry
        // would truncate the previous run's turns (see ensureOutputFile).
        if (opts.outputTranscript) {
          rec.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
          ensureOutputFile(rec.outputFile);
        }
      },
      // Fires when the run actually starts — immediately, on queue drain, or
      // once a reopened session exists. A resume stopped while still queued
      // never started streaming, so no subscription is left behind.
      onStarted: () => {
        const rec = manager.getRecord(id);
        state.session = rec?.session;
        if (rec?.session && rec.outputFile) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, rec.session.messages.length);
        }
      },
    };
  }

  /**
   * Launch a detached resume of an agent — live, or evicted and reopened from
   * its session file — and wire everything a re-running agent needs:
   * transcript anchoring, activity tracking, join-mode batching, the
   * widget/fleet refresh, and the `subagents:created` event.
   *
   * Shared by the Agent tool's `resume` + `run_in_background` branch and the
   * `@handle message` prompt mention — they differ only in how they report the
   * outcome. Returns the record, or undefined when the manager refused because
   * the agent is still running (see AgentManager.resume). Throws, with the
   * reason, when the agent cannot be resumed.
   */
  async function startBackgroundResume(
    ctx: ExtensionContext,
    id: string,
    prompt: string,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ): Promise<AgentRecord | undefined> {
    const joinMode = resolveJoinMode(defaultJoinMode, true);
    const known = manager.getRecord(id) ?? manager.findTombstone(id);
    // `opts.maxTurns` is an explicit override; without one the resumed run
    // enforces the limit the agent's first run had.
    const knownMaxTurns = known?.maxTurns === 0 ? undefined : known?.maxTurns;
    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns ?? knownMaxTurns);
    const wiring = resumeWiring(ctx, id, { ...opts, joinMode }, bgState);

    // No `signal`: a background spawn deliberately omits it, and a detached
    // resume must behave the same. Passing it would abort this agent when
    // the parent turn is interrupted (user Esc), while agents started with
    // run_in_background in that same turn keep going.
    const record = await manager.resume(id, prompt, undefined, {
      isBackground: true,
      pi,
      ctx,
      checkType: reopenTypeProblem,
      maxTurns: opts.maxTurns,
      onToolActivity: bgCallbacks.onToolActivity,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
      onTurnEnd: bgCallbacks.onTurnEnd,
      ...wiring,
    });
    if (!record) return undefined;

    // Only a resume from an Agent call belongs to that call's turn.
    if (opts.toolCallId !== undefined) joinTurnGroup(id, joinMode);

    agentActivity.set(id, bgState);
    // This agent already finished once, so the widget holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    widget.markRunning(id);
    widget.ensureTimer();
    widget.update();
    fleet.ensureTimer();
    fleet.update();

    // Resume ignores subagent_type (the record keeps the type it was
    // spawned with), so report the record's own identity — a "created"
    // event carrying the caller's type would re-register the agent under
    // the wrong one in cross-extension mirrors keyed by id.
    pi.events.emit("subagents:created", {
      id,
      type: record.type,
      description: record.description,
      isBackground: true,
    });

    return record;
  }

  // The main agent's `bash` calls get the tool timeout too, but only when they
  // set none: the user is there to ask for a longer one. Pi's bash has no default,
  // so an unbounded `grep -r … /` or a server started in the foreground would
  // otherwise hold the turn until someone notices. (Subagents are also capped —
  // see installToolTimeouts in agent-runner.ts.)
  const codemodeAudit = createCodemodeAudit();
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "bash") boundBashTimeout(event.input, getToolTimeoutSeconds(), false);
    // Pi's codemode scripts have no deadline unless they set one; give those that don't
    // `codemodeTimeoutSeconds` (default 30 minutes). A deadline the script sets is kept.
    if (event.toolName === CODEMODE_TOOL_NAME) boundCodemodeTimeout(event.input, getCodemodeTimeoutSeconds());
    codemodeAudit.recordCall(event, ctx);
    return undefined;
  });
  // Keeps the raw output of every call a codemode script makes; see codemode-guard.ts.
  pi.on("tool_result", (event) => codemodeAudit.onToolResult(event));

  // The first run after a restart learns, once, which agents the session's end
  // interrupted, so it resumes them instead of launching fresh ones.
  pi.on("before_agent_start", () => {
    const agents = interruptedNotice;
    interruptedNotice = [];
    if (disposed || agents.length === 0) return;
    try {
      pi.appendEntry(INTERRUPTED_NOTICE_ENTRY_TYPE, { ids: agents.map((a) => a.id) });
    } catch {
      return;
    }
    return {
      message: {
        customType: "subagents-interrupted",
        content: formatInterruptedNotice(agents),
        display: true,
        details: { ids: agents.map((a) => a.id) },
      },
    };
  });

  // The parent's turn is over: spend that arrived after its last subagent tool
  // result (background agents, workflows) reaches the session stats now.
  pi.on("agent_end", (_event, ctx) => {
    flushPendingUsage(ctx);
    outbox.onAgentEnd();
  });
  pi.on("agent_settled", () => outbox.onAgentEnd());

  // The parent's tool batch is done and its next model call not yet made: the
  // boundary where completions are delivered, as in Claude Code.
  pi.on("turn_end", (event) => {
    registerTurnGroup();
    outbox.onTurnEnd(event.message.role === "assistant" ? event.message.stopReason : undefined);
  });

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    watchHandoffKey(ctx.ui);
    widget.onTurnStart();
  });

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () => {
    const available = getAvailableTypes();

    return available.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}${overrideSuffix(name, cfg)}`;
    }).join("\n");
  };

  /** Marks a project agent file that took over a built-in type, so the swap is visible where types are listed. */
  const overrideSuffix = (name: string, cfg: AgentConfig | undefined): string =>
    cfg?.source === "project" && DEFAULT_AGENTS.has(name) ? " (defined by this project, replacing the built-in)" : "";

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})${overrideSuffix(name, cfg)}`;
    }).join("\n");

  /** Derive a short model label from a model string. */
  function getModelLabelFromConfig(model: string): string {
    // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
    const name = model.includes("/") ? model.split("/").pop()! : model;
    // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
    return name.replace(/-\d{8}$/, "");
  }

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  const settingsAppliers: SettingsAppliers = {
    setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
    setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n),
    setDefaultMaxTurns,
    setGraceTurns,
    setToolTimeoutSeconds,
    setCodemodeTimeoutSeconds,
    setDefaultJoinMode,
    setBackgroundByDefault,
    setSchedulingEnabled,
    setScopeModels: setScopeModelsEnabled,
    setAllowModelOverride: setModelOverrideAllowed,
    setStrictAgentFiles: (b) => { strictAgentFiles = b; },
    setDisableDefaultAgents: setDisableDefaultAgents,
    setToolDescriptionMode: setToolDescriptionMode,
    setFleetView: setFleetViewEnabled,
    setAgentMentions: setAgentMentionMode,
    setRememberAgents,
    setWidgetMode: setWidgetMode,
    setOutputTranscript: setOutputTranscriptDefault,
    setWorktreeIsolation: setWorktreeIsolationEnabled,
    setWorkflowsEnabled: setWorkflowsEnabled,
    setMaxSubagentDepth: setMaxSubagentDepth,
    setFallbackSubagent: setFallbackSubagent,
    setReportUsage,
    setShowCost,
    setShowModel,
    setBackgroundKey,
    setWatchdogExemptTools,
  };
  applyAndEmitLoaded(settingsAppliers, (event, payload) => pi.events.emit(event, payload), process.cwd(), projectTrusted);

  /**
   * Salvage or report agent worktrees an interrupted run left behind, and drop
   * old merged `pi-agent-*` branches (see worktree.ts). Detached and silent on
   * failure: housekeeping must never delay or break a session start.
   */
  async function tidyAgentWorktrees(ctx: ExtensionContext): Promise<void> {
    try {
      const lines = await recoverLeftoverWorktrees(pi, ctx.cwd);
      const pruned = await pruneMergedAgentBranches(pi, ctx.cwd);
      if (pruned.length > 0) {
        lines.push(`Deleted ${pruned.length} merged pi-agent branch${pruned.length === 1 ? "" : "es"} older than ${MERGED_BRANCH_MAX_AGE_DAYS} days: ${pruned.join(", ")}.`);
      }
      if (lines.length === 0 || currentCtx !== ctx) return;
      const message = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(`[pi-subagents] ${message}`);
    } catch { /* housekeeping only */ }
  }

  /**
   * Replace the startup prediction with the session's real trust decision.
   * A folder the user trusted at Pi's prompt gets its project agents and
   * settings now; one Pi reports untrusted loses its project agents, and
   * settings already applied from it stay until the next session.
   */
  function syncProjectTrust(ctx: ExtensionContext): void {
    const trusted = isProjectTrustedBy(ctx);
    if (trusted === projectTrusted) return;
    projectTrusted = trusted;
    if (trusted) applySettings(loadSettings(process.cwd()), settingsAppliers);
    reloadCustomAgents();
    if (!trusted && existsSync(join(process.cwd(), ".pi", "subagents.json"))) {
      const message = "pi-subagents applied this project's .pi/subagents.json before Pi reported the folder as untrusted. " +
        "Restart pi to drop those settings.";
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(`[pi-subagents] ${message}`);
    }
  }

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h", at least 1m), one-shot ("+10m" or ISO). ' +
          'Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    isSchedulingEnabled() ? scheduleParamShape : {};

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Same trade as scheduleParam/scheduleGuideline above: `isolationParam` drops
  // the field from the schema when the project set `worktreeIsolation: false`,
  // so the prose has to go with it. Left in, it would teach the model to pass a
  // parameter that isn't declared — accepted (TypeBox sets no
  // `additionalProperties: false`) and then silently dropped by the resolver.
  // With no per-result note by design, the model would have every reason to go
  // on reporting a `pi-agent-*` branch that was never created.
  const isolationGuideline = isWorktreeIsolationEnabled()
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.`
    : "";

  // Same trade again, for `allowModelOverride`: with overrides off the `model`
  // and `thinking` parameters are not in the schema, so the prose that teaches
  // them goes too — a model told it may pick a model will keep trying.
  const modelOverrideAllowed = isModelOverrideAllowed();
  const modelGuideline = modelOverrideAllowed
    ? `- Use model to specify a different model (as "provider/modelId", or a short name such as "haiku"; the parent's provider is preferred, and a name matching models of several other providers is refused).\n- Use thinking to control extended thinking level.\n`
    : "";
  const modelParamShape = {
    model: Type.Optional(
      Type.String({
        description:
          'Optional model override. Accepts "provider/modelId", or a short name (e.g. "haiku"); the parent\'s provider is preferred, and a name matching models of several other providers is refused. Omit to use the agent type\'s default.',
      }),
    ),
    thinking: Type.Optional(
      Type.String({
        description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
      }),
    ),
  };
  const modelParams: Partial<typeof modelParamShape> = modelOverrideAllowed ? modelParamShape : {};

  const isolationCompactGuideline = isWorktreeIsolationEnabled()
    ? `\n- isolation: "worktree" gives the agent its own git worktree (removed on completion); changes land on a branch named in the result.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls — they run concurrently.
- Subagents run in the background by default; you'll be notified when one completes. Pass run_in_background: false only when your very next action depends on the result and nothing else could usefully happen while it runs. Never fabricate or predict a pending agent's results — if the user asks before the notification arrives, say it's still running.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently. If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Agents run in the background by default. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Pass \`run_in_background: false\` only when your very next action depends on the agent's result and nothing else could usefully happen while it runs — e.g., a research agent whose finding gates the edit you're about to make. Otherwise let it run in the background (the default) — this includes fire-and-forget work, independent investigations, and anything where the user might hand you something else in the meantime. Wanting the result "next" is not enough on its own.
- **Don't race**: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format — not as prose, summary, or structured output. The completion notification arrives in a later turn; it is never something you write yourself. If the user asks before it lands, say the agent is still running — give status, not a guess.
- Use resume with an agent ID to continue a previous agent's work. An agent that stopped or failed (a provider error, a restart of your own session) keeps its whole context: resume it rather than starting a fresh one, which would redo its work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
${modelGuideline}- Use inherit_context if the agent needs the parent conversation history.${isolationGuideline}${scheduleGuideline}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
      scheduleGuideline: () => scheduleGuideline,
      modelGuideline: () => modelGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      ...(projectTrusted ? [join(process.cwd(), ".pi", "agent-tool-description.md")] : []),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  // Held rather than registered inline: the mention clone reuses this exact
  // definition, so the agent it starts is an ordinary top-level spawn instead
  // of a second implementation that has to be kept in step with this one.
  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
        }),
      ),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      ...modelParams,
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from (the `Agent ID:` of an earlier result). Continues from previous context, with the agent's own model, working directory and worktree. Finished, stopped and failed agents stay resumable, with their context, as long as their saved session exists, also after a restart of your session. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools, skills or nested agents — only built-in tools. It still inherits the environment variables, model access, Pi settings and, for append-mode agents, the parent's system prompt; it is not a sandbox.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
      ...scheduleParam,
    }),
    // Weak models' malformed arguments, repaired before validation (tool-args.ts).
    prepareArguments: argumentRepair(AGENT_ARG_SHAPE),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme, context) {
      // A badge closes its own background, which would clear the tool block's row tint
      // for the rest of the line, so the badge restores it. The tint is opened here too:
      // the TUI's Box paints it, but HTML export takes it from CSS, and restoring a
      // background the line never opened is what banded the export before. The line is
      // deliberately left open — Box.applyBackgroundToLine pads to width and *then*
      // wraps, so closing here would leave that padding untinted, and HTML export closes
      // any open span per line anyway. No badge means no tint, so an uncolored agent
      // renders exactly the line it always did.
      const rowBackground = hasAgentBadge(args.subagent_type)
        ? theme.getBgAnsi(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg")
        : "";
      const desc = args.description ?? "";
      const name = renderAgentName(args.subagent_type, theme, {
        fallbackColor: "toolTitle",
        restoreBackground: rowBackground,
        bold: true,
      });
      return new Text(rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      const details = result.details as AgentDetails | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      // Pi reports pre-execution failures (extension block, abort, argument
      // validation) as `{ content: [reason], details: {} }` with isError set —
      // no status to render, so show the reason instead of inventing one (#199).
      // A failed run is an error result too, but one of ours: it carries the
      // agent's id and keeps its status line.
      if (!details?.status || (renderContext.isError && details.agentId === undefined)) {
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        if (showCost) {
          const costText = formatCost(d.cost ?? 0);
          if (costText) parts.push(costText);
        }
        return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        const status = renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
        // Claude Code's hint, after the same 2s: a call that finishes quickly
        // never flashes it.
        const backgroundKey = getBackgroundKey();
        if (details.backgroundHint && backgroundKey && details.durationMs >= BACKGROUND_HINT_DELAY_MS) {
          status.addChild(new Text(theme.fg("dim", `     (${backgroundKey} to run in background)`), 0, 0));
        }
        return status;
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // Anything left ("queued", or a status added later) has no rendering of
      // its own — the turn-limit wording below must not be the catch-all.
      if (details.status !== "error" && details.status !== "aborted") {
        return new Text(text, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      // Single decision point for dispatch (#183): unknown, disabled and
      // case-ambiguous types are refused here, BEFORE anything spawns, so a
      // background or scheduled call can't start running the wrong agent while
      // the caller is still unaware. `fallbackSubagent` decides whether an
      // unresolvable type falls back or fails closed.
      const dispatch = resolveSpawnType(rawType);
      // `resume` replays a stored session and ignores `subagent_type` entirely,
      // but the parameter is required by the schema — so gating it here would
      // make a live agent unresumable the moment its type is deleted, disabled,
      // or gains a case-clashing sibling. Only a real spawn is gated.
      if (!dispatch.ok && !params.resume) return errorResult(dispatch.message);
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      // What the caller actually asked for, named once: `fellBackFrom` is "" for
      // a blank request, so reading it inline invites the `??`-vs-`||` slip that
      // once persisted an empty type into a scheduled job.
      const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
      // Computed at resolution rather than after the run, so the background and
      // schedule branches carry it too — previously it existed only on the
      // foreground path. Resume deliberately doesn't: it replays the stored
      // session and ignores `subagent_type` entirely, so a note about type
      // substitution would be describing something that didn't happen.
      // A blank type is what a call without one is repaired to (tool-args.ts).
      const fallbackNote = dispatch.ok && dispatch.fellBackFrom !== undefined
        ? `Note: ${dispatch.fellBackFrom ? `Unknown agent type "${dispatch.fellBackFrom}"` : "No agent type given"} — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
        : "";

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: getBackgroundByDefault(),
      });

      // Resolve model from agent config first; tool-call params only fill gaps.
      // A model the caller named and that does not resolve (missing, or
      // ambiguous) is the caller's error. One the agent file names falls back
      // to the parent's, and the result says so: never a silent substitution.
      let model = ctx.model;
      let modelNote: string | undefined;
      if (resolvedConfig.modelInput) {
        const resolution = resolveModelDetailed(resolvedConfig.modelInput, ctx.modelRegistry, ctx.model?.provider);
        if (resolution.ok) {
          model = resolution.model;
        } else if (resolvedConfig.modelFromParams) {
          return errorResult(resolution.message);
        } else {
          modelNote = unresolvedModelNote(resolvedConfig.modelInput, unresolvedReason(resolution), model ?? "the parent's model");
        }
      }
      // What every result of this spawn leads with.
      const spawnNotes = fallbackNote + (modelNote ? `${modelNote}\n\n` : "");

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
      // in model-scope.ts so the nested delegation tools apply the same rule.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.modelFromParams,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return errorResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its .output transcript. Per-agent
      // frontmatter (`output_transcript`) wins; otherwise the project/global
      // default applies. `attachTranscript` below is the SOLE gate — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      // Unconditional, not "only when it differs from the parent": a thinking
      // level reads as a property of a model, and an agent that inherited the
      // parent's model used to show the level with nothing to attach it to.
      // This is the pre-session snapshot — agent-manager overwrites it with the
      // effective values the moment a session reports them.
      const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
      // What the caller SPELLED, kept only if it names a different model than the
      // one that won. Model input is fuzzy — `"haiku"` and
      // `"anthropic/claude-haiku-4-5"` are the same model — so comparing the two
      // strings would disclose an override that never happened. A spelling that
      // resolves to nothing is still worth disclosing: it cannot have taken effect.
      const askedModel = ((asked: string | undefined) => {
        if (!asked) return undefined;
        const resolvedAsked = resolveModel(asked, ctx.modelRegistry, ctx.model?.provider);
        if (typeof resolvedAsked === "string") return asked;
        return resolvedAsked.provider === model?.provider && resolvedAsked.id === model?.id ? undefined : asked;
      })(resolvedConfig.overridden?.model);
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        modelId,
        thinking,
        // Only set where the agent file outranked the caller, so the surfaces can
        // disclose a parameter that was accepted but could not take effect (#182).
        requestedThinking: resolvedConfig.overridden?.thinking,
        requestedModel: askedModel,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
        isolation,
      };
      // Tool-result render shows the mode label too; viewer's header already does.
      const modeLabel = getPromptModeLabel(subagentType);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      /**
       * `detailBase` for a record that exists, which outranks it: the base is a
       * snapshot of what this call REQUESTED, and pi may have resolved a
       * different model or clamped the thinking level (agent-manager writes the
       * effective values back when the session reports them). Resume goes
       * further and ignores the model/thinking parameters outright — it runs on
       * the session it is reopening — so rendering the base there advertises
       * settings the run never used.
       *
       * The mode label is rebuilt rather than carried over: it hangs off the
       * agent TYPE, not the invocation, so tags taken straight from
       * buildInvocationTags would silently drop `twin`.
       */
      const detailBaseFor = (rec: AgentRecord | undefined): typeof detailBase => {
        if (!rec?.invocation) return detailBase;
        const type = rec.type;
        const { modelName: recModelName, tags } = buildInvocationTags(rec.invocation);
        const recModeLabel = getPromptModeLabel(type);
        const recTags = recModeLabel ? [recModeLabel, ...tags] : tags;
        return {
          displayName: getDisplayName(type),
          description: rec.description,
          subagentType: type,
          modelName: recModelName,
          tags: recTags.length > 0 ? recTags : undefined,
        };
      };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!isSchedulingEnabled()) {
          return errorResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return errorResult("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return errorResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (params.run_in_background === false) {
          return errorResult("Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.");
        }
        if (!scheduler.isActive()) {
          return errorResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            // The caller's own name, not the substitute — the scheduler re-resolves
            // at fire time, and the original is what a user edits.
            subagent_type: requestedType,
            prompt: params.prompt as string,
            // Only when overrides are on: a job keeps the call's model choice
            // for every later fire, which is exactly what the setting refuses.
            model: isModelOverrideAllowed() ? (params as { model?: string }).model : undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
          });
          const next = scheduler.getNextRun(job.id);
          return textResult(
            `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      }

      // Resume existing agent
      if (params.resume) {
        // Only an explicit `max_turns` overrides the limit the agent's first
        // run had; the type's config default must not replace it.
        const resumeMaxTurns = params.max_turns != null ? normalizeMaxTurns(params.max_turns) : undefined;
        // An id, or a handle as the user types it. A live record first; then
        // an evicted top-level agent, reopened from its session file.
        const live = resolveAgentRef(params.resume);
        const resolved = live ? undefined : manager.resolveMention(params.resume);
        const evicted = resolved?.kind === "tombstone" ? resolved.entry : undefined;
        const target = live && isTopLevelAgent(live) ? live : evicted;
        if (!target) {
          return errorResult(
            `Agent not found: "${params.resume}". Agents stay resumable while their session file exists ` +
            `(subagent sessions are saved unless rememberAgents is off); this one is unknown or was never saved.`,
          );
        }
        const id = target.id;
        if (live && !live.session) {
          return errorResult(`Agent "${params.resume}" has no session to resume — it never got far enough to start one.`);
        }
        // A detached resume hands control back while the record stays
        // "running", so nothing stops the model from resuming the same agent
        // again mid-run. manager.resume() refuses that; say why here, where the
        // model can act on it, instead of letting it read as a generic failure.
        if (live && (live.status === "running" || live.status === "queued")) {
          return errorResult(
            `Agent "${params.resume}" is still ${live.status} — it can only be resumed once its current run finishes.\n` +
            `Use steer_subagent to send it a message mid-run. A completion notification arrives on its own when the run finishes.`,
          );
        }
        const resumeTranscript = resumeWritesTranscript(target.type);

        // Background resume: detached run that notifies on completion, mirroring
        // a background spawn.
        if (runInBackground) {
          let record: AgentRecord | undefined;
          try {
            record = await startBackgroundResume(ctx, id, params.prompt, {
              outputTranscript: resumeTranscript,
              maxTurns: resumeMaxTurns,
              toolCallId,
            });
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
          if (!record) {
            return errorResult(`Agent "${params.resume}" is still running — it can only be resumed once its current run finishes.`);
          }

          const isQueued = record.status === "queued";
          return textResult(
            `Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
            `Agent ID: ${id}\n` +
            `Type: ${record.type}\n` +
            (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
            (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
            `\n${BACKGROUND_FOLLOW_UP}`,
            { ...detailBaseFor(record), toolUses: record.toolUses, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
          );
        }

        // Foreground: the same transcript and activity wiring as a background
        // resume, so the `.output` file and the widget follow this run too.
        const knownMaxTurns = target.maxTurns === 0 ? undefined : target.maxTurns;
        const { state: fgResumeState, callbacks: fgResumeCallbacks } = createActivityTracker(resumeMaxTurns ?? knownMaxTurns);
        const wiring = resumeWiring(ctx, id, { outputTranscript: resumeTranscript }, fgResumeState);
        let record: AgentRecord | undefined;
        try {
          record = await manager.resume(id, params.prompt, signal, {
            maxTurns: resumeMaxTurns,
            pi,
            ctx,
            checkType: reopenTypeProblem,
            onToolActivity: fgResumeCallbacks.onToolActivity,
            onAssistantUsage: fgResumeCallbacks.onAssistantUsage,
            onTurnEnd: fgResumeCallbacks.onTurnEnd,
            onRecord: (rec) => {
              wiring.onRecord(rec);
              agentActivity.set(id, fgResumeState);
              widget.markRunning(id);
              widget.ensureTimer();
              fleet.ensureTimer();
            },
            onStarted: wiring.onStarted,
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        } finally {
          agentActivity.delete(id);
          widget.markFinished(id);
          fleet.onAgentFinished(id);
        }
        if (!record) {
          return errorResult(
            `Agent "${params.resume}" is still running — it can only be resumed once its current run finishes.\n` +
            `Use steer_subagent to send it a message mid-run. A completion notification arrives on its own when the run finishes.`,
          );
        }
        // A foreground resume flushes its transcript itself: only a background
        // settle path does that for a live record.
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }
        // A failed resume surfaces the error, plus any partial output THIS
        // resume produced (never the previous turn's answer, #144).
        if (record.status === "error") {
          return textResult(
            `Agent failed: ${record.error}${partialOutputSuffix(record)}${sessionFileLine(record)}${agentIdLine(record.id)}`,
            buildDetails(detailBaseFor(record), record),
            true,
          );
        }
        return textResult(
          // A resumed run can hit its turn limit, so say so the way a first
          // run's headline does rather than presenting partial output as done.
          (getForegroundOutcomeNote(record.status, record.stopCause) ? `Agent resumed${getForegroundOutcomeNote(record.status, record.stopCause)}.\n\n` : "") +
          (record.result?.trim() || "No output.") +
          (isFailedStatus(record.status) ? sessionFileLine(record) : "") +
          agentIdLine(record.id),
          buildDetails(detailBaseFor(record), record),
          isFailedStatus(record.status),
        );
      }

      // What the model sees for a run it no longer waits on — spawned in the
      // background, or handed there mid-run (background key / viewer `b`). One
      // text for both, as in Claude Code: from here on they are the same kind of agent.
      const backgroundResult = (id: string, record: AgentRecord | undefined) => {
        const isQueued = record?.status === "queued";
        return textResult(
          `${spawnNotes}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\n${BACKGROUND_FOLLOW_UP}\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBaseFor(record), toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      };

      // Background execution
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        // Read now: a queued agent may start after a session switch, when this
        // ctx is stale and every read of it throws.
        const bgCwd = ctx.cwd;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, bgCwd);
          }
        };

        // A throw here means the agent never started. Let it out: pi marks a
        // tool call failed only when execute throws, and a returned message
        // reads to the model as a subagent that ran and reported this (#179).
        id = manager.spawn(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          modelNote,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...bgCallbacks,
        });

        // Set output file + join mode synchronously after spawn, before the
        // event loop yields — onSessionCreated is async so this is safe.
        const joinMode = resolveJoinMode(defaultJoinMode, true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }

        // With isolation: "worktree" the agent isn't running yet — the repo
        // copy is an awaited git call. Wait for it here, after the synchronous
        // wiring above, so a strict-isolation failure still fails THIS tool
        // call instead of being reported as a subagent that ran (#179).
        await manager.awaitStartup(id);

        joinTurnGroup(id, joinMode);

        agentActivity.set(id, bgState);
        widget.ensureTimer();
        widget.update();
        fleet.ensureTimer();
        fleet.update();

        // Emit created event
        pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        return backgroundResult(id, record);
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;
      // Set once the run is live and can be handed to the background — see
      // `foregroundHandoffs`. Unset while queued: there is no run to hand over.
      let handoffId: string | undefined;
      // Set by the handoff. From then on `onUpdate` is a dead handle (pi drops
      // updates once `execute` has returned), so `streamUpdate` stops building
      // them; the tracker keeps `fgState` live for the widget and FleetView.
      let backgrounded = false;
      // Set only while the spawn is parked on a foreground concurrency slot
      // (maxConcurrentForeground); undefined the rest of the time, including
      // always when the limit is unset.
      let queuedAhead: number | undefined;

      const streamUpdate = () => {
        if (backgrounded) return;
        // Spend from the record, everything else from the live tracker. `fgId`
        // is set in onSessionCreated below, which fires before the first
        // assistant message — so nothing is spent while this reads zero.
        const fgRecord = fgId ? manager.getRecord(fgId) : undefined;
        const details: AgentDetails = {
          ...detailBaseFor(fgRecord),
          toolUses: fgState.toolUses,
          tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
          cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          // Deliberately still "running" while queued: the renderer routes any
          // status it doesn't know to raw text (see the catch-all below), which
          // would drop the spinner and read as hung. Only the activity line
          // changes — "thinking…" would be a lie for an agent that has not
          // started and may not for minutes.
          status: "running",
          activity: queuedAhead === undefined
            ? describeActivity(fgState.activeTools, fgState.responseText)
            : `queued — waiting for a foreground slot${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ""}`,
          spinnerFrame: spinnerFrame % SPINNER.length,
          // One hint per batch, as in Claude Code: on the earliest call still
          // pending (a Map iterates in insertion order). The key takes them all.
          backgroundHint: handoffId !== undefined && foregroundHandoffs.keys().next().value === handoffId,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as any,
        });
      };

      // No per-event push: the spinner frame below sends the latest state, so
      // a token-rate stream costs one update per frame, not one per token.
      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns);

      // Wire session creation: register in widget + stream to output file.
      // The output file path is set synchronously after spawn (below),
      // before onSessionCreated fires — same pattern as background agents.
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        // It really started — stop reporting it as queued, and repaint now
        // rather than leaving the stale line up for the next spinner tick.
        // Guarded, so a spawn that never queued emits no extra update.
        if (queuedAhead !== undefined) {
          queuedAhead = undefined;
          streamUpdate();
        }
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            widget.ensureTimer();
            fleet.ensureTimer();
            fleet.update();
            break;
          }
        }
        // Stream conversation to output file (foreground agent logging)
        if (fgId) {
          const rec = manager.getRecord(fgId);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
          }
        }
      };

      // Animate spinner at ~80ms (smooth rotation through 10 braille frames),
      // on the clock the widget and fleet list share, so their redraws coincide.
      const spinnerOwner = {};
      refreshTicker.set(spinnerOwner, 80, () => {
        spinnerFrame++;
        streamUpdate();
      });

      streamUpdate();

      // The background key or the viewer's `b` wakes this with the run already
      // handed over (`sendForegroundToBackground`), raced against the run
      // below. The manager only accepts a handoff of a run that has not
      // settled, and the wake-up resolves synchronously with it, so whichever
      // promise wins is the truth: the result is never also delivered as a
      // notification.
      let wakeBackgrounded!: () => void;
      const handedOff = new Promise<undefined>(resolve => { wakeBackgrounded = () => resolve(undefined); });

      let fgResult: { record: AgentRecord } | undefined;
      try {
        fgResult = await Promise.race([manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          invocation: agentInvocation,
          modelNote,
          signal,
          rootSessionId: ctx.sessionManager.getSessionId(),
          // Deliberately does NOT set fgId: that drives agentActivity, the
          // widget and the `finally` cleanup below, none of which should see an
          // agent that has no session and may never get one.
          onQueued: (_id, ahead) => { queuedAhead = ahead; streamUpdate(); },
          ...fgCallbacks,
        }, (fgAgentId) => {
          // onSpawned: called synchronously after spawn, before onSessionCreated fires.
          // Set up the output file so streamToOutputFile can pick it up.
          const fgRec = manager.getRecord(fgAgentId);
          attachTranscript(fgRec, fgAgentId);
          // Fires once the run promise exists, i.e. the agent is running. From
          // here until this call returns, the run can be handed off.
          handoffId = fgAgentId;
          foregroundHandoffs.set(fgAgentId, () => {
            // What a background spawn sets up front: the notification names
            // this tool call, and it reports alone — its turn's batch is long
            // closed.
            if (fgRec) {
              fgRec.toolCallId = toolCallId;
              fgRec.joinMode = "async";
            }
            backgrounded = true;
            wakeBackgrounded();
          });
        }), handedOff]);
      } finally {
        // Runs on both paths, so a startup throw — which now propagates, see
        // the background spawn above (#179) — no longer leaves the spinner
        // ticking or a finished agent on the widget.
        refreshTicker.delete(spinnerOwner);
        if (handoffId !== undefined) foregroundHandoffs.delete(handoffId);
        // A handed-off run is still working: its row stays, and the
        // background settle in `onComplete` tears it down when it really ends.
        if (fgId && !backgrounded) {
          agentActivity.delete(fgId);
          widget.markFinished(fgId);
          fleet.onAgentFinished(fgId);
        }
      }

      if (fgResult === undefined) {
        // Shown as a background agent from here on (the widget's default mode
        // hides foreground rows).
        widget.update();
        return backgroundResult(handoffId!, manager.getRecord(handoffId!));
      }
      const record = fgResult.record;

      // Get final token count — from the record, like the cost below it, so the
      // two describe the same work when the agent delegated to nested children.
      const tokenText = formatLifetimeTokens(record);

      const details = buildDetails(detailBaseFor(record), record, fgState, { tokens: tokenText });

      if (record.status === "error") {
        // Error headline + any partial output the run produced before failing.
        return textResult(
          `${spawnNotes}Agent failed: ${record.error}${partialOutputSuffix(record)}${sessionFileLine(record)}${agentIdLine(record.id)}`,
          details,
          true,
        );
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      if (showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(costText);
      }
      const modelText = runModelText(record);
      if (modelText) statsParts.push(modelText);
      // The headline names how the run ended: a stopped or aborted run did not
      // complete, and "completed" in front of it reads as a finished task.
      const headline = record.status === "stopped"
        ? record.stopCause === "session-end" ? "Agent was interrupted by the session's end after" : "Agent was stopped by the user after"
        : record.status === "aborted"
          ? "Agent was aborted after"
          : "Agent completed in";
      return textResult(
        `${spawnNotes}${headline} ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status, record.stopCause)}.\n\n` +
        (record.result?.trim() || "No output.") +
        (isFailedStatus(record.status) ? sessionFileLine(record) : "") +
        agentIdLine(record.id),
        details,
        isFailedStatus(record.status),
      );
    },
  });
  /**
   * Wrap a tool so its results carry back whatever subagent spend the parent
   * session has not been told about yet (see `PendingUsagePool`).
   *
   * Pi copies `AgentToolResult.usage` onto the persisted tool-result message and
   * folds it into `getSessionStats()`, which is what the footer, the statusline
   * and `/cost` read — so this is the whole of "report usage to the parent".
   *
   * Nothing is attached to a call with no tool-call id. That is the `@handle`
   * mention path (`mention-clone.ts`), which invokes this tool from a fork of the
   * conversation that is discarded moments later: the result never becomes a
   * message in the real session, so usage hung on it would be spend the user paid
   * for and nobody counted. Skipping leaves it pending for the next real result.
   */
  function withUsageReporting<T extends { execute: (...args: any[]) => any }>(tool: T): T {
    return {
      ...tool,
      execute: async (toolCallId: string | undefined, ...rest: any[]) => {
        const result = await tool.execute(toolCallId, ...rest);
        if (!reportUsage || !toolCallId) return result;
        const usage = pendingUsage.drain();
        return usage ? { ...result, usage } : result;
      },
    };
  }
  function registerToolReportingUsage(tool: any): void {
    pi.registerTool(withUsageReporting(tool));
  }

  // The mention path is handed THIS object, not the bare `agentTool` — see the
  // mention-clone header on why the clone must call the registered tool.
  const registeredAgentTool = withUsageReporting(agentTool);
  pi.registerTool(registeredAgentTool);

  // ---- Workflow tool ----

  /**
   * Live runs, by task id. The tool returns before the run finishes, so its
   * result card looks the task up here on every render rather than freezing a
   * snapshot into `details` — that is what makes the inline card follow a
   * background run.
   */
  const workflowTasks = new Map<string, WorkflowTask>();

  /**
   * Workflow runs as the fleet list wants them.
   *
   * Mapped here rather than handing `WorkflowTask` over the seam: the list is
   * deliberately ignorant of the workflow engine, and a run's counters live in
   * the progress log rather than on the record, so they are derived per call
   * the same way the card derives them.
   */
  function fleetWorkflows(): FleetWorkflow[] {
    // Cached counters only, no derivation: the fleet list calls this on a
    // 200ms tick and reads the roster several times per update, so walking a
    // run's progress log here would put O(log) work in the render loop.
    return [...workflowTasks.values()].map(task => ({
      id: task.id,
      name: task.meta?.name ?? task.workflowName ?? task.id,
      status: task.status,
      doneCount: task.doneCount,
      totalCount: task.agentCount,
      startedAt: task.startTime,
      ...(task.endTime !== undefined ? { completedAt: task.endTime } : {}),
      tokens: task.totalTokens,
    }));
  }

  /**
   * Run a task to completion against the real manager, settling the record
   * either way. Never rejects: a run that cannot start (bad `meta`, oversized
   * source, non-JSON `args`) is a failed workflow, and both callers here are
   * detached — a rejection would surface as an unhandled one.
   */
  async function runWorkflowTask(ctx: ExtensionContext, task: WorkflowTask): Promise<void> {
    try {
      const result = await runWorkflow({
        script: task.script,
        args: task.args,
        signal: task.abortController.signal,
        host: createWorkflowHost({
          pi,
          ctx,
          manager,
          signal: task.abortController.signal,
          rootSessionId: ctx.sessionManager.getSessionId(),
          workflowId: task.id,
        }),
        onProgress: entries => updateWorkflowProgressBatch(task, entries),
        // The dialog's pause / skip / retry keys run through this; it is dropped
        // again when the task settles.
        onControl: control => { task.control = control; },
        journal: {
          ...(task.replay !== undefined ? { entries: task.replay } : {}),
          ...(task.journalPath !== undefined
            ? { append: (entry: WorkflowJournalEntry) => appendJournal(task.journalPath!, entry) }
            : {}),
        },
      });
      completeWorkflowTask(task, result);
    } catch (err) {
      failWorkflowTask(task, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Hand a finished run back to the model through the SAME channel a background
   * agent uses — the completion outbox, which delivers at the parent's next
   * boundary — rendered by the existing `subagent-notification` renderer.
   */
  function notifyWorkflowFinished(task: WorkflowTask) {
    widget.update();
    fleet.update();
    flushPendingUsageIfIdle();
    const result = workflowResultText(task);
    const message = {
      content: formatWorkflowNotification(task),
      details: {
        id: task.id,
        description: `Workflow ${task.workflowName ?? task.id}`,
        status: task.status === "completed" ? "completed" as const : task.status === "killed" ? "stopped" as const : "error" as const,
        toolUses: task.totalToolCalls,
        // A workflow has agents, not turns; rendering "↻0" would be noise.
        turnCount: 0,
        totalTokens: task.totalTokens,
        durationMs: elapsedMs(task, Date.now()),
        error: task.error,
        resultPreview: result.length > 500 ? `${result.slice(0, 500)}…` : result,
      },
    };
    outbox.add({ ids: [task.id], build: () => message });
  }

  // Defined unconditionally, registered only when the feature is on — the same
  // shape the Agent tool uses. Keeping the definition out of the `if` means the
  // switch changes exactly one thing: whether pi is ever told about the tool.
  const workflowTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.WORKFLOW,
    label: "SubagentWorkflow",
    description: renderToolDescriptionTemplate(workflowToolDescription(isModelOverrideAllowed())),
    promptSnippet: "Run a deterministic script that orchestrates many subagents",
    promptGuidelines: [
      "Use SubagentWorkflow when the number of agents depends on something discovered at runtime, when work flows through stages, or when findings should be independently verified. Use Agent for one delegated task or a handful you can name up front.",
      "Prefer `pipeline` over `parallel` — a barrier costs wall-clock whenever the stages are unevenly sized.",
      "A workflow runs in the background and notifies you when it finishes — do not poll or sleep waiting for it.",
    ],
    parameters: Type.Object({
      script: Type.Optional(
        Type.String({
          maxLength: 524288,
          description: "Inline workflow source. Must begin with `export const meta = { name, description }`.",
        }),
      ),
      scriptPath: Type.Optional(
        Type.String({
          description:
            "Path to a workflow script file, absolute or relative to the project. Takes precedence over `script` — this is how you re-run an edited workflow.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description:
            "Name of a saved workflow — `<name>.js` in .pi/workflows/, .agents/workflows/ or the user's agent dir. Lowest precedence: `scriptPath` and `script` both win over it.",
        }),
      ),
      args: Type.Optional(
        Type.Any({
          description: "Exposed to the script as the global `args`, verbatim. Must be JSON-shaped.",
        }),
      ),
      resumeFromRunId: Type.Optional(
        Type.String({
          pattern: "^wf_[a-z0-9-]{6,}$",
          description:
            "Run id of an earlier workflow in this session. Its unchanged leading agent() calls return their recorded results instantly; the first changed or failed call, and everything after it, runs live. Same script and args means nothing re-runs.",
        }),
      ),
      // Accepted and ignored, as in Claude Code. Models reach for them because
      // every other tool has them, and a hard schema rejection would cost a
      // whole turn to re-emit a script that was already correct. The `meta`
      // block is the one place a workflow is named.
      title: Type.Optional(
        Type.String({ description: "Ignored — set the workflow title in the script's `meta` block." }),
      ),
      description: Type.Optional(
        Type.String({ description: "Ignored — set the workflow description in the script's `meta` block." }),
      ),
    }),

    renderCall(args, theme, context) {
      // Parse `meta` only once the arguments stop streaming (or on a replayed
      // call, which arrives with its result): every delta is a new prefix.
      const parse = !context || context.argsComplete || context.executionStarted || !context.isPartial;
      return new Text(
        `${theme.fg("toolTitle", "▸ ")}${theme.bold(theme.fg("toolTitle", "SubagentWorkflow"))}  ${theme.fg("muted", workflowCallName(args, { parse }))}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme, renderContext) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const taskId = (result.details as { taskId?: string } | undefined)?.taskId;
      const task = taskId !== undefined ? workflowTasks.get(taskId) : undefined;
      // No task means the run predates this session (a reloaded transcript) or
      // the call never started one — show what `execute` said instead.
      if (renderContext.isError || !task) return new Text(text, 0, 0);
      return renderWorkflowCard(
        {
          progress: task.workflowProgress,
          task: {
            status: task.status,
            workflowName: task.workflowName,
            startTime: task.startTime,
            endTime: task.endTime,
            totalPausedMs: task.totalPausedMs,
          },
          meta: task.meta,
          agentCount: task.agentCount,
          totalTokens: task.totalTokens,
        },
        theme,
      );
    },

    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      // A run from before a restart, `/resume` or `/reload` is found by its
      // files: its journal and saved script sit in this session's task dir.
      const resumeFrom = resolveResumeTarget(params.resumeFromRunId, workflowTasks, (id) => {
        try {
          const dir = sessionTaskDir(ctx.cwd, ctx.sessionManager.getSessionId());
          const journal = join(dir, `${id}.workflow.jsonl`);
          if (!existsSync(journal)) return undefined;
          const script = join(dir, `${id}.workflow.js`);
          return { journalPath: journal, ...(existsSync(script) ? { scriptPath: script } : {}) };
        } catch {
          return undefined;
        }
      });
      if (resumeFrom !== undefined && !resumeFrom.ok) return textResult(resumeFrom.message);

      // A resume with no source of its own re-runs what that run ran. The
      // common case is an edited script, but "run that again, cheaply" should
      // not require repeating a path the run already knows.
      const resolved = resolveWorkflowScript(
        params.script === undefined && params.scriptPath === undefined && params.name === undefined
          && resumeFrom !== undefined
          ? { scriptPath: resumeFrom.scriptPath }
          : params,
        ctx.cwd,
        isProjectCodeTrusted(isProjectTrustedBy(ctx), ctx.cwd),
      );
      if (!resolved.ok) return textResult(resolved.message);

      // Parsed before anything is scheduled: a bad `meta` is an authoring error
      // the model can fix immediately, and reporting it as a background run
      // that failed a second later would just cost a turn.
      let meta: WorkflowMeta;
      try {
        meta = extractMeta(resolved.script).meta;
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }

      const runId = workflowRunId();
      // Every invocation lands on disk next to the agent transcripts, so
      // iterating is edit-the-file-then-rerun-with-scriptPath rather than
      // re-emitting the whole source. The journal sits beside it under the same
      // id, which is what makes a run id enough to resume from.
      let savedPath: string | undefined;
      let journalPath: string | undefined;
      try {
        const dir = sessionTaskDir(ctx.cwd, ctx.sessionManager.getSessionId());
        savedPath = join(dir, `${runId}.workflow.js`);
        writeFileSync(savedPath, resolved.script, "utf-8");
        journalPath = join(dir, `${runId}.workflow.jsonl`);
      } catch (err) {
        savedPath = undefined;
        journalPath = undefined;
        console.warn(`[pi-subagents] could not persist workflow script: ${err instanceof Error ? err.message : String(err)}`);
      }

      const replay = resumeFrom !== undefined ? readJournal(resumeFrom.journalPath) : undefined;

      const task = createWorkflowTask({
        id: runId,
        script: resolved.script,
        scriptPath: resolved.scriptPath ?? savedPath,
        args: params.args,
        meta,
        toolCallId,
        ...(journalPath !== undefined ? { journalPath } : {}),
        ...(replay !== undefined && replay.length > 0 ? { replay, resumedFrom: resumeFrom!.runId } : {}),
      });
      workflowTasks.set(runId, task);
      pruneSettledWorkflowTasks(workflowTasks);
      // The run's own row has to appear now, not when it settles. Its agents
      // are owned by it, so their lifecycle callbacks no longer refresh these
      // surfaces — nothing else would register the widget for a run whose
      // first agent has not started yet.
      widget.update();
      fleet.update();

      // Background, like Claude Code: the id comes back now and the run keeps
      // going without the tool call.
      void runWorkflowTask(ctx, task)
        .then(() => { if (!disposed) notifyWorkflowFinished(task); })
        .catch(() => { /* the session went away mid-flight */ });

      return {
        content: [{
          type: "text" as const,
          text:
            `Workflow "${meta.name}" started in the background.\n` +
            `Task ID: ${runId}\n` +
            (task.scriptPath ? `Script: ${task.scriptPath}\n` : "") +
            (task.resumedFrom !== undefined
              ? `Resuming ${task.resumedFrom}: ${task.replay?.length ?? 0} recorded call(s) available to replay.\n`
              : params.resumeFromRunId !== undefined
                ? `Nothing to replay from ${params.resumeFromRunId} — every agent runs live.\n`
                : "") +
            `\nYou will be notified when it finishes — do NOT poll or sleep waiting for it.\n` +
            `To iterate, edit the script file and call SubagentWorkflow again with scriptPath.`,
        }],
        details: { taskId: runId },
      };
    },
  });

  if (isWorkflowsEnabled()) pi.registerTool(workflowTool);

  /**
   * Act on {@link decideWorkflowCollision} — the half that needs the host.
   *
   * The policy (what counts as a conflict, what a pin changes, whether there is
   * anything left to withdraw) lives in `workflow/collisions.ts`; this is the
   * host-facing shell around it: read the registry, warn, and take our tool out
   * of the active set.
   *
   * ## Why this can only happen at session_start
   *
   * `getAllTools` throws during extension loading ("Action methods cannot be
   * called during extension loading"), and load order means a check at
   * registration time could not see an extension that has not loaded yet. So
   * the decision cannot gate `registerTool`; it has to undo it. `setActiveTools`
   * is what makes that real rather than cosmetic — pi rebuilds the system
   * prompt from the new set, and `session_start` runs before any turn, so the
   * model never sees a spec we withdrew. A later `_refreshToolRegistry` keeps
   * the active set it had and only adds names new to the registry, so ours does
   * not creep back.
   *
   * Best-effort and swallowed. A diagnostic that took the session down would be
   * worse than the collision it reports.
   */
  let collisionsChecked = false;
  function resolveWorkflowCollisions(ctx: ExtensionContext): void {
    if (collisionsChecked) return;
    collisionsChecked = true;

    const warn = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(`[pi-subagents] ${message}`);
    };

    try {
      if (!isWorkflowsEnabled()) return;

      const verdict = decideWorkflowCollision({
        tools: pi.getAllTools(),
        // Identifies our own registration: this extension does not know its
        // install path, and the description is the one field certainly ours.
        ownDescription: workflowTool.description,
        pinned: isWorkflowsPinned(),
      });
      if (verdict.kind === "none") return;
      if (verdict.kind === "report") {
        warn(verdict.message);
        return;
      }

      workflowsEnabled = false; // not setWorkflowsEnabled: this is not the user pinning it
      widget.update();
      fleet.update();
      warn(verdict.message);

      if (!verdict.withdraw) return;
      const active = pi.getActiveTools();
      if (active.includes(SUBAGENT_TOOL_NAMES.WORKFLOW)) {
        pi.setActiveTools(active.filter(name => name !== SUBAGENT_TOOL_NAMES.WORKFLOW));
      }
    } catch {
      // getAllTools/setActiveTools are unavailable in some hosts (print mode,
      // RPC). Not being able to check is not a reason to fail the session.
    }
  }

  /**
   * `--subagents-workflow-file=<path>` — run a script at startup, with no LLM
   * round-trip deciding whether to call the tool.
   *
   * Read here rather than at activation because that is the only place the real
   * value exists: the host activates extensions first and applies collected CLI
   * flags second, so `getFlag` during activation returns the registered default
   * and nothing else. `examples/extensions/ssh.ts` reads its flag from
   * session_start for exactly this reason.
   */
  let workflowFlagHandled = false;
  function runWorkflowFlag(ctx: ExtensionContext): void {
    if (workflowFlagHandled) return;
    const flag = pi.getFlag(WORKFLOW_FILE_FLAG);
    if (flag === undefined || flag === false) return;
    workflowFlagHandled = true;

    const report = (message: string, level: "info" | "warning") => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
      else console.warn(`[pi-subagents] ${message}`);
    };

    // The flag is the same machinery by another door, so the master switch has
    // to close it too — silently ignoring a flag the user typed would be worse
    // than saying why nothing ran.
    if (!isWorkflowsEnabled()) {
      report(
        `--${WORKFLOW_FILE_FLAG} ignored: workflows are off. Turn them on in /agents → Settings → Workflows, ` +
          'or set `"workflowsEnabled": true` in .pi/subagents.json.',
        "warning",
      );
      return;
    }

    // A bare `--subagents-workflow-file` parses to boolean `true`. Say what was
    // missing rather than reading a file called "true".
    if (typeof flag !== "string" || flag.trim() === "") {
      report(`--${WORKFLOW_FILE_FLAG} needs a path: --${WORKFLOW_FILE_FLAG}=<path>`, "warning");
      return;
    }

    const path = isAbsolute(flag.trim()) ? flag.trim() : join(ctx.cwd, flag.trim());
    let script: string;
    try {
      script = readWorkflowScriptFile(path);
    } catch (err) {
      report(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }

    let meta: WorkflowMeta | undefined;
    try {
      meta = extractMeta(script).meta;
    } catch (err) {
      report(err instanceof Error ? err.message : String(err), "warning");
      return;
    }

    const task = createWorkflowTask({ id: workflowRunId(), script, scriptPath: path, meta });
    workflowTasks.set(task.id, task);
    pruneSettledWorkflowTasks(workflowTasks);
    widget.update();
    fleet.update();
    report(`Running workflow ${meta.name}…`, "info");

    // Detached: session_start is awaited by the host, and a workflow can run for
    // minutes — blocking here would hold the whole session's startup.
    void runWorkflowTask(ctx, task).then(() => {
      if (disposed) return;
      // No tool call to attach a result card to, so the card becomes a session
      // entry (same layout), and the outcome is handed to the model as context
      // for its next turn rather than forcing one.
      pi.appendEntry<WorkflowEntryData>(WORKFLOW_ENTRY_TYPE, workflowEntryData(task));
      pi.sendMessage({
        customType: "workflow-result",
        content: formatWorkflowNotification(task),
        display: false,
      }, { deliverAs: "nextTurn" });
      widget.update();
      fleet.update();
      flushPendingUsageIfIdle();
    }).catch(() => { /* the session went away mid-flight */ });
  }

  // ---- get_subagent_result tool ----

  /** A finished top-level agent of this session whose record was released, by id or handle. */
  function evictedTopLevelAgent(ref: string): AgentResumeState | undefined {
    const byId = manager.findTombstone(ref);
    if (byId) return isTopLevelAgent(byId) ? byId : undefined;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "tombstone" ? resolved.entry : undefined;
  }

  /**
   * get_subagent_result for an agent whose record the 10-minute cleanup has
   * released: status and model from its kept resume state, the result from
   * its saved session file. Read on demand, so nothing is held in memory
   * longer for it.
   */
  function savedAgentResult(entry: AgentResumeState) {
    const saved = readSavedResult(entry.sessionFile);
    if (typeof saved === "string") {
      return errorResult(`Agent ${entry.id} finished and was released from memory, and its result cannot be read: ${saved}.`);
    }
    const status = entry.status ?? "unknown";
    const model = entry.model ?? saved.model;
    const thinking = entry.thinking ?? saved.thinking;
    let output =
      `Agent: ${entry.id}\n` +
      `Type: ${getDisplayName(entry.type)} | Status: ${status}${getStatusNote(status, entry.stopCause)}\n` +
      (model ? `Model: ${thinking ? `${model}, thinking: ${thinking}` : model}\n` : "") +
      `Description: ${entry.description}\n` +
      `(Read from the agent's saved session file, ${entry.sessionFile}: its in-memory record was released after it finished.)\n\n`;
    if (status === "error") {
      output += `Error: ${saved.error ?? "not recorded in the saved session"}`;
      if (saved.text) output += `\n\nPartial output before the failure:\n${saved.text}`;
    } else {
      output += saved.text || "No output.";
    }
    // Its notification, if one is still pending, is answered by this read.
    outbox.cancel(entry.id);
    return textResult(output, undefined, isFailedStatus(status));
  }

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Retrieve a background agent's full result after its completion notification, which carries only a preview. " +
      "You are notified automatically when a background agent finishes, so do not call this to check on one that is " +
      "still running — continue with other work instead. Use the agent ID returned by Agent.",
    promptSnippet: "Retrieve a finished background agent's full result",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "If true, block until the agent finishes. Only when there is nothing else to do until it does; " +
            "otherwise keep working and let the completion notification arrive. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    prepareArguments: argumentRepair(RESULT_ARG_SHAPE),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record) {
        // Released from memory after it finished: its resume state is kept,
        // and its saved session still holds the final result.
        const evicted = evictedTopLevelAgent(params.agent_id);
        if (evicted) return savedAgentResult(evicted);
      }
      if (!record || !isTopLevelAgent(record)) {
        return errorResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // Wait for completion if requested. Cancellation stops only this tool
      // call; the background agent keeps running and remains unconsumed so its
      // completion notification can still be delivered.
      // Queued agents have no promise yet (it's created when the queue starts
      // them), so wait on the queue's start gate (resolved on every way out of
      // the queue) until they leave it, then await like a running one. Polling
      // is the fallback for a queued record without a gate.
      // A stopped agent still winding down (committing its worktree, or a tool
      // ignoring the stop) is waited for too: its partial result lands when it
      // settles, and reading "stopped" as "over" would report "No output." and
      // consume the notification that would have carried it.
      if (params.wait && manager.isRunActive(record.id)) {
        while (record.status === "queued") {
          await abortable(
            record.startGate ?? new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
            signal,
          );
        }
        // A worktree agent has no promise until its copy is made; a failed
        // start lands on the record as an error, so the rejection is dropped.
        await abortable(manager.awaitStartup(record.id).catch(() => {}), signal);
        if (record.promise) await abortable(record.promise, signal);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(`Cost: ${costText}`);
      }
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      const modelText = runModelText(record);
      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status, record.stopCause)} | ${statsParts.join(" | ")}\n` +
        (modelText ? `Model: ${modelText}\n` : "") +
        (record.modelNote ? `${record.modelNote}\n` : "") +
        `Description: ${record.description}\n\n`;

      const active = manager.isRunActive(record.id);
      if (record.status === "running" || record.status === "queued") {
        output += stillRunningText(record.status);
      } else if (record.status === "stopped" && active) {
        output += stillRunningText("stopping");
      } else if (record.status === "error") {
        output += `Error: ${record.error}${partialOutputSuffix(record)}${sessionFileLine(record)}`;
      } else {
        output += (record.result?.trim() || "No output.") + (isFailedStatus(record.status) ? sessionFileLine(record) : "");
      }

      // Mark result as consumed — suppresses the completion notification
      if (!active) {
        record.resultConsumed = true;
        outbox.cancel(record.id);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      // A failed, aborted or stopped run is reported as an error result, so the
      // model does not read its fragment as the finished task.
      return textResult(output, undefined, isFailedStatus(record.status));
    },
  }));

  // ---- steer_subagent tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running). The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    prepareArguments: argumentRepair(STEER_ARG_SHAPE),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || !isTopLevelAgent(record)) {
        return errorResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return errorResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        // Session not ready yet — queue the steer for delivery once initialized
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        if (showCost) {
          const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
          if (costText) stateParts.push(costText);
        }
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return errorResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- /agents interactive menu ----

  // Directory resolution and the frontmatter edits live in agent-file-toggle.ts
  // so they are reachable from tests — this command handler is only registered
  // through `registerCommand`, which every test mocks.

  function getModelLabel(type: string, registry?: ModelRegistry, parentProvider?: string): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit"; // no model configured → really inherits parent
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const resolution = resolveModelDetailed(cfg.model, registry, parentProvider);
    // Configured but unresolvable: the run falls back to the parent model (and
    // its result says so), so flag it here too rather than hiding the config.
    if (!resolution.ok) return `${label} (${resolution.reason === "ambiguous" ? "ambiguous" : "unavailable"}, fallback: inherit)`;
    const resolved = resolution.model;
    // Surface what it actually resolved to when that differs from the config —
    // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
    // differences are normalized away so an effectively-identical match stays quiet.
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
    if (norm(cfg.model) === norm(resolvedFull)) return label;
    return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Build select options
    const options: string[] = [];

    // Running agents entry (only if there are active agents)
    const agents = manager.listAgents().filter(isTopLevelAgent);
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }

    // Agent types list
    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    // Scheduled jobs entry (always present when scheduler is active)
    if (scheduler.isActive()) {
      const jobCount = scheduler.list().length;
      options.push(`Scheduled jobs (${jobCount})`);
    }

    // Workflow runs, on the same terms as scheduled jobs: shown only when the
    // feature is on, so the menu never advertises something switched off.
    if (isWorkflowsEnabled()) {
      options.push(`Workflows (${workflowTasks.size})`);
    }

    // Actions
    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Scheduled jobs (")) {
      await showSchedulesMenu(ctx, scheduler);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Workflows (")) {
      await showWorkflowsMenu(ctx, workflowMenuDeps);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
    // Disabled agents get ✕ prefix
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    // One row per agent (name in the left column, model on the right); the
    // full description renders below the highlighted row via SettingsList,
    // exactly like the Settings menu — so long descriptions never wrap the list.
    const items: SettingItem[] = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry, ctx.model?.provider);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: disabled ? "(disabled)" : (cfg?.description ?? name),
        // Single-value list so Enter "activates" the row (fires onChange with the
        // agent's id) without offering anything to actually cycle.
        values: [model],
      };
    });

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");

    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        id => done(id), // Enter/Space on a row → return that agent's name
        () => done(undefined), // Esc → cancel
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    });

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents().filter(isTopLevelAgent);
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Numbered + item-paired. Two same-type agents spawned together with the
    // same description render identically here, and resolving the choice by
    // string match would open whichever came first.
    const record = await selectItem(ctx.ui, "Running agents", agents, a => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });
    if (!record) return;

    await viewAgentConversation(ctx, record);
    // Back-navigation: re-show the list
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    const session = record.session;
    const activity = agentActivity.get(record.id);
    let overlayOptions = getConversationOverlayOptions({ mode: "regular" });

    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        overlayOptions = getConversationOverlayOptions(tui);
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          if (manager.abort(record.id)) {
            ctx.ui.notify(`Stopped "${record.description}".`, "info");
          }
        }, keybindings, (message: string) => manager.steer(record.id, message), showCost,
        backgroundActionFor(record, message => ctx.ui.notify(message, "info")), getFullscreenScrollbar(), getViewerRenderOptions());
      },
      {
        overlay: true,
        overlayOptions: () => overlayOptions,
      },
    );
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = locateAgentFile(name, cfg.sourcePath);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      // Disabled agent with a file — offer Enable
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      // Default agent with no .md override
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      // Default agent with .md override (ejected)
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      // User-defined agent
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  /** Eject a default agent: write its embedded config as a .md file. */
  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const content = serializeAgentFile(cfg);

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  /** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = locateAgentFile(name, getAgentConfig(name)?.sourcePath);
    if (file) {
      // Existing file — set enabled: false in frontmatter (idempotent)
      const content = readFileSync(file.path, "utf-8");
      const { content: updated, outcome } = disableInContent(content);
      if (outcome === "already-disabled") {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      if (outcome === "no-frontmatter") {
        // Nothing to edit — say so rather than rewriting the file unchanged and
        // reporting success for a change that never happened.
        ctx.ui.notify(`Cannot disable ${name}: ${file.path} has no frontmatter block.`, "error");
        return;
      }
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    // No file (built-in default) — create a stub
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its frontmatter. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = locateAgentFile(name, getAgentConfig(name)?.sourcePath);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const { content: updated, changed } = enableInContent(content);
    if (!changed && !isEmptyStub(updated)) {
      // The file carries no `enabled: false` to remove, so it was never disabled
      // by us — reporting success here would hide a no-op.
      ctx.ui.notify(`${name} is not disabled in ${file.path}.`, "info");
      return;
    }
    const { writeFileSync } = await import("node:fs");

    // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
    if (isEmptyStub(updated)) {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
color: <optional agent name badge color: red, blue, green, yellow, purple, orange, pink, cyan, an Agency Agents alias, or quoted "#RRGGBB">
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <pin this agent to background (true) or foreground (false). Omit to follow the backgroundByDefault setting, which is background>
output_transcript: <false to write no transcript file or path for this agent. Independent of persist_session. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>${
      // Offering the field on a project that turned worktrees off would bake a
      // request that is refused at spawn time into a file that outlives the
      // session — the #231 pathology (models fill the fields they are shown)
      // one layer up. Built per invocation, so this read is live.
      isWorktreeIsolationEnabled()
        ? `\nisolation: <"worktree" to run in isolated git worktree; "off" to refuse one even when the caller asks. Omit for normal>`
        : ""
    }
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip writing this agent's transcript; this alone doesn't keep the run off disk (persist_session, isolation: worktree commits, and memory still write) — set those too if that's the goal
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: 5,
      // Exempt from maxConcurrentForeground. This runs from a modal wizard, not
      // a tool call: it passes no signal, and Esc in `ctx.ui` never reaches the
      // manager — so a user waiting behind a full pool would have no way to
      // cancel at all. It is also one human action that cannot fan out, which
      // is what the limit exists to bound. It still counts once started.
      bypassQueue: true,
    });

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    reloadCustomAgents();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    // 1. Name
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    // 2. Description
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    // 3. Tools
    const toolChoice = await ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, grep, find, ls";
    } else {
      const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      tools = customTools;
    }

    // 4. Model
    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let model: string | undefined;
    if (modelChoice === "haiku") model = "anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") model = "anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") model = "anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      model = (await ctx.ui.input("Model (provider/modelId)")) || undefined;
    }

    // 5. Thinking
    // "inherit" is a UI-only pseudo-choice (omit the field); the rest mirror pi.
    const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", ...THINKING_LEVELS]);
    if (!thinkingChoice) return;

    // 6. System prompt
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = buildNewAgentFile({
      description,
      tools,
      model,
      thinking: thinkingChoice === "inherit" ? undefined : thinkingChoice,
      systemPrompt,
    });

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  /**
   * Every settings mutation writes this WHOLE object back to disk, so a field
   * missing here is erased from the user's subagents.json the next time they
   * toggle something unrelated. `SubagentsSettings` has every field optional,
   * so a `: SubagentsSettings` return annotation would let a newly-added setting
   * be forgotten here and still type-check. `satisfies` instead: it still checks
   * each value's type and rejects a mistyped key, but leaves the return type
   * inferred so `_NoMissingSettingsKeys` below can check completeness.
   */
  function snapshotSettings() {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      // 0 = unlimited, and the default — see SubagentsSettings.
      maxConcurrentForeground: manager.getMaxConcurrentForeground(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      toolTimeoutSeconds: getToolTimeoutSeconds(),
      codemodeTimeoutSeconds: getCodemodeTimeoutSeconds(),
      defaultJoinMode: getDefaultJoinMode(),
      backgroundByDefault: getBackgroundByDefault(),
      schedulingEnabled: isSchedulingEnabled(),
      scopeModels: isScopeModelsEnabled(),
      allowModelOverride: isModelOverrideAllowed(),
      strictAgentFiles,
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      agentMentions: getAgentMentionMode(),
      rememberAgents: getRememberAgents(),
      widgetMode: getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
      // The user's answer, not the effective one. A stand-down for another
      // extension's workflow tool is scoped to the session it was detected in;
      // writing it here would let an unrelated settings change three menus away
      // freeze it into the file as an explicit `false`, which then survives
      // uninstalling the extension it was deferring to. undefined is dropped by
      // JSON.stringify, so unset stays unset — same reasoning as
      // `fallbackSubagent` below.
      workflowsEnabled: isWorkflowsPinned() ? isWorkflowsEnabled() : undefined,
      maxSubagentDepth: getMaxSubagentDepth(),
      // Deliberately NOT `?? "general-purpose"`: every settings change writes the
      // whole snapshot, and materializing the implicit default would turn it into
      // explicit configuration — which then fails loudly if general-purpose later
      // goes away. undefined is dropped by JSON.stringify.
      fallbackSubagent: getFallbackSubagent(),
      reportUsage: isReportUsageEnabled(),
      showCost: isShowCostEnabled(),
      showModel: isShowModelEnabled(),
      // As written: undefined (the default) stays out of the file.
      backgroundKey: backgroundKeySetting,
      ...orchestrationSettingsAsWritten(),
    } satisfies SubagentsSettings;
  }

  // Compile-time completeness guard for snapshotSettings(). If a field is added
  // to SubagentsSettings and not mirrored above, this Exclude is non-empty and
  // fails to satisfy `never` — turning a silent settings-erasure bug into a
  // typecheck error. `npm run typecheck` runs in CI. (`projectTrust` is read from the
  // global file only, so it is never part of the project snapshot.)
  type _NoMissingSettingsKeys =
    Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings> | "projectTrust"> extends never
      ? true
      : ["snapshotSettings() is missing a SubagentsSettings key"];
  const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
  void _settingsSnapshotIsComplete;

  const NUMERIC_IDS = new Set([
    "maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns", "toolTimeoutSeconds", "maxSubagentDepth",
  ]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const mcf = manager.getMaxConcurrentForeground();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();
      const tts = getToolTimeoutSeconds();
      const msd = getMaxSubagentDepth();
      // Label what unset actually does — it targets general-purpose even when
      // that is unregistered (the permissive hardcoded tier), so showing "none"
      // there would advertise strict dispatch for the most permissive state.
      // `values` still offers only resolvable targets, so the user cannot
      // persist a fallback that would hard-error on every dispatch.
      const fallbackValue = getFallbackSubagent() ?? "general-purpose";
      const fallbackValues = [...new Set([...getAvailableTypes(), NO_FALLBACK])];

      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent background agents (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "maxConcurrentForeground",
          label: "Max foreground concurrency",
          description: "Max concurrent foreground (blocking) agents (0 = unlimited, Enter to type)",
          currentValue: String(mcf),
          values: [String(mcf)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "toolTimeoutSeconds",
          label: "Tool timeout",
          description: "Seconds one subagent tool call may run before it is stopped and the agent continues (0 = no limit, Enter to type)",
          currentValue: String(tts),
          values: [String(tts)],
        },
        {
          id: "maxSubagentDepth",
          label: "Nested depth",
          description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
          currentValue: String(msd),
          values: [String(msd)],
        },
        {
          id: "joinMode",
          label: "Join mode",
          description: "smart = each completion at the parent's next boundary, as in Claude Code; group = one notification per turn's batch",
          // `async` is an older name for `smart`; settings files may still hold it.
          currentValue: getDefaultJoinMode() === "group" ? "group" : "smart",
          values: ["smart", "group"],
        },
        {
          id: "backgroundByDefault",
          label: "Background by default",
          description: "An Agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
          currentValue: getBackgroundByDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "schedulingEnabled",
          label: "Scheduling",
          description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
          currentValue: isSchedulingEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "workflowsEnabled",
          label: "Workflows",
          description:
            "Scripted workflows, on unless another extension provides a workflow tool "
            + "(off keeps the SubagentWorkflow tool out of the tool spec; applies on next pi session)",
          currentValue: isWorkflowsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "allowModelOverride",
          label: "Model override",
          description:
            "Let Agent calls, workflows and scheduled jobs pick a subagent's model and thinking level; "
            + "off runs every subagent on your current model and thinking level unless its agent file sets one "
            + "(the tool parameters change on next pi session)",
          currentValue: isModelOverrideAllowed() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "strictAgentFiles",
          label: "Strict agent files",
          description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
          currentValue: strictAgentFiles ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "disableDefaultAgents",
          label: "Disable defaults",
          description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
          currentValue: isDefaultsDisabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fallbackSubagent",
          label: "Fallback agent",
          description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
          currentValue: fallbackValue,
          values: fallbackValues,
        },
        {
          id: "outputTranscript",
          label: "Output transcript",
          description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
          currentValue: getOutputTranscriptDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "worktreeIsolation",
          label: "Worktree isolation",
          description:
            "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
          currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "reportUsage",
          label: "Report usage to session",
          description:
            "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
          currentValue: isReportUsageEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showCost",
          label: "Show cost",
          description:
            "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
          currentValue: isShowCostEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showModel",
          label: "Show model",
          description:
            "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows. The Agent tool result and the conversation viewer show the pair either way — this adds it to the widget, where the row is already dense.",
          currentValue: isShowModelEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fleetView",
          label: "Fleet view",
          description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
          currentValue: isFleetViewEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "agentMentions",
          label: "Agent mentions",
          description: "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
          currentValue: getAgentMentionMode(),
          values: ["model", "direct", "off"],
        },
        {
          id: "rememberAgents",
          label: "Remember agents",
          description: "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
          currentValue: getRememberAgents() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "widgetMode",
          label: "Widget",
          description: "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
          currentValue: getWidgetMode(),
          values: ["all", "background", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        }
      } else if (id === "maxConcurrentForeground") {
        // 0 is meaningful here, unlike maxConcurrent above: it means unlimited.
        const n = parseInt(value, 10);
        if (n >= 0) {
          manager.setMaxConcurrentForeground(n);
          notifyApplied(ctx, n === 0
            ? "Max foreground concurrency set to unlimited"
            : `Max foreground concurrency set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        }
      } else if (id === "toolTimeoutSeconds") {
        const n = parseInt(value, 10);
        if (n >= 0) {
          setToolTimeoutSeconds(n);
          notifyApplied(ctx, n === 0 ? "Tool timeout off" : `Tool timeout set to ${getToolTimeoutSeconds()} s`);
        }
      } else if (id === "maxSubagentDepth") {
        const n = parseInt(value, 10);
        if (n >= 0) {
          setMaxSubagentDepth(n);
          notifyApplied(
            ctx,
            n <= 1
              ? "Nested delegation disabled"
              : `Nested depth set to ${n}. Applies to agents started from now on.`,
          );
        }
      } else if (id === "joinMode") {
        setDefaultJoinMode(value as JoinMode);
        notifyApplied(ctx, `Default join mode set to ${value}`);
      } else if (id === "backgroundByDefault") {
        const enabled = value === "on";
        setBackgroundByDefault(enabled);
        notifyApplied(
          ctx,
          enabled
            ? "Agent calls run in the background unless they pass run_in_background: false"
            : "Agent calls block and return inline unless they pass run_in_background: true",
        );
      } else if (id === "schedulingEnabled") {
        const enabled = value === "on";
        if (enabled === isSchedulingEnabled()) {
          ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
        } else {
          setSchedulingEnabled(enabled);
          if (!enabled) scheduler.stop();  // immediate kill — outstanding fires stop ticking
          notifyApplied(
            ctx,
            `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          );
        }
      } else if (id === "workflowsEnabled") {
        const enabled = value === "on";
        if (enabled === isWorkflowsEnabled()) {
          ctx.ui.notify(`Workflows already ${enabled ? "enabled" : "disabled"}.`, "info");
        } else {
          setWorkflowsEnabled(enabled);
          // Runs already in flight keep going: the switch governs whether the
          // tool is offered, and killing live agents on a settings toggle would
          // lose work the user never asked to discard.
          notifyApplied(
            ctx,
            `Workflows ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          );
        }
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "allowModelOverride") {
        const enabled = value === "on";
        setModelOverrideAllowed(enabled);
        notifyApplied(
          ctx,
          enabled
            ? "Subagent calls may pick a model and thinking level. Tool spec change takes effect on next pi session."
            : "Subagents run on your current model and thinking level. Tool spec change takes effect on next pi session.",
        );
      } else if (id === "strictAgentFiles") {
        const enabled = value === "on";
        strictAgentFiles = enabled;
        notifyApplied(ctx, `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`);
      } else if (id === "disableDefaultAgents") {
        const enabled = value === "on";
        setDisableDefaultAgents(enabled);
        notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`);
      } else if (id === "fallbackSubagent") {
        setFallbackSubagent(value);
        notifyApplied(
          ctx,
          value === NO_FALLBACK
            ? "Unknown or disabled agent types will now be rejected"
            : `Unknown agent types will fall back to ${value}`,
        );
      } else if (id === "outputTranscript") {
        const enabled = value === "on";
        setOutputTranscriptDefault(enabled);
        notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
      } else if (id === "worktreeIsolation") {
        const enabled = value === "on";
        setWorktreeIsolationEnabled(enabled);
        // The refusal is live, but the tool schema is built at registration, so
        // the isolation parameter only appears/disappears next session.
        notifyApplied(
          ctx,
          `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
        );
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      } else if (id === "reportUsage") {
        const enabled = value === "on";
        setReportUsage(enabled);
        notifyApplied(
          ctx,
          enabled
            ? "Subagent usage now counted in this session's totals"
            : "Subagent usage no longer counted in this session's totals",
        );
      } else if (id === "showCost") {
        const enabled = value === "on";
        setShowCost(enabled);
        notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "showModel") {
        const enabled = value === "on";
        setShowModel(enabled);
        notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "fleetView") {
        const enabled = value === "on";
        setFleetViewEnabled(enabled);
        notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "agentMentions") {
        const mode = value as AgentMentionMode;
        setAgentMentionMode(mode);
        notifyApplied(
          ctx,
          mode === "off"
            ? "Agent mentions disabled"
            : mode === "model"
              ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
              : "Agent mentions on — a mentioned agent starts here, with no model call",
        );
      } else if (id === "rememberAgents") {
        const enabled = value === "on";
        setRememberAgents(enabled);
        notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "widgetMode") {
        setWidgetMode(value as WidgetMode);
        notifyApplied(ctx, `Widget set to ${value}`);
      }
    }

    let list: SettingsList;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();

      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(id, newValue);
        },
        () => done(undefined as undefined),
      );

      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Track navigation so Enter knows the current field
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }

          // Enter on numeric field → close and prompt for typed input
          if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });

    // If a numeric field ID was returned, prompt for typed input
    if (result && NUMERIC_IDS.has(result)) {
      const current = result === "maxConcurrent"
        ? String(manager.getMaxConcurrent())
        : result === "maxConcurrentForeground"
          ? String(manager.getMaxConcurrentForeground())
          : result === "defaultMaxTurns"
            ? String(getDefaultMaxTurns() ?? 0)
            : result === "maxSubagentDepth"
              ? String(getMaxSubagentDepth())
              : result === "toolTimeoutSeconds"
                ? String(getToolTimeoutSeconds())
                : String(getGraceTurns());

      const label = result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "maxConcurrentForeground"
          ? "Max foreground concurrency (0 = unlimited)"
          : result === "defaultMaxTurns"
            ? "Default max turns (0 = unlimited)"
            : result === "maxSubagentDepth"
              ? "Nested depth (0/1 = nesting off)"
              : result === "toolTimeoutSeconds"
                ? "Tool timeout in seconds (0 = no limit)"
                : "Grace turns (1+)";

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });

  /**
   * What `/agents → Workflows` and the fleet list's `workflow` rows need from
   * here. One object, built once: both entry points open the same inspector,
   * and handing them different views of the session would let the two drift.
   */
  const workflowMenuDeps: WorkflowMenuDeps = {
    tasks: workflowTasks,
    getRecord: id => manager.getRecord(id),
    viewAgentConversation,
    // Read lazily: `currentCtx` is rebound on every session_start, and the
    // fleet list may act between sessions, when there is none.
    getCtx: () => currentCtx as unknown as ExtensionCommandContext | undefined,
  };

  fleet.setWorkflowSource(fleetWorkflows, id => openWorkflowFromFleet(id, workflowMenuDeps));
}
