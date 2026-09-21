/**
 * Epic #712 / Issue #713 — search_code_symbols tool unit tests.
 *
 * Fully mocked: no live embedder, LanceDB table, or Prisma. The searcher +
 * line-lookup seams are injected so the tool's rendering, scoping, no-op, and
 * validation contracts are exercised in isolation.
 */
import { describe, expect, it, vi } from "vitest";
import { createSearchSymbolsTool } from "./search-symbols.js";
import type {
  FusedCodeSearcher,
  RawCodeSymbolHit,
  SymbolLineLookup,
} from "../../rag/fused-code-context.js";
import type { ToolContext } from "./types.js";

const CTX: ToolContext = { projectId: "proj-1" };

function mockSearcher(hits: RawCodeSymbolHit[]): FusedCodeSearcher {
  return { search: vi.fn(async () => hits) };
}

function mockLineLookup(
  spans: Record<string, { filePath: string; startLine: number; endLine: number }>,
): SymbolLineLookup {
  return {
    resolve: vi.fn(async () => new Map(Object.entries(spans))),
  };
}

describe("search_code_symbols tool", () => {
  it("renders ranked hits with authoritative filePath:startLine-endLine locators", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "denorm/a.ts", name: "parseTag", kind: "function", score: 0.9 },
      { symbolId: "s2", filePath: "denorm/b.ts", name: "TagStore", kind: "class", score: 0.5 },
    ]);
    const lineLookup = mockLineLookup({
      s1: { filePath: "src/etag/parse.ts", startLine: 10, endLine: 40 },
      s2: { filePath: "src/etag/store.ts", startLine: 5, endLine: 88 },
    });
    const tool = createSearchSymbolsTool({ searcher, lineLookup });

    const res = await tool.execute({ query: "parse tag" }, CTX);

    // Locators come from CodeSymbol spans, not the searcher's denormalised path.
    expect(res.content).toContain("function parseTag — src/etag/parse.ts:10-40");
    expect(res.content).toContain("class TagStore — src/etag/store.ts:5-88");
    expect(res.truncated).toBe(false);
  });

  it("scopes the search + line lookup to the tool context's projectId", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "a.ts", name: "f", kind: "function", score: 1 },
    ]);
    const lineLookup = mockLineLookup({
      s1: { filePath: "a.ts", startLine: 1, endLine: 2 },
    });
    const tool = createSearchSymbolsTool({ searcher, lineLookup });

    await tool.execute({ query: "f" }, { projectId: "proj-XYZ" });

    expect(searcher.search).toHaveBeenCalledWith("f", "proj-XYZ", { limit: 15 });
    expect(lineLookup.resolve).toHaveBeenCalledWith(["s1"], "proj-XYZ");
  });

  it("returns a clean no-op message (not an error) when the code graph is empty", async () => {
    const searcher = mockSearcher([]);
    const lineLookup = mockLineLookup({});
    const tool = createSearchSymbolsTool({ searcher, lineLookup });

    const res = await tool.execute({ query: "anything" }, CTX);

    expect(res.content).toBe("No matching code symbols found in this project's code graph.");
    expect(lineLookup.resolve).not.toHaveBeenCalled();
  });

  it("rejects a missing/empty query without touching the searcher", async () => {
    const searcher = mockSearcher([]);
    const tool = createSearchSymbolsTool({ searcher, lineLookup: mockLineLookup({}) });

    const res = await tool.execute({ query: "   " }, CTX);

    // #774 — the rejection now names the param AND the keys that arrived, so the
    // model can repair its next call instead of re-emitting the same shape.
    expect(res.content).toMatch(/requires "query"/);
    expect(res.content).toContain("received keys: [query]");
    expect(searcher.search).not.toHaveBeenCalled();
  });

  it("clamps the limit to 1..30 and flags truncation at the cap", async () => {
    const hits: RawCodeSymbolHit[] = Array.from({ length: 30 }, (_, i) => ({
      symbolId: `s${i}`,
      filePath: `f${i}.ts`,
      name: `n${i}`,
      kind: "function",
      score: 1,
    }));
    const searcher = mockSearcher(hits);
    const spans = Object.fromEntries(
      hits.map((h) => [h.symbolId, { filePath: h.filePath, startLine: 1, endLine: 2 }]),
    );
    const tool = createSearchSymbolsTool({ searcher, lineLookup: mockLineLookup(spans) });

    const res = await tool.execute({ query: "x", limit: 999 }, CTX);

    expect(searcher.search).toHaveBeenCalledWith("x", "proj-1", { limit: 30 });
    expect(res.truncated).toBe(true);
  });

  it("includes and trims snippets, and falls back to filePath when no span resolves", async () => {
    const bigSnippet = "X".repeat(1000);
    const searcher = mockSearcher([
      {
        symbolId: "s1",
        filePath: "a.ts",
        name: "f",
        kind: "function",
        score: 1,
        snippet: bigSnippet,
      },
      { symbolId: "s2", filePath: "orphan.ts", name: "g", kind: "method", score: 0.2 },
    ]);
    // s2 has no resolved span → render falls back to the searcher's filePath.
    const tool = createSearchSymbolsTool({
      searcher,
      lineLookup: mockLineLookup({ s1: { filePath: "a.ts", startLine: 1, endLine: 9 } }),
    });

    const res = await tool.execute({ query: "f" }, CTX);

    expect(res.content).toContain("function f — a.ts:1-9");
    expect(res.content).toContain("method g — orphan.ts");
    // Snippet trimmed to 400 chars.
    expect(res.content).not.toContain("X".repeat(401));
    expect(res.content).toContain("X".repeat(400));
  });

  it("exposes the expected tool name and a required query parameter", () => {
    const tool = createSearchSymbolsTool({
      searcher: mockSearcher([]),
      lineLookup: mockLineLookup({}),
    });
    expect(tool.name).toBe("search_code_symbols");
    expect(tool.parameters.required).toContain("query");
  });
});
