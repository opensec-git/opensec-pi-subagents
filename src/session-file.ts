/**
 * session-file.ts — Can an agent's saved pi session be reopened, and what did
 * it end with?
 *
 * Checked before a reopen is announced or started. Opening happens inside the
 * spawned run, so without this a missing or corrupt file surfaces only as a
 * failed agent after the UI has already said "Resuming", and an empty file
 * silently becomes a fresh conversation that has forgotten everything.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { extractText } from "./context.js";

/** Why the session file cannot be reopened, or undefined when it can. */
export function sessionFileProblem(path: string): string | undefined {
  if (!existsSync(path)) return `its session file is gone (${path})`;
  try {
    if (statSync(path).size === 0) return `its session file is empty (${path})`;
    // Throws for a non-empty file that is not a pi session.
    SessionManager.open(path);
  } catch (err) {
    return `its session file cannot be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

/** What an agent's saved session says about how its last run ended. */
export interface SavedResult {
  /** Text of the last assistant message that has any; "" when none does. */
  text: string;
  /** The provider error the final assistant message stopped on, if it did. */
  error?: string;
  /** `provider/id` the session last ran on, when it records one. */
  model?: string;
  thinking?: string;
}

/**
 * Read an agent's final result from its saved session file, for an agent whose
 * record was released from memory. Read-only: the file is parsed, never
 * opened through a SessionManager, which writes a header into an empty one.
 * Returns why it cannot be read instead, as `sessionFileProblem` words it.
 */
export function readSavedResult(path: string): SavedResult | string {
  if (!existsSync(path)) return `its session file is gone (${path})`;
  try {
    const fileEntries = parseSessionEntries(readFileSync(path, "utf-8"));
    if (fileEntries[0]?.type !== "session") return `its session file is not a pi session (${path})`;
    migrateSessionEntries(fileEntries);
    const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
    const context = buildSessionContext(entries);
    const result: SavedResult = { text: "" };
    if (context.model) result.model = `${context.model.provider}/${context.model.modelId}`;
    if (context.thinkingLevel) result.thinking = context.thinkingLevel;
    let final = true;
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const message = context.messages[i];
      if (message.role !== "assistant") continue;
      if (final && message.stopReason === "error") result.error = message.errorMessage?.trim() || "provider error with no output";
      final = false;
      const text = extractText(message.content).trim();
      if (text) {
        result.text = text;
        break;
      }
    }
    return result;
  } catch (err) {
    return `its session file cannot be read: ${err instanceof Error ? err.message : String(err)}`;
  }
}
