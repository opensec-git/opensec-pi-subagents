/**
 * Subagents follow the parent session's project trust.
 *
 * Pi keeps a folder's `.pi/extensions` and `.pi/settings.json` off until the
 * user trusts it. A subagent builds its own resource loader and settings
 * manager, so it has to be handed that decision; left to their defaults, both
 * assume trust. Faux model, throwaway folders, no network.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { agentCall, agentToolResults, type FauxResponder, runPrintMode } from "./helpers/print-mode-runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The opt-in to trust every project, in the run's global subagents.json; the default, "pi", follows Pi. */
function trustEveryProject(): void {
  writeFileSync(join(getAgentDir(), "subagents.json"), JSON.stringify({ projectTrust: "full" }));
}

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "trust-e2e-"));
  dirs.push(cwd);
  return cwd;
}

/** A project extension that logs when it loads and registers `probe_tool`. */
function addProjectExtension(cwd: string): string {
  const marker = join(cwd, "EXT_LOADED.log");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "extensions", "probe.ts"),
    `import { appendFileSync } from "node:fs";
export default function (pi: any) {
  appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
  pi.registerTool({ name: "probe_tool", label: "probe", description: "probe", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "probe ran" }] }; } });
}
`,
  );
  return marker;
}

const isParent = (tools: Array<{ name: string }> | undefined) => (tools ?? []).some((t) => t.name === "Agent");
const hasToolResult = (messages: Array<{ role: string }>) => messages.some((m) => m.role === "toolResult");

describe("subagents and project trust", () => {
  it("with projectTrust: full a child loads the project's .pi/extensions even when the parent does not trust it", async () => {
    const cwd = project();
    addProjectExtension(cwd);
    let childTools: string[] | undefined;
    const respond: FauxResponder = (context) => {
      if (isParent(context.tools)) {
        return hasToolResult(context.messages)
          ? "parent done"
          : agentCall({ prompt: "look around", description: "trust probe", run_in_background: false });
      }
      childTools ??= (context.tools ?? []).map((t) => t.name);
      return "child done";
    };

    const run = await runPrintMode({ cwd, prompt: "go", respond, projectTrusted: false, beforeRun: trustEveryProject });
    await run.dispose();

    expect(childTools).toContain("probe_tool");
  }, 60_000);

  for (const trusted of [false, true]) {
    it(`a child loads the project's .pi/extensions only when the parent trusts the project (trusted: ${trusted})`, async () => {
      const cwd = project();
      const marker = addProjectExtension(cwd);
      let childTools: string[] | undefined;
      const respond: FauxResponder = (context) => {
        if (isParent(context.tools)) {
          return hasToolResult(context.messages)
            ? "parent done"
            : agentCall({ prompt: "look around", description: "trust probe", run_in_background: false });
        }
        childTools ??= (context.tools ?? []).map((t) => t.name);
        return "child done";
      };

      const run = await runPrintMode({ cwd, prompt: "go", respond, projectTrusted: trusted });
      await run.dispose();

      expect(childTools).toBeDefined();
      if (trusted) {
        expect(childTools).toContain("probe_tool");
      } else {
        expect(childTools).not.toContain("probe_tool");
        // Neither the parent nor the child ran the extension's code.
        expect(existsSync(marker)).toBe(false);
      }
    }, 60_000);

    it(`an isolated child applies the project's shellCommandPrefix only when trusted (trusted: ${trusted})`, async () => {
      const cwd = project();
      const marker = join(cwd, "PREFIX_RAN");
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: `echo ran >> '${marker}'` }));
      const respond: FauxResponder = (context) => {
        if (isParent(context.tools)) {
          return hasToolResult(context.messages)
            ? "parent done"
            : agentCall({ prompt: "run it", description: "prefix probe", isolated: true, run_in_background: false });
        }
        return hasToolResult(context.messages) ? "child done" : fauxToolCall("bash", { command: "echo child" });
      };

      const run = await runPrintMode({ cwd, prompt: "go", respond, projectTrusted: trusted });
      await run.dispose();

      const ran = existsSync(marker) ? readFileSync(marker, "utf-8").trim().split("\n").length : 0;
      expect(ran).toBe(trusted ? 1 : 0);
    }, 60_000);
  }
});

