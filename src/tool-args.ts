/**
 * tool-args.ts — Repair the known ways weak models mangle this extension's tool
 * arguments, before Pi validates them against the schema.
 *
 * Wired as each tool's `prepareArguments` hook, which Pi runs on the raw
 * arguments of every call. A call that fails validation costs the parent a
 * whole turn to re-emit, and small models repeat the same mistake, so the
 * shapes below are fixed here instead of refused:
 *
 *   - the whole arguments object sent as a JSON string;
 *   - a string field holding the whole arguments object as a JSON string
 *     (`{"prompt": "{\"prompt\": \"…\", \"description\": \"…\"}"}`);
 *   - an array where a string is expected (joined);
 *   - `null` for an optional field (dropped);
 *   - `"true"` / `"5"` for a boolean or number field;
 *   - a missing or null `subagent_type` on the top-level `Agent` tool (left to
 *     the default-type policy, see {@link ToolArgShape.defaultBlank}).
 *
 * Narrow on purpose. Nothing is ever invented: a missing prompt stays missing
 * and fails validation, and a field whose JSON does not look like this tool's
 * own arguments is left as written — a prompt may legitimately contain JSON.
 */

/** Which fields of a tool's arguments hold which kind of value. */
export interface ToolArgShape {
  /** String fields. */
  strings: readonly string[];
  /** String fields whose array form is joined with newlines rather than spaces. */
  multiline?: readonly string[];
  booleans?: readonly string[];
  numbers?: readonly string[];
  /** Required fields that cannot be repaired: a `null` there stays, and fails validation. */
  required?: readonly string[];
  /**
   * Required string fields that become "" when missing or null, so the tool's
   * own policy decides what an absent value means (the `Agent` tool's
   * `subagent_type` falls back to the default type, or is refused under
   * `fallbackSubagent: none`).
   */
  defaultBlank?: readonly string[];
}

export const AGENT_ARG_SHAPE: ToolArgShape = {
  strings: ["prompt", "description", "name", "subagent_type", "model", "thinking", "resume", "isolation", "schedule"],
  multiline: ["prompt"],
  booleans: ["run_in_background", "isolated", "inherit_context"],
  numbers: ["max_turns"],
  required: ["prompt", "description"],
  defaultBlank: ["subagent_type"],
};

/**
 * The nested `Agent` tool: the same fields, but no default type — a nested
 * parent may only start the types its allowlist names, so a missing type must
 * fail rather than fall back.
 */
export const NESTED_AGENT_ARG_SHAPE: ToolArgShape = {
  strings: ["prompt", "description", "subagent_type", "model", "thinking", "resume", "isolation"],
  multiline: ["prompt"],
  booleans: ["run_in_background", "isolated", "inherit_context"],
  numbers: ["max_turns"],
  required: ["prompt", "description", "subagent_type"],
};

export const RESULT_ARG_SHAPE: ToolArgShape = {
  strings: ["agent_id"],
  booleans: ["wait", "verbose"],
  required: ["agent_id"],
};

export const STEER_ARG_SHAPE: ToolArgShape = {
  strings: ["agent_id", "message"],
  multiline: ["message"],
  required: ["agent_id", "message"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a string that is a JSON object, or undefined. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function knownKeys(shape: ToolArgShape): Set<string> {
  return new Set([...shape.strings, ...(shape.booleans ?? []), ...(shape.numbers ?? [])]);
}

/**
 * Repair `raw` for a tool with this argument shape. Returns the input itself
 * when nothing needed repair, so Pi keeps the original tool call.
 */
export function repairToolArgs(raw: unknown, shape: ToolArgShape): unknown {
  let args: unknown = raw;
  if (typeof args === "string") args = parseJsonObject(args) ?? args;
  if (!isPlainObject(args)) return raw;

  const known = knownKeys(shape);
  const out: Record<string, unknown> = { ...args };
  let changed = args !== raw;

  // A string field holding this tool's whole arguments object: lift its keys
  // out. Only when every key is one of ours and it includes the field itself,
  // so JSON that is really the prompt's content is never taken apart.
  for (const field of shape.strings) {
    const value = out[field];
    if (typeof value !== "string") continue;
    const inner = parseJsonObject(value);
    if (!inner || !(field in inner) || !Object.keys(inner).every(key => known.has(key))) continue;
    for (const [key, innerValue] of Object.entries(inner)) {
      if (key === field || out[key] === undefined || out[key] === null) out[key] = innerValue;
    }
    changed = true;
  }

  const required = new Set(shape.required ?? []);
  const multiline = new Set(shape.multiline ?? []);
  for (const field of shape.strings) {
    const value = out[field];
    if (value === null && !required.has(field)) {
      delete out[field];
      changed = true;
    } else if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" || typeof item === "number")) {
      out[field] = value.join(multiline.has(field) ? "\n" : " ");
      changed = true;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[field] = String(value);
      changed = true;
    }
  }
  for (const field of shape.defaultBlank ?? []) {
    if (out[field] === undefined || out[field] === null) {
      out[field] = "";
      changed = true;
    }
  }
  for (const field of shape.booleans ?? []) {
    const value = out[field];
    if (value === null) {
      delete out[field];
      changed = true;
    } else if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) {
      out[field] = value.trim().toLowerCase() === "true";
      changed = true;
    }
  }
  for (const field of shape.numbers ?? []) {
    const value = out[field];
    if (value === null) {
      delete out[field];
      changed = true;
    } else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      out[field] = Number(value);
      changed = true;
    }
  }
  return changed ? out : raw;
}

/**
 * A `prepareArguments` hook for this shape. The repaired value is still
 * unvalidated — Pi checks it against the schema right after — so typing it as
 * the schema's static type here is what the hook's signature asks for, not a
 * claim that it already conforms.
 */
export function argumentRepair<T>(shape: ToolArgShape): (args: unknown) => T {
  return (args) => repairToolArgs(args, shape) as T;
}
