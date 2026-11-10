/**
 * #1825 / #1891 — the key a requirement's code links are deduped on, and the
 * order that decides which row of a repeated key is kept.
 */
import { describe, expect, it } from "vitest";
import { codeLinkOrder, uniqueCodeLinks, uniqueCurrentCodeLinks } from "./code-link-key.js";

const row = (id: string, confidence: number, freshness?: string | null) => ({
  id,
  filePath: "src/a.ts",
  codeSymbolId: null as string | null,
  confidence,
  ...(freshness === undefined ? {} : { freshness }),
});

describe("codeLinkOrder (#1891)", () => {
  it("ranks by freshness tier — fresh, moved, never checked, out of date — before confidence", () => {
    const ranked = codeLinkOrder([
      row("stale", 0.95, "stale"),
      row("unverified", 0.9, "unverified"),
      row("moved", 0.2, "moved"),
      row("fresh", 0.1, "fresh"),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["fresh", "moved", "unverified", "stale"]);
  });

  it("ranks the surer first within a tier", () => {
    const ranked = codeLinkOrder([row("low", 0.3, "fresh"), row("high", 0.8, "fresh")]);
    expect(ranked.map((r) => r.id)).toEqual(["high", "low"]);
  });

  it("reads a row without the column, or with an unknown value, as never checked", () => {
    const ranked = codeLinkOrder([
      row("stale", 0.9, "stale"),
      row("missing", 0.5),
      row("null", 0.4, null),
      row("bogus", 0.3, "bogus"),
      row("unverified", 0.6, "unverified"),
      row("moved", 0.1, "moved"),
    ]);
    expect(ranked.map((r) => r.id)).toEqual([
      "moved",
      "unverified",
      "missing",
      "null",
      "bogus",
      "stale",
    ]);
  });

  it("keeps the caller's order for rows equal on both keys, and leaves its input alone", () => {
    const input = [row("b", 0.5, "fresh"), row("a", 0.5, "fresh"), row("c", 0.5, "fresh")];
    expect(codeLinkOrder(input).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(input.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});

describe("uniqueCurrentCodeLinks (#1891)", () => {
  const at = (id: string, filePath: string, confidence: number, freshness: string) => ({
    ...row(id, confidence, freshness),
    filePath,
  });

  it("keeps the more current row of a repeated key, then the surer, in the caller's order", () => {
    const kept = uniqueCurrentCodeLinks([
      at("a-stale", "src/a.ts", 0.9, "stale"),
      at("b-fresh-low", "src/b.ts", 0.8, "fresh"),
      at("a-semantic", "src/a.ts", 0.6, "unverified"),
      at("c-only", "src/c.ts", 0.5, "unverified"),
      at("b-fresh-high", "src/b.ts", 0.85, "fresh"),
    ]);
    expect(kept.map((r) => r.id)).toEqual(["a-semantic", "c-only", "b-fresh-high"]);
  });

  it("keeps the first row read when the repeats are equal on rank", () => {
    const kept = uniqueCurrentCodeLinks([
      at("first", "src/a.ts", 0.5, "fresh"),
      at("second", "src/a.ts", 0.5, "fresh"),
    ]);
    expect(kept.map((r) => r.id)).toEqual(["first"]);
  });

  it("keys on the symbol too: a file's file-level and symbol links are both kept", () => {
    const kept = uniqueCurrentCodeLinks([
      { ...at("file", "src/a.ts", 0.5, "fresh") },
      { ...at("symbol", "src/a.ts", 0.4, "fresh"), codeSymbolId: "sym-1" },
    ]);
    expect(kept.map((r) => r.id)).toEqual(["file", "symbol"]);
  });
});

describe("uniqueCodeLinks", () => {
  it("keeps the first row of each key in the caller's order", () => {
    const kept = uniqueCodeLinks([row("x", 0.1, "stale"), row("y", 0.9, "fresh")]);
    expect(kept.map((r) => r.id)).toEqual(["x"]);
  });
});
