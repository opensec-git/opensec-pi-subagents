/**
 * The child's tool-scope check runs on every tool call (inline guard and
 * beforeToolCall) and every turn_end. Resolving an extension's package name
 * climbs the tree reading package.json, so it must happen once per extension,
 * not once per check. Own file: the node:fs mock applies to the module graph.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const reads: string[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = (...args: unknown[]) => {
    reads.push(String(args[0]));
    return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
  };
  const wrapped = { ...actual, readFileSync };
  return { ...wrapped, default: wrapped };
});

const { installExtensionToolScope } = await import("../src/agent-runner.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "scope-cache-"));
  const pkgDir = join(root, "my-ext");
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@scope/my-ext", pi: { extensions: ["./src/index.ts"] } }));
  const extPath = join(pkgDir, "src", "index.ts");
  writeFileSync(extPath, "");
  const otherPath = join(root, "other", "index.ts"); // no manifest anywhere: climbs to /

  const listeners: ((e: { type: string }) => void)[] = [];
  let active: string[] = [];
  const session: any = {
    getAllTools: () => ["read", "ext_tool", "other_tool"].map(name => ({ name })),
    getActiveToolNames: () => active,
    setActiveToolsByName: (names: string[]) => { active = names; },
    subscribe: (l: (e: { type: string }) => void) => { listeners.push(l); return () => {}; },
    agent: {},
  };
  const loader: any = {
    getExtensions: () => ({
      extensions: [
        { path: extPath, tools: new Map([["ext_tool", {}]]) },
        { path: otherPath, tools: new Map([["other_tool", {}]]) },
      ],
    }),
  };
  return { session, loader, emit: (type: string) => { for (const l of listeners) l({ type }); }, active: () => active };
}

describe("installExtensionToolScope", () => {
  it("reads each extension's manifest once, however many tool calls follow", async () => {
    const { session, loader, emit, active } = setup();
    reads.length = 0;
    installExtensionToolScope(session, {
      loader,
      toolNames: ["read"],
      disallowedSet: undefined,
      extNames: new Set(["my-ext"]), // matched by package name (#143), so the manifest is needed
      narrowing: new Map(),
      readmitToolNames: new Set(),
    });
    const afterInstall = reads.filter(r => r.endsWith("package.json")).length;
    expect(afterInstall).toBeGreaterThan(0);
    expect(active()).toEqual(["read", "ext_tool"]);

    const call = (name: string) => session.agent.beforeToolCall({ toolCall: { name } }, undefined);
    for (let i = 0; i < 20; i++) {
      expect(await call("ext_tool")).toBeUndefined();
      expect((await call("other_tool"))?.block).toBe(true);
      emit("turn_end");
    }

    expect(reads.filter(r => r.endsWith("package.json")).length).toBe(afterInstall);
  });
});
