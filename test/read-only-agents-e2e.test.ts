/**
 * Explore and Plan are read-only by the tools they get, not only by their
 * prompt: no `bash`, `write` or `edit`, and no tool an extension registers.
 * Faux model, throwaway project with a write-capable project extension.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentCall, type FauxResponder, runPrintMode } from "./helpers/print-mode-runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectWithWriteTool(): string {
  const cwd = mkdtempSync(join(tmpdir(), "read-only-e2e-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "extensions", "writer.ts"),
    `export default function (pi: any) {
  pi.registerTool({ name: "write_anything", label: "write", description: "writes", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "wrote" }] }; } });
}
`,
  );
  return cwd;
}

async function childToolsOf(subagentType: string): Promise<string[]> {
  let childTools: string[] | undefined;
  const respond: FauxResponder = (context) => {
    const tools = context.tools ?? [];
    if (tools.some((t) => t.name === "Agent")) {
      return context.messages.some((m) => m.role === "toolResult")
        ? "parent done"
        : agentCall({ prompt: "look", description: "tool probe", subagent_type: subagentType, run_in_background: false });
    }
    childTools ??= tools.map((t) => t.name);
    return "child done";
  };
  const run = await runPrintMode({ cwd: projectWithWriteTool(), prompt: "go", respond, projectTrusted: true });
  await run.dispose();
  return [...(childTools ?? [])].sort();
}

describe("read-only built-in agents", () => {
  for (const type of ["Explore", "Plan"]) {
    it(`${type} gets only read-only built-ins and no extension tools, even in a trusted project`, async () => {
      expect(await childToolsOf(type)).toEqual(["find", "grep", "ls", "read"]);
    }, 60_000);
  }

  it("general-purpose still gets bash and the project's extension tools", async () => {
    const tools = await childToolsOf("general-purpose");
    expect(tools).toContain("bash");
    expect(tools).toContain("write_anything");
  }, 60_000);
});
