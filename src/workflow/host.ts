/**
 * host.ts — binds a workflow run to the real `AgentManager`.
 *
 * `runtime.ts` deliberately knows nothing about this extension: its only seam is
 * the injected {@link WorkflowHost}, which is what keeps the runtime's tests
 * free of sessions, models and git. This file is the other half of that seam —
 * everything the script can reach through `agent()`, `resume` and `gate` ends up
 * here, and nowhere else.
 *
 * Four mappings carry most of the weight:
 *
 *   - **ids.** The runtime hands out its own `wf-agent-N` handles before
 *     anything spawns, because it needs a stable progress-entry identity. The
 *     manager issues a different id when the child actually starts. `records`
 *     is the translation, and it is kept for the whole run rather than cleared
 *     on completion: `resume` reaches back to a child that has already
 *     finished.
 *   - **agent type and model.** Resolved through `resolveSpawnType` and
 *     `getAgentConfig` — the same dispatch the `Agent` tool uses — so a
 *     workflow and a tool call disagree about nothing.
 *   - **failure.** A strict worktree-isolation failure throws out of
 *     `spawnAndWait`; the script must see that as an agent that failed
 *     (`{ok: false}` → `null`), not as an unhandled rejection that takes the
 *     run down.
 *   - **when a `gate` runs.** For an isolated child it cannot wait until the
 *     spawn resolves: the manager commits the worktree to a branch and deletes
 *     the copy inside the child's own settle, so by then the only tree left to
 *     run `npm test` in is the main one — which would report on code the child
 *     never wrote. So the gate runs from `onBeforeWorktreeCleanup`, inside that
 *     settle, and the verdict travels back on the spawn result. `runGate` still
 *     exists for a child that had no worktree; the runtime uses whichever of
 *     the two happened, never both.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { getAgentConfig, resolveSpawnType } from "../agent-types.js";
import { commandExec } from "../exec-tree.js";
import { isModelOverrideAllowed } from "../invocation-config.js";
import { resolveModelDetailed, unresolvedModelNote, unresolvedReason } from "../model-resolver.js";
import { checkModelScope } from "../model-scope.js";
import { isProjectCodeTrusted, isProjectTrustedBy } from "../project-trust.js";
import type { AgentRecord, ThinkingLevel } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import type { WorkflowGateResult, WorkflowHost, WorkflowSpawnResult } from "./runtime.js";
import { resolveWorkflowSource } from "./saved.js";

/**
 * Wall-clock bound on a `gate` command. Generous — a gate is routinely a test
 * suite — but not unbounded: `pi.exec` reports a timeout as `killed`, and a
 * gate that hangs forever would wedge the agent slot it is holding.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export interface WorkflowHostOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  /** The run's abort signal, so killing the workflow kills its children. */
  signal?: AbortSignal;
  /** Groups child transcripts under the parent session. */
  rootSessionId?: string;
  /**
   * The run id every child is stamped with.
   *
   * What makes them the workflow's rather than the session's: stamped children
   * are filtered out of the fleet list, the widget, the `/agents` menus and
   * `@handle` resolution, and they take no `maxConcurrent` slot. The run
   * reports for them, and it has its own concurrency cap.
   */
  workflowId?: string;
  gateTimeoutMs?: number;
}

/**
 * Where the child worked, when that directory still exists.
 *
 * The guard is not defensive padding. `cleanupWorktree` commits the child's
 * changes to a branch and *removes* the copy before `spawnAndWait` resolves, so
 * an isolated child's worktree is normally already gone by the time a result is
 * built. That is exactly why a gate cannot wait until here — it runs from
 * `onBeforeWorktreeCleanup` instead — and why this reports nothing rather than
 * a path that no longer exists: handing a stale path to a command would fail
 * every gated worktree agent with a spawn error instead of a test result.
 */
function childCwd(record: AgentRecord): string | undefined {
  // `path`, not `workPath`: a workflow spawn never passes a cwd, so the manager
  // runs the child at the copied repo's root.
  const path = record.worktree?.path;
  return path !== undefined && existsSync(path) ? path : undefined;
}

/**
 * Whether the child itself succeeded — the same condition {@link toSpawnResult}
 * turns into `ok`, read from the live record so the pre-cleanup hook can tell a
 * finished child from a failed one before the result exists.
 */
function succeeded(record: AgentRecord | undefined): boolean {
  return record?.status === "completed" || record?.status === "steered";
}

