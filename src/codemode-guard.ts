// Guards for pi's built-in `codemode` tool (a model-written script that calls other tools).
//
// - A deadline: codemode scripts run with no time limit unless the script's first line sets
//   `timeout_ms` (`// @options: {"timeout_ms": …}`), so one stuck call held the agent forever.
//   Scripts that set none get `codemodeTimeoutSeconds` (default 30 minutes).
// - An audit trail: only the script's own output reaches the model, so a wrong filter can make
//   a real hit look like "0 matches" with no trace. The raw output of every call a script makes
//   is written to disk, and the script's result says where, and that it is not proof of absence.

import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, type ToolResultEvent, type ToolResultEventResult } from "@earendil-works/pi-coding-agent";

export const CODEMODE_TOOL_NAME = "codemode";
const OPTIONS_PREFIX = "// @options:";
/** Largest `timeout_ms` codemode accepts (the `setTimeout` limit). */
const MAX_TIMEOUT_MS = 2_147_483_647;
export const CODEMODE_TIMEOUT_CEILING = 86_400;

let codemodeTimeoutSeconds = 1800;

/** Deadline in seconds given to codemode scripts that set none (0 = leave them unbounded). */
export function getCodemodeTimeoutSeconds(): number { return codemodeTimeoutSeconds; }
export function setCodemodeTimeoutSeconds(n: number): void {
  codemodeTimeoutSeconds = Math.min(CODEMODE_TIMEOUT_CEILING, Math.max(0, Math.floor(n)));
}

/**
 * Give a codemode call a `timeout_ms` when its script sets none. Pi executes the same input
 * object the `tool_call` handlers receive, so this changes the running script.
 *
 * - No options line: one is added. Line numbers in script errors then count from 2.
 * - An options line without `timeout_ms`: the field is added to it.
 * - An options line that sets `timeout_ms`, or that is not a JSON object: left as it is
 *   (codemode itself reports a malformed line to the model).
 */
export function boundCodemodeTimeout(input: unknown, seconds: number): void {
  if (seconds <= 0 || !input || typeof input !== "object") return;
  const call = input as { code?: unknown };
  if (typeof call.code !== "string" || call.code.trim() === "") return;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, seconds * 1000);
  const code = call.code;
  const newline = code.indexOf("\n");
  const firstLine = (newline === -1 ? code : code.slice(0, newline)).replace(/\r$/, "");
  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith(OPTIONS_PREFIX)) {
    call.code = `${OPTIONS_PREFIX} ${JSON.stringify({ timeout_ms: timeoutMs })}\n${code}`;
    return;
  }
  let options: unknown;
  try {
    options = JSON.parse(trimmed.slice(OPTIONS_PREFIX.length).trim());
  } catch {
    return;
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) return;
  if ((options as Record<string, unknown>).timeout_ms !== undefined) return;
  const rest = newline === -1 ? "" : code.slice(newline);
  call.code = `${OPTIONS_PREFIX} ${JSON.stringify({ ...(options as object), timeout_ms: timeoutMs })}${rest}`;
}

/** Default cap on one script's audit log; set `PI_CODEMODE_AUDIT_MAX_BYTES` to change it. */
export const DEFAULT_AUDIT_MAX_BYTES = 16 * 1024 * 1024;

