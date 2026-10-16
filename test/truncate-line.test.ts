/**
 * truncateLine reads only the start of a streamed response; it must return
 * exactly what splitting the whole text did.
 */
import { describe, expect, it } from "vitest";
import { describeActivity, truncateLine } from "../src/ui/agent-widget.js";

/** The previous implementation, verbatim. */
function reference(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe("truncateLine", () => {
  it("matches the split-based result on edge cases", () => {
    const cases = [
      "", "   ", "\n\n", "a", "  a  ", "\n  hello  \nworld",
      "x".repeat(60), "x".repeat(61), ` ${"x".repeat(60)} `, `${"x".repeat(60)}    \nnext`,
      `${"x".repeat(59)} y`, `${"x".repeat(60)} y`, `${"x".repeat(60)}\t\t\t\t`, `${"x".repeat(60)}      z`,
      "abc\r\ndef", "\r\n\r\n  title\r\n", "   lead", `\t\t${"y".repeat(200)}`, "a b",
    ];
    for (const text of cases) {
      for (const len of [0, 1, 5, 60]) expect(truncateLine(text, len), JSON.stringify([text, len])).toBe(reference(text, len));
    }
  });

  it("matches the split-based result on random text", () => {
    const next = rng(42);
    const alphabet = ["a", "b", " ", "\n", "\t", "\r", " ", "xyz", "  \n  "];
    for (let n = 0; n < 5000; n++) {
      let text = "";
      const size = Math.floor(next() * 120);
      for (let i = 0; i < size; i++) text += alphabet[Math.floor(next() * alphabet.length)];
      const len = Math.floor(next() * 70);
      expect(truncateLine(text, len), JSON.stringify([text, len])).toBe(reference(text, len));
    }
  });

  it("feeds describeActivity unchanged", () => {
    expect(describeActivity(new Map(), "\n\n  The answer begins here  \nmore")).toBe("The answer begins here");
    expect(describeActivity(new Map(), "   ")).toBe("thinking…");
  });
});
