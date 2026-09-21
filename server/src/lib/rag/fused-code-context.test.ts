/**
 * Epic #712 / Issue #714 — fused code-graph retrieval helper.
 *
 * Covers the guarantees the chat + Spec-Kit call sites rely on:
 *   (a) fused merge renders a `filePath:startLine-endLine` locator per hit;
 *   (b) dedupe removes symbol hits already covered by a RAG doc chunk
 *       (`connector:repo:<connectorId>:src/<relPath>`), whole-file and by line;
 *   (c) flag-off ⇒ empty result AND the searcher is never queried;
 *   (d) budget cap ⇒ symbol hits are truncated (never the RAG chunks);
 *   (e) a project without a built code graph ⇒ clean no-op (no throw).
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildFusedCodeBlock,
  extractRepoRelPath,
  fuseCodeContext,
  type FusedCodeSearcher,
  type FusedRagChunkRef,
  type FusedSymbolHit,
  type RawCodeSymbolHit,
  type SymbolLineLookup,
} from "./fused-code-context.js";

function hit(overrides: Partial<FusedSymbolHit> = {}): FusedSymbolHit {
  return {
    symbolId: "s1",
    filePath: "src/main/java/Foo.java",
    startLine: 10,
    endLine: 40,
    name: "Foo",
    kind: "class",
    score: 1,
    snippet: "class Foo {}",
    ...overrides,
  };
}

describe("extractRepoRelPath", () => {
  it("parses the connector:repo:<cid>:src/<relPath> source-chunk prefix", () => {
    expect(extractRepoRelPath("connector:repo:abc123:src/main/java/Foo.java")).toBe(
      "main/java/Foo.java",
    );
  });

  it("parses the lenient repo:<cid>:src/<relPath> shape", () => {
    expect(extractRepoRelPath("repo:abc123:src/a/b.ts")).toBe("a/b.ts");
  });

  it("returns null for non-source chunk filenames (docs, README, OVERVIEW)", () => {
    expect(extractRepoRelPath("connector:repo:abc123:README.md")).toBeNull();
    expect(extractRepoRelPath("some-doc.pdf")).toBeNull();
  });
});

describe("fuseCodeContext — rendering + locators (AC a)", () => {
  it("renders a filePath:startLine-endLine locator for each symbol hit", () => {
    const res = fuseCodeContext(
      [hit({ symbolId: "s1", filePath: "src/A.ts", startLine: 5, endLine: 9, name: "A" })],
      [],
      { tokenBudget: 10_000 },
    );
    expect(res.usedSymbols).toBe(1);
    expect(res.block).toContain("src/A.ts:5-9");
    expect(res.block).toContain("[1] A (class) — src/A.ts:5-9");
    // Header frames the block as untrusted reference material.
    expect(res.block).toContain("## Retrieved Code Symbols (project-scoped code graph)");
  });

  it("returns an empty block when there are no symbol hits", () => {
    expect(fuseCodeContext([], [], { tokenBudget: 10_000 })).toEqual({
      block: "",
      usedSymbols: 0,
      droppedDuplicate: 0,
      droppedBudget: 0,
      hits: [],
    });
  });

  // #729 — analysis retrieveContext consumes the structured hits instead of the
  // rendered block, so the surviving hits must mirror the block exactly.
  it("returns the surviving hits in render order, excluding deduped/budgeted drops", () => {
    const kept = hit({ symbolId: "s1", filePath: "src/A.ts", startLine: 5, endLine: 9, name: "A" });
    const dup = hit({ symbolId: "s2", filePath: "src/B.ts", name: "B" });
    const res = fuseCodeContext([kept, dup], [{ filename: "connector:repo:cid1:src/src/B.ts" }], {
      tokenBudget: 10_000,
    });
    expect(res.usedSymbols).toBe(1);
    expect(res.hits).toEqual([kept]);
  });
});

describe("fuseCodeContext — dedupe against RAG doc chunks (AC b)", () => {
  it("drops a symbol hit whose file is already a source-as-RAG chunk (whole-file)", () => {
    const ragChunks: FusedRagChunkRef[] = [
      { filename: "connector:repo:cid1:src/main/java/Foo.java" },
    ];
    const res = fuseCodeContext(
      [
        hit({ symbolId: "dup", filePath: "main/java/Foo.java" }),
        hit({ symbolId: "keep", filePath: "main/java/Bar.java", name: "Bar" }),
      ],
      ragChunks,
      { tokenBudget: 10_000 },
    );
    expect(res.droppedDuplicate).toBe(1);
    expect(res.usedSymbols).toBe(1);
    expect(res.block).toContain("Bar");
    expect(res.block).not.toContain("[1] Foo");
  });

  it("normalises leading ./ so path comparison still matches", () => {
    const res = fuseCodeContext(
      [hit({ filePath: "./a/b.ts" })],
      [{ filename: "connector:repo:cid1:src/a/b.ts" }],
      { tokenBudget: 10_000 },
    );
    expect(res.droppedDuplicate).toBe(1);
    expect(res.usedSymbols).toBe(0);
  });

  it("dedupes by line-range overlap when the RAG chunk carries a line span", () => {
    const ragChunks: FusedRagChunkRef[] = [
      { filename: "connector:repo:cid1:src/a/b.ts", lineStart: 1, lineEnd: 20 },
    ];
    const overlapping = hit({ symbolId: "ov", filePath: "a/b.ts", startLine: 15, endLine: 30 });
    const disjoint = hit({
      symbolId: "dis",
      filePath: "a/b.ts",
      startLine: 40,
      endLine: 60,
      name: "Later",
    });
    const res = fuseCodeContext([overlapping, disjoint], ragChunks, { tokenBudget: 10_000 });
    expect(res.droppedDuplicate).toBe(1);
    expect(res.usedSymbols).toBe(1);
    expect(res.block).toContain("Later");
  });

  it("does not dedupe against non-source RAG chunks (README etc.)", () => {
    const res = fuseCodeContext(
      [hit({ filePath: "main/java/Foo.java" })],
      [{ filename: "connector:repo:cid1:README.md" }],
      { tokenBudget: 10_000 },
    );
    expect(res.droppedDuplicate).toBe(0);
    expect(res.usedSymbols).toBe(1);
  });
});

describe("fuseCodeContext — token budget cap (AC d)", () => {
  it("truncates the ranked tail of symbol hits, preserving rank order", () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      hit({
        symbolId: `s${i}`,
        filePath: `src/File${i}.ts`,
        name: `Sym${i}`,
        snippet: "x".repeat(40), // ~19 tokens per rendered entry
        score: 20 - i,
      }),
    );
    // Budget (≈98-token header + a handful of entries) admits only some hits.
    const res = fuseCodeContext(hits, [], { tokenBudget: 220 });
    expect(res.usedSymbols).toBeGreaterThan(0);
    expect(res.usedSymbols).toBeLessThan(20);
    expect(res.droppedBudget).toBe(20 - res.usedSymbols);
    // Highest-ranked survives; a late one is dropped.
    expect(res.block).toContain("Sym0");
    expect(res.block).not.toContain("Sym19");
  });

  it("never exceeds the configured token budget", () => {
    const hits = Array.from({ length: 8 }, (_, i) =>
      hit({ symbolId: `s${i}`, filePath: `src/F${i}.ts`, name: `S${i}`, snippet: "y".repeat(120) }),
    );
    const budget = 200;
    const res = fuseCodeContext(hits, [], { tokenBudget: budget });
    expect(Math.ceil(res.block.length / 4)).toBeLessThanOrEqual(budget);
  });

  it("yields an empty block when even the header exceeds the budget", () => {
    const res = fuseCodeContext([hit()], [], { tokenBudget: 1 });
    expect(res.block).toBe("");
    expect(res.usedSymbols).toBe(0);
  });
});

// ── buildFusedCodeBlock orchestration ────────────────────────────────────────

function mockSearcher(results: RawCodeSymbolHit[]): FusedCodeSearcher & {
  search: ReturnType<typeof vi.fn>;
} {
  return { search: vi.fn().mockResolvedValue(results) };
}

function mockLineLookup(
  entries: Record<string, { filePath: string; startLine: number; endLine: number }>,
): SymbolLineLookup {
  return {
    resolve: vi.fn().mockResolvedValue(new Map(Object.entries(entries))),
  };
}

describe("buildFusedCodeBlock — flag off (AC c)", () => {
  it("returns an empty result AND never queries the searcher", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "src/A.ts", name: "A", kind: "class", score: 1 },
    ]);
    const lineLookup = mockLineLookup({
      s1: { filePath: "src/A.ts", startLine: 1, endLine: 9 },
    });

    const res = await buildFusedCodeBlock({
      projectId: "p1",
      query: "how does A work",
      ragChunks: [],
      enabled: false,
      tokenBudget: 1500,
      maxSymbols: 12,
      searcher,
      lineLookup,
    });

    expect(res.block).toBe("");
    expect(res.usedSymbols).toBe(0);
    expect(searcher.search).not.toHaveBeenCalled();
  });
});

describe("buildFusedCodeBlock — enabled path", () => {
  it("merges symbol hits with CodeSymbol-sourced locators", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "stale/copy.ts", name: "Widget", kind: "class", score: 2 },
    ]);
    // Authoritative lines come from the line lookup (CodeSymbol), not the hit.
    const lineLookup = mockLineLookup({
      s1: { filePath: "src/widget.ts", startLine: 12, endLine: 48 },
    });

    const res = await buildFusedCodeBlock({
      projectId: "p1",
      query: "widget",
      ragChunks: [],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      searcher,
      lineLookup,
    });

    expect(searcher.search).toHaveBeenCalledWith("widget", "p1", { limit: 12 });
    expect(res.usedSymbols).toBe(1);
    expect(res.block).toContain("src/widget.ts:12-48");
  });

  it("dedupes a symbol hit against an overlapping RAG doc chunk", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "x", name: "Dup", kind: "class", score: 2 },
      { symbolId: "s2", filePath: "y", name: "Keep", kind: "class", score: 1 },
    ]);
    const lineLookup = mockLineLookup({
      s1: { filePath: "a/dup.ts", startLine: 1, endLine: 5 },
      s2: { filePath: "a/keep.ts", startLine: 1, endLine: 5 },
    });

    const res = await buildFusedCodeBlock({
      projectId: "p1",
      query: "q",
      ragChunks: [{ filename: "connector:repo:cid:src/a/dup.ts" }],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      searcher,
      lineLookup,
    });

    expect(res.droppedDuplicate).toBe(1);
    expect(res.block).toContain("Keep");
    expect(res.block).not.toContain("Dup");
  });

  it("is a clean no-op when the project has no code graph (searcher returns [])", async () => {
    const searcher = mockSearcher([]);
    const lineLookup = mockLineLookup({});
    const res = await buildFusedCodeBlock({
      projectId: "p1",
      query: "q",
      ragChunks: [],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      searcher,
      lineLookup,
    });
    expect(res.block).toBe("");
    expect(lineLookup.resolve as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("never throws when the searcher rejects — degrades to empty", async () => {
    const searcher: FusedCodeSearcher = {
      search: vi.fn().mockRejectedValue(new Error("lance offline")),
    };
    const res = await buildFusedCodeBlock({
      projectId: "p1",
      query: "q",
      ragChunks: [],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      searcher,
      lineLookup: mockLineLookup({}),
    });
    expect(res.block).toBe("");
  });

  it("skips hits with no resolvable line span", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "x", name: "Nolines", kind: "class", score: 1 },
    ]);
    const lineLookup = mockLineLookup({}); // no entry for s1
    const res = await buildFusedCodeBlock({
      projectId: "p1",
      query: "q",
      ragChunks: [],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      searcher,
      lineLookup,
    });
    expect(res.block).toBe("");
    expect(res.usedSymbols).toBe(0);
  });

  it("returns empty (no search) for a blank query or missing project", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "x", name: "A", kind: "class", score: 1 },
    ]);
    const base = {
      ragChunks: [] as FusedRagChunkRef[],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      searcher,
      lineLookup: mockLineLookup({ s1: { filePath: "a.ts", startLine: 1, endLine: 2 } }),
    };
    expect((await buildFusedCodeBlock({ ...base, projectId: "p1", query: "   " })).block).toBe("");
    expect((await buildFusedCodeBlock({ ...base, projectId: null, query: "q" })).block).toBe("");
    expect(searcher.search).not.toHaveBeenCalled();
  });
});
