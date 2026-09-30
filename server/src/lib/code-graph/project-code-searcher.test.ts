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
const graphAggregate = vi.hoisted(() => vi.fn());

vi.mock("../prisma.js", () => ({
  prisma: { codeSymbol: { findMany, aggregate }, codeGraph: { aggregate: graphAggregate } },
}));

import { BM25Index, type SearchableSymbol } from "./hybrid-search.js";
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

/** #394 — the newest `CodeGraph.lastIndexedAt`, the fingerprint's backstop. */
const indexedAt = (at: number | null = 5_000) => ({
  _max: { lastIndexedAt: at === null ? null : new Date(at) },
});

beforeEach(() => {
  aggregate.mockResolvedValue(fingerprint(1));
  graphAggregate.mockResolvedValue(indexedAt());
});

afterEach(() => {
  findMany.mockReset();
  aggregate.mockReset();
  graphAggregate.mockReset();
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

const toSearchableFixture = (id: string) => ({
  symbolId: id,
  name: id,
  qualifiedName: id,
  kind: "function",
  filePath: `src/${id}.ts`,
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

  it("hands out a frozen array, so no caller can corrupt the shared caches", async () => {
    findMany.mockResolvedValue([sym("s2"), sym("s1")]);
    const symbols = await prismaSymbolIndex.getSymbols("p1");

    // #394: the type is `readonly` too, so this cast is the only way to reach the
    // runtime guard — production code cannot mutate it without one.
    const mutable = symbols as SearchableSymbol[];
    expect(() => mutable.push(toSearchableFixture("s3"))).toThrow(TypeError);
    expect(() => mutable.sort()).toThrow(TypeError);
    expect((await prismaSymbolIndex.getSymbols("p1")).map((s) => s.symbolId)).toEqual(["s2", "s1"]);
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

  it("#394: reloads when an ingest finishes although count and newest createdAt did not move", async () => {
    // A delete-k/create-k re-parse whose new rows carry the old max(createdAt)
    // (clock skew, concurrent Postgres ingests, an explicit createdAt).
    findMany.mockResolvedValueOnce([sym("s1")]).mockResolvedValueOnce([sym("s2")]);
    graphAggregate.mockResolvedValueOnce(indexedAt(5_000));
    await prismaSymbolIndex.getSymbols("p1");
    graphAggregate.mockResolvedValueOnce(indexedAt(6_000));
    const after = await prismaSymbolIndex.getSymbols("p1");

    expect(after.map((s) => s.symbolId)).toEqual(["s2"]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(graphAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p1" } }),
    );
  });

  it("#394: caches a project whose code graph was never stamped (no lastIndexedAt)", async () => {
    graphAggregate.mockResolvedValue(indexedAt(null));
    findMany.mockResolvedValue([sym("s1")]);
    const first = await prismaSymbolIndex.getSymbols("p1");

    expect(await prismaSymbolIndex.getSymbols("p1")).toBe(first);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("#394: concurrent searches on a cold cache share one load", async () => {
    const releases: Array<(rows: ReturnType<typeof sym>[]) => void> = [];
    findMany.mockImplementation(
      () => new Promise<ReturnType<typeof sym>[]>((resolve) => releases.push(resolve)),
    );

    const a = prismaSymbolIndex.getSymbols("p1");
    const b = prismaSymbolIndex.getSymbols("p1");
    // Let both reach the load before any of it resolves.
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    await new Promise((r) => setImmediate(r));
    for (const release of releases) release([sym("s1")]);
    const [first, second] = await Promise.all([a, b]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("#394: a concurrent search that sees a changed fingerprint does not reuse the older load", async () => {
    const releases: Array<(rows: ReturnType<typeof sym>[]) => void> = [];
    findMany.mockImplementation(
      () => new Promise<ReturnType<typeof sym>[]>((resolve) => releases.push(resolve)),
    );
    aggregate
      .mockResolvedValueOnce(fingerprint(1, 1_000))
      .mockResolvedValueOnce(fingerprint(1, 2_000));

    const older = prismaSymbolIndex.getSymbols("p1");
    const newer = prismaSymbolIndex.getSymbols("p1");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]([sym("old")]);
    releases[1]([sym("new")]);

    expect((await older).map((s) => s.symbolId)).toEqual(["old"]);
    expect((await newer).map((s) => s.symbolId)).toEqual(["new"]);
  });

  // PR #413 review — the older load finishing LAST must not overwrite the
  // newer entry, or the next search pays one more full findMany.
  it("#394: an older load that finishes last does not overwrite the newer cache entry", async () => {
    const releases: Array<(rows: ReturnType<typeof sym>[]) => void> = [];
    const pending = () =>
      new Promise<ReturnType<typeof sym>[]>((resolve) => releases.push(resolve));
    // Two held loads; any further load resolves at once, so a cache miss fails
    // the call-count assertion instead of hanging the test.
    findMany
      .mockImplementationOnce(pending)
      .mockImplementationOnce(pending)
      .mockResolvedValue([sym("reloaded")]);
    aggregate
      .mockResolvedValueOnce(fingerprint(1, 1_000))
      .mockResolvedValueOnce(fingerprint(1, 2_000))
      .mockResolvedValueOnce(fingerprint(1, 2_000));

    const older = prismaSymbolIndex.getSymbols("p1");
    const newer = prismaSymbolIndex.getSymbols("p1");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]([sym("new")]);
    await newer;
    releases[0]([sym("old")]);
    await older;

    const next = await prismaSymbolIndex.getSymbols("p1");
    expect(next.map((s) => s.symbolId)).toEqual(["new"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  // PR #413 panel — an older load that finishes first must not clear the
  // NEWER load's in-flight entry, or a third search on the new fingerprint runs
  // its own findMany instead of sharing the pending one.
  it("#394: an older load finishing first leaves the newer in-flight load shared", async () => {
    const releases: Array<(rows: ReturnType<typeof sym>[]) => void> = [];
    const pending = () =>
      new Promise<ReturnType<typeof sym>[]>((resolve) => releases.push(resolve));
    findMany
      .mockImplementationOnce(pending)
      .mockImplementationOnce(pending)
      .mockResolvedValue([sym("duplicate")]);
    aggregate
      .mockResolvedValueOnce(fingerprint(1, 1_000))
      .mockResolvedValueOnce(fingerprint(1, 2_000))
      .mockResolvedValueOnce(fingerprint(1, 2_000));

    const older = prismaSymbolIndex.getSymbols("p1");
    const newer = prismaSymbolIndex.getSymbols("p1");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]([sym("old")]);
    await older;

    const third = prismaSymbolIndex.getSymbols("p1");
    releases[1]([sym("new")]);
    expect((await third).map((s) => s.symbolId)).toEqual(["new"]);
    expect((await newer).map((s) => s.symbolId)).toEqual(["new"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("#394: a failed load is not shared with the next search", async () => {
    findMany.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce([sym("s1")]);

    await expect(prismaSymbolIndex.getSymbols("p1")).rejects.toThrow("db down");
    const retry = await prismaSymbolIndex.getSymbols("p1");

    expect(retry.map((s) => s.symbolId)).toEqual(["s1"]);
    expect(findMany).toHaveBeenCalledTimes(2);
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
