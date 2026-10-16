/**
 * session-file.ts — Can an agent's saved pi session be reopened?
 *
 * Checked before a reopen is announced or started. Opening happens inside the
 * spawned run, so without this a missing or corrupt file surfaces only as a
 * failed agent after the UI has already said "Resuming", and an empty file
 * silently becomes a fresh conversation that has forgotten everything.
 */

import { existsSync, statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

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