describe("the extension's own project files and project trust", () => {
  // Pi's decision, and whether the user trusted the folder (Pi's prompt or
  // /trust): Pi trusts a folder holding only agent files without asking, which
  // is not the user agreeing to its agents.
  const agentFileCases = [
    { name: "untrusted by Pi", trusted: false, recorded: true, loads: false },
    { name: "trusted by Pi without asking", trusted: true, recorded: false, loads: false },
    { name: "trusted by the user", trusted: true, recorded: true, loads: true },
  ];
  for (const { name, trusted, recorded, loads } of agentFileCases) {
    it(`a project agent file is used only in a project the user trusted (${name})`, async () => {
      const cwd = project();
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "agents", "helper.md"), "---\ndescription: helper\n---\nHELPER-PROMPT-MARKER");
      let childPrompt: string | undefined;
      const respond: FauxResponder = (context) => {
        if (isParent(context.tools)) {
          return hasToolResult(context.messages)
            ? "parent done"
            : agentCall({ prompt: "help", description: "agent file probe", subagent_type: "helper", run_in_background: false });
        }
        childPrompt ??= context.systemPrompt ?? "";
        return "child done";
      };

      const run = await runPrintMode({ cwd, prompt: "go", respond, projectTrusted: trusted, trustRecorded: recorded });
      const results = agentToolResults(run.parentSession).join("\n");
      await run.dispose();

      expect(childPrompt).toBeDefined();
      if (loads) {
        expect(childPrompt).toContain("HELPER-PROMPT-MARKER");
      } else {
        expect(childPrompt).not.toContain("HELPER-PROMPT-MARKER");
        expect(results).toMatch(/Unknown agent type "helper"/);
        expect(results).toMatch(/not trusted in Pi/);
        expect(results).toMatch(/\/trust/);
      }
    }, 60_000);
  }

  it("with projectTrust: full a project agent file is used in a project nobody trusted", async () => {
    const cwd = project();
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "helper.md"), "---\ndescription: helper\n---\nHELPER-PROMPT-MARKER");
    let childPrompt: string | undefined;
    const respond: FauxResponder = (context) => {
      if (isParent(context.tools)) {
        return hasToolResult(context.messages)
          ? "parent done"
          : agentCall({ prompt: "help", description: "agent file probe", subagent_type: "helper", run_in_background: false });
      }
      childPrompt ??= context.systemPrompt ?? "";
      return "child done";
    };

    const run = await runPrintMode({
      cwd, prompt: "go", respond, projectTrusted: false, trustRecorded: false, beforeRun: trustEveryProject,
    });
    await run.dispose();

    expect(childPrompt).toContain("HELPER-PROMPT-MARKER");
  }, 60_000);

  for (const recorded of [false, true]) {
    it(`a project agent's extension path loads only once the project is recorded as trusted (recorded: ${recorded})`, async () => {
      // Nothing here is gated by Pi, so Pi trusts the folder without asking —
      // which is not consent to use its agent files or run the code they point at.
      const cwd = project();
      const marker = join(cwd, "EXT_LOADED.log");
      mkdirSync(join(cwd, "tools"), { recursive: true });
      writeFileSync(
        join(cwd, "tools", "probe.ts"),
        `import { appendFileSync } from "node:fs";
export default function (pi: any) {
  appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
  pi.registerTool({ name: "probe_tool", label: "probe", description: "probe", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "probe ran" }] }; } });
}
`,
      );
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "agents", "helper.md"),
        "---\ndescription: helper\nextensions: ./tools/probe.ts\n---\nYou help.",
      );
      let childTools: string[] | undefined;
      const respond: FauxResponder = (context) => {
        if (isParent(context.tools)) {
          return hasToolResult(context.messages)
            ? "parent done"
            : agentCall({ prompt: "help", description: "extension path probe", subagent_type: "helper", run_in_background: false });
        }
        childTools ??= (context.tools ?? []).map((t) => t.name);
        return "child done";
      };

      const run = await runPrintMode({
        cwd,
        prompt: "go",
        respond,
        projectTrusted: true,
        trustRecorded: false,
        beforeRun: () => {
          if (recorded) new ProjectTrustStore(getAgentDir()).set(cwd, true);
        },
      });
      await run.dispose();

      expect(childTools).toBeDefined();
      expect(childTools?.includes("probe_tool")).toBe(recorded);
      expect(existsSync(marker)).toBe(recorded);
    }, 60_000);
  }
});