function auditMaxBytes(): number {
  const n = Number(process.env.PI_CODEMODE_AUDIT_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AUDIT_MAX_BYTES;
}

/** Where raw outputs of codemode script calls are kept: `PI_CODEMODE_AUDIT_DIR`, else `<agent dir>/opensec/codemode`. */
export function codemodeAuditRoot(): string {
  const configured = process.env.PI_CODEMODE_AUDIT_DIR?.trim();
  return configured ? resolve(configured) : join(getAgentDir(), "opensec", "codemode");
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-");

interface ToolCallLike {
  toolName: string;
  toolCallId: string;
}
interface HandlerCtx { sessionManager?: { getSessionId?: () => string } }

export interface CodemodeAudit {
  /** Call from the session's (single) `tool_call` handler for every call that is allowed to run. */
  recordCall(event: ToolCallLike, ctx?: HandlerCtx): void;
  /** Register as a `tool_result` handler. */
  onToolResult(event: ToolResultEvent): ToolResultEventResult | undefined;
}

/**
 * What a script received from one call. A script gets a tool's structured result when it has one:
 * for `bash`, `structuredContent.output` holds up to 1 MiB, where the text the model would see from
 * a direct call stops at 50 KB / 2,000 lines. So log the structured output when there is one, and
 * any path pi wrote the complete output to.
 */
function rawOutput(event: ToolResultEvent): { body: string; meta: string[] } {
  const meta: string[] = [];
  const structured = event.structuredContent;
  let body: string | undefined;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const record = structured as Record<string, unknown>;
    if (typeof record.output === "string") {
      body = record.output;
      if (record.exit_code !== undefined) meta.push(`exit_code: ${String(record.exit_code)}`);
      if (record.truncated === true) meta.push("truncated: true (the script got the first and last 512 KiB)");
      if (typeof record.full_output_path === "string") meta.push(`full output: ${record.full_output_path}`);
    } else {
      meta.push(`structured: ${JSON.stringify(structured)}`);
    }
  } else if (structured !== undefined) {
    meta.push(`structured: ${JSON.stringify(structured)}`);
  }
  const details = (event as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const fullOutputPath = (details as { fullOutputPath?: unknown }).fullOutputPath;
    if (typeof fullOutputPath === "string" && !meta.some((m) => m.endsWith(fullOutputPath))) {
      meta.push(`full output: ${fullOutputPath}`);
    }
  }
  if (body === undefined) {
    body = (event.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  }
  return { body, meta };
}

/**
 * The audit trail for one session. Every call a codemode script makes (a `tool_result` with a
 * `parentToolCallId`) is appended to `<root>/<session>/<script call id>.log`, and the script's own
 * result gets a line naming that file. Each script's log is capped (`PI_CODEMODE_AUDIT_MAX_BYTES`,
 * default 16 MiB); past the cap only call headers are written. A write failure never fails a
 * tool call; the note then says the raw outputs could not be saved.
 */
export function createCodemodeAudit(): CodemodeAudit {
  const scripts = new Map<string, { file: string; calls: number; bytes: number; capped: boolean; failed?: string }>();

  const recordCall = (event: ToolCallLike, ctx?: HandlerCtx): void => {
    if (event.toolName !== CODEMODE_TOOL_NAME) return;
    const session = safe(ctx?.sessionManager?.getSessionId?.() ?? "session");
    scripts.set(event.toolCallId, {
      file: join(codemodeAuditRoot(), session, `${safe(event.toolCallId)}.log`),
      calls: 0,
      bytes: 0,
      capped: false,
    });
  };

  const onToolResult = (event: ToolResultEvent): ToolResultEventResult | undefined => {
    if (event.parentToolCallId) {
      const script = scripts.get(event.parentToolCallId);
      if (!script) return undefined;
      script.calls += 1;
      const { body, meta } = rawOutput(event);
      const head = [
        `===== call ${script.calls}: ${event.toolName} (${event.toolCallId})${event.isError ? " ERROR" : ""}`,
        `input: ${JSON.stringify(event.input ?? {})}`,
        ...meta,
      ].join("\n");
      const max = auditMaxBytes();
      let entry: string;
      if (script.capped) {
        entry = `${head}\n[output not saved: log cap of ${max} bytes reached]\n\n`;
      } else {
        entry = `${head}\n${body}\n\n`;
        const size = Buffer.byteLength(entry);
        if (script.bytes + size > max) {
          const room = Math.max(0, max - script.bytes - Buffer.byteLength(head) - 200);
          const kept = Buffer.from(body).subarray(0, room).toString();
          entry = `${head}\n${kept}\n[log cap of ${max} bytes reached: the rest of this output and later outputs are not saved]\n\n`;
          script.capped = true;
        }
      }
      script.bytes += Buffer.byteLength(entry);
      try {
        mkdirSync(join(script.file, ".."), { recursive: true, mode: 0o700 });
        appendFileSync(script.file, entry, { mode: 0o600 });
      } catch (error) {
        script.failed ??= String((error as { code?: string })?.code ?? error);
      }
      return undefined;
    }
    if (event.toolName !== CODEMODE_TOOL_NAME) return undefined;
    const script = scripts.get(event.toolCallId);
    scripts.delete(event.toolCallId);
    if (!script || script.calls === 0) return undefined;
    const where = script.failed
      ? `could not be saved (${script.failed})`
      : `are in ${script.file}${script.capped ? " (cut off at the log size cap)" : ""}`;
    const note = `[Raw outputs of this script's ${script.calls} tool call${script.calls === 1 ? "" : "s"} ${where}. `
      + "The script's printed output is filtered: it is not proof that something is absent. "
      + "Before concluding absence, check the raw outputs or print the pattern, scope and count.]";
    return {
      content: [...(event.content ?? []), { type: "text", text: note }],
      // Replacing content alone would drop the script's structured result.
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
    };
  };

  return { recordCall, onToolResult };
}
