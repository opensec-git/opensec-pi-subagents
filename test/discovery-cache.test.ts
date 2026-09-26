import type * as FS from "node:fs";
import {
  chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCustomAgents } from "../src/custom-agents.js";
import { createDiscoveryCache } from "../src/discovery-cache.js";
import { loadSettings, saveSettings } from "../src/settings.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FS>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

let root: string;
let project: string;
let agents: string;
let globalDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-discovery-cache-"));
  project = join(root, "project");
  agents = join(project, ".pi", "agents");
  globalDir = join(root, "global");
  mkdirSync(agents, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", globalDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("discovery cache invalidation", () => {
  it("reuses unchanged values but invalidates same-size edits even with restored mtime", () => {
    const path = join(root, "config");
    writeFileSync(path, "one");
    const stamp = new Date(1_700_000_000_000);
    utimesSync(path, stamp, stamp);
    const read = vi.fn((file: string) => readFileSync(file, "utf-8"));
    const cached = createDiscoveryCache(read);
    expect(cached(path)).toBe("one");
    expect(cached(path)).toBe("one");
    expect(read).toHaveBeenCalledTimes(1);
    writeFileSync(path, "two");
    utimesSync(path, stamp, stamp);
    expect(cached(path)).toBe("two");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("invalidates atomic replacement, deletion, recreation, and permissions", () => {
    const path = join(root, "config");
    writeFileSync(path, "one");
    const read = vi.fn((file: string) => readFileSync(file, "utf-8"));
    const cached = createDiscoveryCache(read);
    cached(path);
    const stamp = statSync(path);
    const replacement = join(root, "replacement");
    writeFileSync(replacement, "two");
    utimesSync(replacement, stamp.atime, stamp.mtime);
    renameSync(replacement, path);
    expect(cached(path)).toBe("two");
    chmodSync(path, 0o600);
    expect(cached(path)).toBe("two");
    expect(read).toHaveBeenCalledTimes(3);
    unlinkSync(path);
    expect(() => cached(path)).toThrow();
    writeFileSync(path, "new");
    expect(cached(path)).toBe("new");
  });

  it("does not cache failures or values modified while being read", () => {
    const path = join(root, "config");
    writeFileSync(path, "one");
    const read = vi.fn((file: string) => readFileSync(file, "utf-8"));
    const cached = createDiscoveryCache(read);
    read.mockImplementationOnce(() => { throw new Error("unreadable"); });
    expect(() => cached(path)).toThrow("unreadable");
    read.mockImplementationOnce((file) => {
      const value = readFileSync(file, "utf-8");
      writeFileSync(file, "changed");
      return value;
    });
    expect(cached(path)).toBe("one");
    expect(cached(path)).toBe("changed");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("bounds retained entries and keeps recently used values", () => {
    const paths = ["a", "b", "c"].map(name => join(root, name));
    for (const path of paths) writeFileSync(path, path);
    const read = vi.fn((file: string) => readFileSync(file, "utf-8"));
    const cached = createDiscoveryCache(read, 2);
    cached(paths[0]);
    cached(paths[1]);
    cached(paths[0]);
    cached(paths[2]);
    cached(paths[0]);
    expect(read).toHaveBeenCalledTimes(3);
    cached(paths[1]);
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe("cached agent discovery", () => {
  it("does no directory reads or agent file reads on ten unchanged reloads", () => {
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(agents, `${i}.md`), `---\nmodel: provider/model\nthinking: high\ntools: read\n---\nAgent ${i}`);
    }
    const expected = loadCustomAgents(project);
    vi.mocked(readFileSync).mockClear();
    vi.mocked(readdirSync).mockClear();
    for (let i = 0; i < 10; i++) expect(loadCustomAgents(project)).toEqual(expected);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it("rereads only the edited agent and returns fresh mutable configurations", () => {
    const path = join(agents, "review.md");
    writeFileSync(path, "---\ntools: read\nthinking: high\n---\nOriginal");
    writeFileSync(join(agents, "other.md"), "Unchanged");
    const first = loadCustomAgents(project);
    first.get("review")?.builtinToolNames.push("write");
    expect(loadCustomAgents(project).get("review")?.builtinToolNames).toEqual(["read"]);
    writeFileSync(path, "---\ntools: none\nthinking: low\nenabled: false\n---\nEdited");
    vi.mocked(readFileSync).mockClear();
    const updated = loadCustomAgents(project).get("review");
    expect(updated).toMatchObject({ systemPrompt: "Edited", thinking: "low", enabled: false, builtinToolNames: [] });
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("picks up additions, renames, removals and newly created higher-priority directories", () => {
    const globals = join(globalDir, "agents");
    mkdirSync(globals);
    writeFileSync(join(globals, "review.md"), "Global");
    expect(loadCustomAgents(project).get("review")?.systemPrompt).toBe("Global");
    const workspace = join(project, ".agents", "agents");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "review.md"), "Workspace");
    expect(loadCustomAgents(project).get("review")?.systemPrompt).toBe("Workspace");
    const path = join(agents, "review.md");
    writeFileSync(path, "Project");
    expect(loadCustomAgents(project).get("review")?.systemPrompt).toBe("Project");
    renameSync(path, join(agents, "renamed.md"));
    const renamed = loadCustomAgents(project);
    expect(renamed.get("review")?.systemPrompt).toBe("Workspace");
    expect(renamed.get("renamed")?.systemPrompt).toBe("Project");
    unlinkSync(join(agents, "renamed.md"));
    expect(loadCustomAgents(project).has("renamed")).toBe(false);
  });

  it("keeps warnings and strict errors after a cached good file becomes malformed", () => {
    const path = join(agents, "review.md");
    writeFileSync(path, "Valid");
    expect(loadCustomAgents(project).has("review")).toBe(true);
    writeFileSync(path, "---\ntools: [broken\n---\nInvalid");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadCustomAgents(project).has("review")).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(() => loadCustomAgents(project, true)).toThrow(path);
    writeFileSync(path, "Repaired");
    expect(loadCustomAgents(project, true).get("review")?.systemPrompt).toBe("Repaired");
  });

  it("isolates projects and follows changes to the global agent directory", () => {
    writeFileSync(join(agents, "review.md"), "First");
    const second = join(root, "second");
    mkdirSync(join(second, ".pi", "agents"), { recursive: true });
    writeFileSync(join(second, ".pi", "agents", "review.md"), "Second");
    expect(loadCustomAgents(project).get("review")?.systemPrompt).toBe("First");
    expect(loadCustomAgents(second).get("review")?.systemPrompt).toBe("Second");
    const alternateGlobal = join(root, "alternate");
    mkdirSync(join(alternateGlobal, "agents"), { recursive: true });
    writeFileSync(join(alternateGlobal, "agents", "personal.md"), "Personal");
    vi.stubEnv("PI_CODING_AGENT_DIR", alternateGlobal);
    expect(loadCustomAgents(project).get("personal")?.systemPrompt).toBe("Personal");
  });

  it("validates symlink targets even when the directory listing is unchanged", () => {
    const target = join(root, "target");
    writeFileSync(target, "Original");
    symlinkSync(target, join(agents, "linked.md"));
    expect(loadCustomAgents(project).get("linked")?.systemPrompt).toBe("Original");
    writeFileSync(target, "Edited target");
    expect(loadCustomAgents(project).get("linked")?.systemPrompt).toBe("Edited target");
  });
});

describe("cached subagent settings", () => {
  it("reuses parsed settings without leaking mutations, and observes writes and deletions", () => {
    writeFileSync(join(globalDir, "subagents.json"), '{"maxConcurrent":4}');
    saveSettings({ maxConcurrent: 2 }, project);
    const first = loadSettings(project);
    first.maxConcurrent = 99;
    vi.mocked(readFileSync).mockClear();
    expect(loadSettings(project).maxConcurrent).toBe(2);
    expect(readFileSync).not.toHaveBeenCalled();
    saveSettings({ maxConcurrent: 3 }, project);
    expect(loadSettings(project).maxConcurrent).toBe(3);
    unlinkSync(join(project, ".pi", "subagents.json"));
    expect(loadSettings(project).maxConcurrent).toBe(4);
  });

  it("does not retain a previously valid setting after a malformed edit", () => {
    saveSettings({ maxConcurrent: 2 }, project);
    expect(loadSettings(project).maxConcurrent).toBe(2);
    writeFileSync(join(project, ".pi", "subagents.json"), "{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSettings(project)).toEqual({});
    expect(warn).toHaveBeenCalled();
    saveSettings({ maxConcurrent: 3 }, project);
    expect(loadSettings(project).maxConcurrent).toBe(3);
  });
});
