/**
 * Run the whole suite against a private temp directory, removed at the end.
 *
 * Tests and the code under test write to os.tmpdir(): mkdtemp fixtures, the
 * `pi-agent-*` worktree parents, the `pi-subagents-<uid>` transcript tree (one
 * directory per test cwd and session), Pi's own scratch files. Not every path
 * can clean up after itself — a test that fails midway, a worker that is
 * killed, product files meant to outlive a session — and they piled up in
 * $TMPDIR by the hundred per run. os.tmpdir() reads TMPDIR on every call, so
 * pointing it at a sandbox before the workers start catches all of them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const previous = process.env.TMPDIR;
  const sandbox = mkdtempSync(join(tmpdir(), "subagents-tests-"));
  process.env.TMPDIR = sandbox;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(sandbox, { recursive: true, force: true });
  };
}
