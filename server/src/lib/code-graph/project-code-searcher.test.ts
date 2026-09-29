/**
 * Epic #712 / Issue #714 — production wiring for fused code retrieval.
 *
 * `createDefaultCodeSearcher` reuses `HybridCodeSearch` over a Prisma-backed
 * symbol index (BM25-only, no vector store wired yet); `createDefaultSymbolLineLookup`
 * reads authoritative `startLine`/`endLine` from `CodeSymbol`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
const aggregate = vi.hoisted(() => vi.fn());

vi.mock("../prisma.js", () => ({
  prisma: { codeSymbol: { findMany, aggregate } },
}));

import { BM25Index } from "./hybrid-search.js";
import {
  __resetSymbolIndexCache,
  createDefaultCodeSearcher,
  createDefaultSymbolLineLookup,
  prismaSymbolIndex,
} from "./project-code-searcher.js";

/** An unchanged project: same count, same newest row. */
const fingerprint = (count: number, newest = 1_000) => ({
  _count: { _all: count },
  _max: { createdAt: new Date(newest) },
});

beforeEach(() => aggregate.mockResolvedValue(fingerprint(1)));

afterEach(() => {
  findMany.mockReset();
  aggregate.mockReset();
  __resetSymbolIndexCache();
  vi.restoreAllMocks();
});

/** BM25-only searcher: no vector hit may rescue a symbol via #797 hydration. */
const lexicalOnlySearcher = () =>
  createDefaultCodeSearcher({
    vectorStore: { search: async () => [] },
    embedService: {
      embed: async () => ({ vectors: [], dimensions: 0, model: "none" }),
    } as never,
  });

const sym = (id: string, name = id) => ({
  id,
  name,
  qualifiedName: `src/${name}.ts::${name}`,
  kind: "function",
  filePath: `src/${name}.ts`,
});

describe("createDefaultCodeSearcher", () => {
  it("BM25-searches the Prisma symbol index and maps results", async () => {
    findMany.mockResolvedValue([
      {
        id: "s1",
        name: "TagValidator",
        qualifiedName: "com.etag.TagValidator",
        kind: "class",
        filePath: "src/TagValidator.java",
      },
      {
        id: "s2",
        name: "Unrelated",
        qualifiedName: "com.etag.Unrelated",
        kind: "class",
        filePath: "src/Unrelated.java",
      },
    ]);

    const searcher = createDefaultCodeSearcher();
    const results = await searcher.search("TagValidator", "p1", { limit: 5 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "p1" } }));
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.symbolId).toBe("s1");
    expect(top.filePath).toBe("src/TagValidator.java");
    expect(top.name).toBe("TagValidator");
    expect(top.kind).toBe("class");
  });

  it("#372: lexically finds a symbol whose id sorts LAST in a project larger than the old 5,000 cap", async () => {
    // 6,000 distractors plus the target, whose id sorts after every other one.
    // The mock behaves like the database: it honours `orderBy: { id: "asc" }` and
    // `take`, so a capped load drops exactly the rows a real capped load drops.
    const rows = Array.from({ length: 6000 }, (_, i) => {
      const n = String(i).padStart(5, "0");
      return {
        id: `a${n}`,
        name: `helper${n}`,
        qualifiedName: `server/src/lib/mod${n}.ts::helper${n}`,
        kind: "function",
        filePath: `server/src/lib/mod${n}.ts`,
      };
    });
    rows.push({
      id: "zzzz-last",
      name: "parseToolCall",
      qualifiedName: "server/src/lib/ai/tool-parser.ts::parseToolCall",
      kind: "function",
      filePath: "server/src/lib/ai/tool-parser.ts",
    });
    findMany.mockImplementation(async (args: { orderBy?: { id: "asc" }; take?: number }) => {
      const sorted = args.orderBy ? [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)) : rows;
      return args.take === undefined ? sorted : sorted.slice(0, args.take);
    });

    aggregate.mockResolvedValue(fingerprint(rows.length));
    // BM25-only: the lexical channel is what #372 is about.
    const results = await lexicalOnlySearcher().search("parseToolCall", "p1", { limit: 5 });

    expect(results[0]?.symbolId).toBe("zzzz-last");
    expect(results[0]?.name).toBe("parseToolCall");
  });

  it("returns [] when the project has no symbols (no code graph)", async () => {
    findMany.mockResolvedValue([]);
    const searcher = createDefaultCodeSearcher();
    expect(await searcher.search("anything", "p1")).toEqual([]);
  });
});

