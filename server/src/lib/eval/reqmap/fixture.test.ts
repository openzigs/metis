/**
 * Epic #726 / Issue #738 — unit tests for the reqmap fixture builders.
 *
 * Covers the deterministic in-memory seams the eval depends on: the BM25
 * searcher stub (project-scoped and un-scoped reads), and the in-memory code-
 * graph data source (edge resolution, its guard rails, and every accessor).
 */
import { describe, expect, it } from "vitest";
import { buildSymbolsFromRepo } from "../codegraph/fixture.js";
import { buildBm25Searcher, buildInMemoryDataSource, defaultReqMapFixtureDir } from "./fixture.js";

const REPO = [
  { relPath: "a/alpha.ts", content: "export function reserveWidget() {\n  return 1;\n}\n" },
  { relPath: "b/beta.ts", content: "export function handleWidget() {\n  return 2;\n}\n" },
];

function symbols() {
  return buildSymbolsFromRepo(REPO, "p1");
}

describe("defaultReqMapFixtureDir", () => {
  it("points at the committed reqmap fixture", () => {
    expect(defaultReqMapFixtureDir()).toMatch(/eval-data\/corpus\/reqmap-01-precision-recall$/);
  });
});

describe("buildBm25Searcher", () => {
  it("ranks symbols matching the query, scoped to the project", async () => {
    const searcher = buildBm25Searcher(symbols());
    const hits = await searcher.search("reserve widget", "p1");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe("reserveWidget");
  });

  it("returns nothing for a foreign project id (scoping honored)", async () => {
    const searcher = buildBm25Searcher(symbols());
    const hits = await searcher.search("reserve widget", "other-project");
    expect(hits).toEqual([]);
  });
});

describe("buildInMemoryDataSource", () => {
  it("resolves name-declared edges and walks them via getEdgesTo/getEdgesFrom", async () => {
    const ds = buildInMemoryDataSource(symbols(), [
      { from: "handleWidget", to: "reserveWidget", kind: "calls" },
    ]);
    const target = symbols().find((s) => s.name === "reserveWidget")!;
    const source = symbols().find((s) => s.name === "handleWidget")!;
    const incoming = await ds.getEdgesTo(target.id);
    expect(incoming).toHaveLength(1);
    expect(incoming[0].fromSymbolId).toBe(source.id);
    const outgoing = await ds.getEdgesFrom(source.id);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].toSymbolId).toBe(target.id);
  });

  it("exposes symbols by id and by file, and null for unknown ids", async () => {
    const syms = symbols();
    const ds = buildInMemoryDataSource(syms, []);
    const one = syms[0];
    expect(await ds.getSymbol(one.id)).toMatchObject({ id: one.id, filePath: one.filePath });
    expect(await ds.getSymbol("nope")).toBeNull();
    const byFile = await ds.getSymbolsByFile("a/alpha.ts");
    expect(byFile.map((s) => s.filePath)).toEqual(["a/alpha.ts"]);
    const byIds = await ds.getSymbolsByIds([one.id, "nope"]);
    expect(byIds).toHaveLength(1);
  });

  it("throws when an edge references an unknown symbol", () => {
    expect(() =>
      buildInMemoryDataSource(symbols(), [{ from: "ghost", to: "reserveWidget", kind: "calls" }]),
    ).toThrow(/unknown symbol: ghost/);
  });

  it("throws when an edge symbol name is ambiguous", () => {
    // Two symbols share the name `dup` ⇒ the edge endpoint is not resolvable.
    const dupSymbols = buildSymbolsFromRepo(
      [
        { relPath: "x.ts", content: "export function dup() {\n  return 1;\n}\n" },
        { relPath: "y.ts", content: "export function dup() {\n  return 2;\n}\n" },
      ],
      "p1",
    );
    expect(() =>
      buildInMemoryDataSource(dupSymbols, [{ from: "dup", to: "dup", kind: "calls" }]),
    ).toThrow(/ambiguous: dup/);
  });
});
