/**
 * script-file.ts — reading a workflow script from disk, safely.
 *
 * Kept apart from the runtime so `index.ts` (the `--subagents-workflow-file`
 * flag) and `saved.ts` share one reader without depending on the worker
 * runtime.
 */

import { readFileSync, statSync } from "node:fs";

/** Longest workflow script accepted, in characters (and bytes, when read from disk). */
export const MAX_SCRIPT_LENGTH = 524_288;

/**
 * Read a workflow script from `path`, refusing anything that is not a regular
 * file of plausible size.
 *
 * Checked before reading because `readFileSync` on a FIFO blocks pi's thread
 * until a writer shows up, and on `/dev/zero` (or a multi-gigabyte log named by
 * mistake) reads until memory runs out. Throws with a message fit to show.
 */
export function readWorkflowScriptFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_SCRIPT_LENGTH) {
    throw new Error(`${stat.size} bytes, over the workflow script limit of ${MAX_SCRIPT_LENGTH}`);
  }
  return readFileSync(path, "utf-8");
}