describe("#372 — prismaSymbolIndex caches the full symbol set per project", () => {
  it("returns the same array without reloading while the fingerprint is unchanged", async () => {
    findMany.mockResolvedValue([sym("s1")]);
    const first = await prismaSymbolIndex.getSymbols("p1");
    const second = await prismaSymbolIndex.getSymbols("p1");

    expect(second).toBe(first);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "p1" } }));
  });

  it("reloads when a file is re-parsed (same count, newest createdAt moves)", async () => {
    findMany.mockResolvedValueOnce([sym("s1")]).mockResolvedValueOnce([sym("s2")]);
    aggregate.mockResolvedValueOnce(fingerprint(1, 1_000));
    await prismaSymbolIndex.getSymbols("p1");
    aggregate.mockResolvedValueOnce(fingerprint(1, 2_000));
    const after = await prismaSymbolIndex.getSymbols("p1");

    expect(after.map((s) => s.symbolId)).toEqual(["s2"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("reloads when a symbol is deleted (count moves, newest does not)", async () => {
    findMany.mockResolvedValueOnce([sym("s1"), sym("s2")]).mockResolvedValueOnce([sym("s1")]);
    aggregate.mockResolvedValueOnce(fingerprint(2));
    await prismaSymbolIndex.getSymbols("p1");
    aggregate.mockResolvedValueOnce(fingerprint(1));
    const after = await prismaSymbolIndex.getSymbols("p1");

    expect(after.map((s) => s.symbolId)).toEqual(["s1"]);
  });

  it("keeps projects apart", async () => {
    findMany.mockImplementation(async ({ where }: { where: { projectId: string } }) => [
      sym(`${where.projectId}-sym`),
    ]);
    expect((await prismaSymbolIndex.getSymbols("p1"))[0].symbolId).toBe("p1-sym");
    expect((await prismaSymbolIndex.getSymbols("p2"))[0].symbolId).toBe("p2-sym");
    expect((await prismaSymbolIndex.getSymbols("p1"))[0].symbolId).toBe("p1-sym");
  });

  it("evicts the least recently used project beyond four", async () => {
    findMany.mockImplementation(async ({ where }: { where: { projectId: string } }) => [
      sym(`${where.projectId}-sym`),
    ]);
    for (const p of ["p1", "p2", "p3", "p4"]) await prismaSymbolIndex.getSymbols(p);
    await prismaSymbolIndex.getSymbols("p1"); // p1 is now the most recent; p2 the least
    await prismaSymbolIndex.getSymbols("p5"); // evicts p2
    findMany.mockClear();

    await prismaSymbolIndex.getSymbols("p1");
    expect(findMany).not.toHaveBeenCalled();
    await prismaSymbolIndex.getSymbols("p2");
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("builds the BM25 index once across per-call searchers while nothing changed", async () => {
    findMany.mockResolvedValue([sym("s1", "parseToolCall"), sym("s2", "other")]);
    const build = vi.spyOn(BM25Index.prototype, "build");

    const a = await lexicalOnlySearcher().search("parseToolCall", "p1");
    const b = await lexicalOnlySearcher().search("parseToolCall", "p1");

    expect(a[0].symbolId).toBe("s1");
    expect(b[0].symbolId).toBe("s1");
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("createDefaultSymbolLineLookup", () => {
  it("resolves authoritative line spans from CodeSymbol", async () => {
    findMany.mockResolvedValue([{ id: "s1", filePath: "src/A.ts", startLine: 10, endLine: 42 }]);
    const lookup = createDefaultSymbolLineLookup();
    const map = await lookup.resolve(["s1"], "p1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["s1"] }, projectId: "p1" } }),
    );
    expect(map.get("s1")).toEqual({ filePath: "src/A.ts", startLine: 10, endLine: 42 });
  });

  it("short-circuits on an empty id list without querying", async () => {
    const lookup = createDefaultSymbolLineLookup();
    const map = await lookup.resolve([], "p1");
    expect(map.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
