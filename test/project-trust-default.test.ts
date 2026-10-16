import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProjectCodeTrusted, isProjectTrustedBy, predictProjectTrust } from "../src/project-trust.js";
import { globalProjectTrustMode } from "../src/settings.js";

// `projectTrust` in the global subagents.json: "full" (the default) trusts every project, "pi" follows Pi's decision.
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

  it("trusts every project by default", () => {
    expect(globalProjectTrustMode()).toBe("full");
    expect(isProjectTrustedBy(untrusting)).toBe(true);
    expect(predictProjectTrust(project)).toBe(true);
    expect(isProjectCodeTrusted(false, project)).toBe(true);
  });

  it("follows Pi's decision with projectTrust: \"pi\" in the global settings", () => {
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ projectTrust: "pi" }));
    expect(globalProjectTrustMode()).toBe("pi");
    expect(isProjectTrustedBy(untrusting)).toBe(false);
    expect(predictProjectTrust(project)).toBe(false);
    expect(isProjectCodeTrusted(false, project)).toBe(false);
  });

  it("ignores a project's own projectTrust", () => {
    writeFileSync(join(project, ".pi", "subagents.json"), JSON.stringify({ projectTrust: "pi" }));
    expect(globalProjectTrustMode()).toBe("full");
  });

  it("ignores an unknown value", () => {
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ projectTrust: "none" }));
    expect(globalProjectTrustMode()).toBe("full");
  });
});