/** Translate a settled record into what the script sees. */
/**
 * The effective-configuration half of a record, in the runtime's pi-free shape.
 *
 * `AgentRecord.invocation` is the one authoritative place for it (#168); this
 * only renames the fields across the boundary. Returns undefined until the
 * child's session has reported a model, which is when any of it is knowable.
 */
function resolvedInfo(record: AgentRecord | undefined) {
  const invocation = record?.invocation;
  if (invocation?.modelName === undefined) return undefined;
  return {
    modelName: invocation.modelName,
    modelId: invocation.modelId,
    thinking: invocation.thinking,
    requestedThinking: invocation.requestedThinking,
    requestedModel: invocation.requestedModel,
  };
}

/** What a record had spent before a run, so a resumed run reports only its own. */
interface SpendBaseline {
  tokens: number;
  outputTokens: number;
  toolUses: number;
}

function spendOf(record: AgentRecord | undefined): SpendBaseline {
  return {
    tokens: record ? getLifetimeTotal(record.lifetimeUsage) : 0,
    outputTokens: record?.lifetimeUsage?.output ?? 0,
    toolUses: record?.toolUses ?? 0,
  };
}

function toSpawnResult(record: AgentRecord, baseline?: SpendBaseline): WorkflowSpawnResult {
  // The record's counters are lifetime figures — they accumulate across every
  // run of the agent — so a resume subtracts what was spent before it; the
  // runtime adds each call's figures to the run's totals and the budget.
  const tokens = getLifetimeTotal(record.lifetimeUsage) - (baseline?.tokens ?? 0);
  // Reported separately from `tokens`, which is the lifetime total. The script's
  // `budget` counts *output* tokens, as Claude Code's does — billing the input
  // and cache reads a fan-out re-sends would over-report it by an order of
  // magnitude and make the documented guards useless.
  const outputTokens = (record.lifetimeUsage?.output ?? 0) - (baseline?.outputTokens ?? 0);
  const toolCalls = record.toolUses - (baseline?.toolUses ?? 0);
  const cwd = childCwd(record);
  // Where an isolated child's work went. On its own fields: `text` may be JSON
  // the script parses, and the note on `record.result` never reaches a
  // schema'd or failed child's result otherwise.
  const wt = record.worktreeResult;
  const branch = wt?.hasChanges ? wt.branch : undefined;
  const worktreePath = wt?.hasChanges && wt.path && (wt.kept || !wt.branch) ? wt.path : undefined;
  const common = {
    ...(tokens > 0 ? { tokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(toolCalls > 0 ? { toolCalls } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
  };
  /** A failure's error, with where the child's changes went unless it already says. */
  const failure = (error: string): string => {
    const where = [
      branch !== undefined && !error.includes(branch) ? `Changes saved to branch \`${branch}\`.` : undefined,
      worktreePath !== undefined && !error.includes(worktreePath) ? `Worktree kept at \`${worktreePath}\`.` : undefined,
    ].filter(Boolean);
    return where.length > 0 ? `${error}\n\n${where.join(" ")}` : error;
  };

  if (succeeded(record)) {
    return {
      ...common,
      ok: true,
      // The schema'd payload when there is one: `result` is prose, and for a
      // worktree child it has had the branch note appended, so it would not
      // parse. A child asked for a schema that produced none never reaches
      // here — `runAgent` reports that through `failure`.
      text: record.structuredJson ?? record.result ?? "",
      ...(record.structuredRetried ? { structuredRetried: true } : {}),
    };
  }
  // "stopped" is someone reaching in and stopping this child — /agents, the
  // fleet list, a workflow abort. That is the same thing the workflows dialog's
  // skip action means, so it renders as skipped rather than failed.
  if (record.status === "stopped") {
    return { ...common, ok: false, skipped: true, error: failure(record.error ?? "Stopped.") };
  }
  return { ...common, ok: false, error: failure(record.error ?? `Agent ${record.status}.`) };
}

/** A signal that fires when either does, or whichever one exists. */
function eitherSignal(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return AbortSignal.any([a, b]);
}

/** Shell used to run a `gate` command, mirroring how a user would type it. */
const GATE_SHELL: readonly [string, string] =
  process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];

export function createWorkflowHost(deps: WorkflowHostOptions): WorkflowHost {
  const { pi, ctx, manager } = deps;
  /** Runtime agent id → the manager record it spawned. Never pruned mid-run. */
  const records = new Map<string, string>();
  /**
   * Runtime agent id → a stop for a child whose id the manager has not issued
   * yet (it is still creating its worktree). Folded into the spawn's signal, so
   * a skip or retry in that window stops the child instead of being lost.
   */
  const startupStops = new Map<string, AbortController>();
  /**
   * Model warnings already toasted — scopeModels, and an agent file's model
   * that did not resolve — so a fan-out that pins one such agent file raises
   * one notification rather than one per child. Kept for the whole run: the
   * same message is the same warning at agent 200 as it was at agent 1.
   */
  const warnedModelMessages = new Set<string>();

  /**
   * Run a gate command in `cwd`. The only place a gate is executed — `runGate`
   * and the pre-cleanup hook both come through here — so "gate passed" is
   * decided from one behaviour, whichever route the command took.
   */
  async function executeGate(command: string, cwd: string, runSignal?: AbortSignal): Promise<WorkflowGateResult> {
    const signal = eitherSignal(deps.signal, runSignal);
    // Through `commandExec`: a timeout or abort ends the command's whole
    // process tree, escalating to SIGKILL, and processes the gate leaves
    // behind are ended when it exits.
    const result = await commandExec(pi)(GATE_SHELL[0], [GATE_SHELL[1], command], {
      cwd,
      timeout: deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
      killTreeOnExit: true,
      ...(signal !== undefined ? { signal } : {}),
    });
    const output = [result.stdout, result.stderr]
      .map(stream => stream.trim())
      .filter(Boolean)
      .join("\n");
    // `pi.exec` reports a timeout as `killed` with exit code 0, so the code
    // alone would read a killed gate as a passing one.
    if (result.killed) {
      return { ok: false, output: output || `Gate command timed out: ${command}` };
    }
    return { ok: result.code === 0, output };
  }

  return {
    async spawnAgent(request) {
      const dispatch = resolveSpawnType(request.agentType);
      if (!dispatch.ok) return { ok: false, error: dispatch.message };

      // Same precedence as the Agent tool: the caller's model wins, the agent
      // definition's is next, and the parent's is the floor. A model the script
      // named and we cannot resolve (missing, or ambiguous) is an error; one the
      // definition named falls back to the parent, with a warning — the
      // script's value is the child's answer, so the note cannot go into it.
      let model = ctx.model;
      const config = getAgentConfig(dispatch.type);
      // A script's `model` and `effort` are per-call choices, ignored unless
      // the user allowed them (`allowModelOverride`): the child then runs on
      // the agent definition's model and level, else the parent's.
      const overridesAllowed = isModelOverrideAllowed();
      const requestedModel = overridesAllowed ? request.model : undefined;
      const effort = overridesAllowed ? request.effort : undefined;
      const modelInput = requestedModel ?? config?.model;
      let modelNote: string | undefined;
      if (modelInput !== undefined) {
        const resolution = resolveModelDetailed(modelInput, ctx.modelRegistry);
        if (resolution.ok) {
          model = resolution.model;
        } else if (requestedModel !== undefined) {
          return { ok: false, error: resolution.message };
        } else {
          modelNote = unresolvedModelNote(modelInput, unresolvedReason(resolution), model ?? "the parent's model");
          // Once per run and message, like the scope warning below: a fan-out
          // of one agent type would otherwise repeat it per child.
          if (!warnedModelMessages.has(modelNote)) {
            warnedModelMessages.add(modelNote);
            ctx.ui.notify(modelNote, "warning");
          }
        }
      }

      // Same scopeModels policy as the Agent tool and the nested delegation
      // tools: a script's `agent({ model })` is a runtime LLM choice, and the
      // script is written by the model, so it must not reach a model the user's
      // enabledModels list excludes. `callerSupplied` keys off `request.model`
      // and NOT `modelInput` — the latter has already absorbed the agent file's
      // own `model:`, which is user-authored config and so earns the
      // warn-and-proceed branch rather than a refusal.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: requestedModel !== undefined,
        agentLabel: config?.displayName ?? dispatch.type,
        modelInput,
      });
      // This agent's failure, not the run's — the same shape a bad agent type
      // takes above. The script sees `null` and its siblings carry on, which is
      // the difference between one refused model and a discarded fan-out.
      if (scopeVerdict.kind === "error") return { ok: false, error: scopeVerdict.message };
      if (scopeVerdict.kind === "warn" && !warnedModelMessages.has(scopeVerdict.message)) {
        warnedModelMessages.add(scopeVerdict.message);
        ctx.ui.notify(scopeVerdict.message, "warning");
      }

      /**
       * The gate's verdict, set only if the hook below actually ran the command.
       * Its presence is what stops the runtime running the gate a second time,
       * so it is set on the failure route too — a gate we tried and could not
       * complete is a failed gate, never an un-run one that then re-runs
       * against the wrong tree.
       */
      let gate: WorkflowGateResult | undefined;
      let spawnedId: string | undefined;
      // The session's signal stops the child on a kill or shutdown; the run's
      // stops it when the run ends any other way, including while it is still
      // creating its worktree, before `abortAgent` can know its id.
      const startupStop = new AbortController();
      startupStops.set(request.agentId, startupStop);
      const signal = eitherSignal(eitherSignal(deps.signal, request.signal), startupStop.signal);

      /**
       * Hand the child's EFFECTIVE configuration back to the run.
       *
       * `AgentRecord.invocation` is the one authoritative place for it (#168),
       * filled by the manager the moment the child's session exists — which is
       * before this fires, so it is populated by the time we read it. Reading it
       * rather than re-deriving "the session, else the request" is the whole
       * point of that field existing.
       */
      let sessionReady = false;
      const reportResolved = () => {
        // Called from BOTH the session hook and the spawn hook, because their
        // order is not guaranteed: the manager fires `onSpawned` after
        // `runAgent` returns, but `runAgent` decides when its own
        // `onSessionCreated` fires — synchronously, for a stub. Each fires once,
        // so the first call finds a half missing and returns, and the second is
        // the one that reports.
        if (!sessionReady || spawnedId === undefined) return;
        const info = resolvedInfo(manager.getRecord(spawnedId));
        if (info !== undefined) request.onResolved?.(info);
      };
      const command = request.gate;
      /**
       * Verify the child's work while its worktree still exists.
       *
       * The manager destroys that copy inside the child's own settle, so this
       * is the last (and only) moment at which `npm test` can mean "the code
       * this child just wrote" rather than "whatever is in the main tree".
       */
      const onBeforeWorktreeCleanup =
        command === undefined
          ? undefined
          : async (worktreePath: string): Promise<void> => {
              // A failed child's gate is never consulted — the runtime reports
              // the child's own failure — so running it would be pure cost.
              if (spawnedId === undefined || !succeeded(manager.getRecord(spawnedId))) return;
              try {
                gate = await executeGate(command, worktreePath, request.signal);
              } catch (error) {
                gate = { ok: false, output: error instanceof Error ? error.message : String(error) };
              }
            };

      try {
        const { record } = await manager.spawnAndWait(
          pi,
          ctx,
          dispatch.type,
          request.prompt,
          {
            description: request.label,
            // Same as the Agent tool: `isolated` comes off the agent definition.
            // Left out, a hermetic agent's script-spawned children loaded every
            // host extension and picked up its MCP and web tools.
            ...(config?.isolated !== undefined ? { isolated: config.isolated } : {}),
            // The stamp is what keeps this child out of the session's
            // `maxConcurrent` pool — see `occupiesPoolSlot`. The run already
            // bounds how many of its agents run at once, and counting them
            // twice would let one fan-out starve everything else the user is
            // doing. No `bypassQueue` needed: an agent outside the pool is
            // never queued behind it.
            ...(deps.workflowId !== undefined ? { workflowId: deps.workflowId } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(modelNote !== undefined ? { modelNote } : {}),
            // Validated worker-side against the same list pi accepts, so the
            // cast asserts what the boundary has already checked. Left unset,
            // the agent definition's `thinking` (then the parent's) still wins —
            // same precedence as `model` above.
            ...(effort !== undefined ? { thinkingLevel: effort as ThinkingLevel } : {}),
            // Seeded with the REQUEST, not the outcome. The manager overwrites
            // the effective half at session creation; without a seed there is
            // nothing for it to compare against, so a level pi clamped would be
            // indistinguishable from one that was honoured.
            //
            // Only the level. #182's other half — a caller parameter an agent
            // file outranked — cannot arise here: this path resolves
            // `request.model ?? config?.model`, so the script always wins and
            // therefore always got what it asked for. Seeding a `requestedModel`
            // would describe a precedence this path does not have.
            invocation: {
              ...(effort !== undefined ? { thinking: effort as ThinkingLevel } : {}),
            },
            // Fires once the child's session exists, which is where the model
            // and the clamped thinking level first become knowable.
            onSessionCreated: () => { sessionReady = true; reportResolved(); },
            ...(request.schema !== undefined ? { structuredOutput: request.schema } : {}),
            ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
            ...(signal !== undefined ? { signal } : {}),
            ...(deps.rootSessionId !== undefined ? { rootSessionId: deps.rootSessionId } : {}),
            ...(onBeforeWorktreeCleanup !== undefined ? { onBeforeWorktreeCleanup } : {}),
          },
          id => {
            spawnedId = id;
            records.set(request.agentId, id);
            // Ahead of `reportResolved`, and not folded into it: that one waits
            // for the child's session so it can name the effective model, while
            // the record id is known here and is what the inspector opens a
            // conversation on. A child that fails before its session resolves
            // would otherwise never be openable at all.
            request.onResolved?.({ recordId: id });
            reportResolved();
          },
        );
        return { ...toSpawnResult(record), ...(gate !== undefined ? { gate } : {}) };
      } catch (error) {
        // Strict worktree isolation rejects out of `awaitStartup` — the child
        // never ran. That is this agent's failure, not the run's: the script
        // sees `null` and its siblings carry on.
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (startupStops.get(request.agentId) === startupStop) startupStops.delete(request.agentId);
      }
    },

    abortAgent(agentId) {
      const id = records.get(agentId);
      if (id !== undefined) {
        manager.abort(id);
        return;
      }
      // No id yet — the child is still in startup (creating its worktree). Its
      // spawn's signal reaches it there, and the manager settles it as stopped,
      // which the script sees as skipped (and a retry re-runs).
      startupStops.get(agentId)?.abort();
    },

    async resumeAgent(agentId, prompt, onResolved, recordId) {
      // A child of this run by its run-local id; otherwise one replayed from
      // the journal, by the record it ran as — accepted only for a workflow's
      // own children, so a journal cannot reach the session's agents or a
      // nested agent's. The record may be live or only a tombstone (restored
      // after a restart), which the manager reopens from its session file.
      let id = records.get(agentId);
      if (id === undefined && recordId !== undefined) {
        const known = manager.getRecord(recordId) ?? manager.findTombstone(recordId);
        if (known?.workflowId !== undefined && known.parentAgentId === undefined) {
          id = recordId;
          records.set(agentId, id);
        }
      }
      if (id === undefined) {
        return { ok: false, error: `Cannot resume "${agentId}" — it never started.` };
      }
      let record: AgentRecord | undefined;
      // Taken before the run: the record's counters are lifetime figures, and
      // they carry over when a loaded child is reopened from its file. An
      // evicted child starts a fresh record, so there is nothing to subtract.
      const before = manager.getRecord(id);
      const baseline = spendOf(before);
      try {
        // A child evicted after it finished is reopened from its session file.
        record = await manager.resume(id, prompt, deps.signal, { pi, ctx });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (record === undefined) {
        const live = manager.getRecord(id);
        return {
          ok: false,
          error: live?.status === "running" || live?.status === "queued"
            ? `Agent ${id} is still running — it can only be resumed once its current run finishes.`
            : `Agent ${id} has no session left to resume.`,
        };
      }
      // The resumed row is built from scratch, so it has to be told the same
      // thing the first one was — the child's session already exists, so this is
      // simply read back rather than waited for. The id goes first for the same
      // reason it does on the spawn path: it is knowable even when the rest is
      // not.
      onResolved?.({ recordId: id });
      const info = resolvedInfo(record);
      if (info !== undefined) onResolved?.(info);
      return toSpawnResult(record, before !== undefined && record.id === before.id ? baseline : undefined);
    },

    /**
     * Resolve a nested `workflow()` reference. The runtime decides whether what
     * comes back is a workflow; this only finds it.
     */
    loadWorkflow(ref) {
      return resolveWorkflowSource(ref, ctx.cwd, isProjectCodeTrusted(isProjectTrustedBy(ctx), ctx.cwd));
    },

    // Reached only for a gate the spawn did not already run — a child with no
    // worktree of its own, or a host wired without the pre-cleanup hook.
    async runGate(command, gate) {
      // The child's worktree when it had one and it survived; otherwise the
      // session's own directory, which is where a non-isolated child worked.
      return await executeGate(command, gate.cwd ?? ctx.cwd, gate.signal);
    },
  };
}
