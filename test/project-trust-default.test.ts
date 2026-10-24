import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectAgentNames } from "../src/custom-agents.js";
import { isProjectCodeTrusted, isProjectTrustedBy, predictProjectTrust } from "../src/project-trust.js";
import { globalProjectTrustMode } from "../src/settings.js";

// `projectTrust` in the global subagents.json: "pi" (the default) follows Pi's decision, "full" trusts every project.
describe("projectTrust", () => {
  let agentDir: string;
  let project: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "subagents-trust-agent-"));
    project = mkdtempSync(join(tmpdir(), "subagents-trust-project-"));
    // A project with something Pi gates, so Pi would ask before trusting it.
    mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(project, ".pi", "extensions", "x.ts"), "export default function () {}\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const untrusting = { isProjectTrusted: () => false };
  const trusting = { isProjectTrusted: () => true };

  it("follows Pi's decision by default", () => {
    expect(globalProjectTrustMode()).toBe("pi");
    expect(isProjectTrustedBy(untrusting)).toBe(false);
    expect(isProjectTrustedBy(trusting)).toBe(true);
    expect(predictProjectTrust(project)).toBe(false);
    expect(isProjectCodeTrusted(false, project)).toBe(false);
    // Trusted at Pi's prompt: the folder has gated resources, so the user decided.
    expect(isProjectCodeTrusted(true, project)).toBe(true);
  });

  it("trusts every project with projectTrust: \"full\" in the global settings", () => {
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ projectTrust: "full" }));
    expect(globalProjectTrustMode()).toBe("full");
    expect(isProjectTrustedBy(untrusting)).toBe(true);
    expect(predictProjectTrust(project)).toBe(true);
    expect(isProjectCodeTrusted(false, project)).toBe(true);
  });

  it("does not count a folder Pi trusted without asking until /trust records it", () => {
    // Only agent files: nothing Pi gates, so Pi trusts the folder without a prompt.
    const agentsOnly = mkdtempSync(join(tmpdir(), "subagents-trust-agents-only-"));
    try {
      mkdirSync(join(agentsOnly, ".pi", "agents"), { recursive: true });
      writeFileSync(join(agentsOnly, ".pi", "agents", "general-purpose.md"), "---\ndescription: x\n---\nx\n");
      expect(predictProjectTrust(agentsOnly)).toBe(true);
      expect(isProjectCodeTrusted(true, agentsOnly)).toBe(false);
      new ProjectTrustStore(agentDir).set(agentsOnly, true);
      expect(isProjectCodeTrusted(true, agentsOnly)).toBe(true);
    } finally {
      rmSync(agentsOnly, { recursive: true, force: true });
    }
  });

  it("counts --approve on Pi's command line as the user trusting the folder", () => {
    const agentsOnly = mkdtempSync(join(tmpdir(), "subagents-trust-approve-"));
    const argv = process.argv;
    try {
      mkdirSync(join(agentsOnly, ".pi", "agents"), { recursive: true });
      expect(isProjectCodeTrusted(true, agentsOnly)).toBe(false);
      for (const flag of ["--approve", "-a"]) {
        process.argv = [...argv, flag];
        expect(isProjectCodeTrusted(true, agentsOnly)).toBe(true);
        // A session that does not trust the project (say, --no-approve came last) still wins.
        expect(isProjectCodeTrusted(false, agentsOnly)).toBe(false);
      }
    } finally {
      process.argv = argv;
      rmSync(agentsOnly, { recursive: true, force: true });
    }
  });

  it("ignores a project's own projectTrust", () => {
    writeFileSync(join(project, ".pi", "subagents.json"), JSON.stringify({ projectTrust: "full" }));
    expect(globalProjectTrustMode()).toBe("pi");
  });

  it("ignores an unknown value", () => {
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ projectTrust: "none" }));
    expect(globalProjectTrustMode()).toBe("pi");
  });
});

describe("projectAgentNames", () => {
  it("lists both project agent folders by declared name, else filename, without loading them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-trust-names-"));
    try {
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "agents", "a.md"), "---\nname: reviewer\ndescription: x\n---\nx\n");
      writeFileSync(join(cwd, ".pi", "agents", "helper.md"), "---\ndescription: x\n---\nx\n");
      writeFileSync(join(cwd, ".agents", "agents", "shared.md"), "no frontmatter\n");
      expect(projectAgentNames(cwd).sort()).toEqual(["helper", "reviewer", "shared"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is empty without project agent folders", () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-trust-names-"));
    try {
      expect(projectAgentNames(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
