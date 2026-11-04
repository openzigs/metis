/**
 * #1754 — the stored-link seed channel: a tracked requirement's stored code
 * links (`RequirementCodeMapping`) unioned after the hybrid edit candidates.
 *
 * The hybrid side is the #1036 CAPTURE of the production `HybridCodeSearch` on
 * Miniflux #4478 (`__fixtures__/miniflux-4478-hits.json`), replayed, so "every
 * hybrid seed survives with its score" is checked on a real ranking.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractChangesByShape } from "./change-request.js";
import {
  impactStoredLinkSeedsEnabled,
  prismaStoredLinkDeps,
  resolveChangeSeeds,
  unionStoredLinks,
  type ChangeSeeds,
  type SeedSearcher,
  type SeedSearchHit,
  type SeedSymbolRow,
  type StoredLinkDeps,
  type StoredLinkRow,
} from "./change-seeds.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "__fixtures__", name), "utf8");
const CAPTURE = JSON.parse(read("miniflux-4478-hits.json")) as {
  queries: { query: string; hits: SeedSearchHit[] }[];
  symbols: SeedSymbolRow[];
};
const capturedSearcher: SeedSearcher = {
  async search(query) {
    const captured = CAPTURE.queries.find((q) => q.query === query);
    if (!captured) throw new Error(`no capture for query: ${query.slice(0, 60)}`);
    return captured.hits;
  },
};
const capturedLoader = async (ids: string[]) => CAPTURE.symbols.filter((s) => ids.includes(s.id));
const [CHANGE_4478] = extractChangesByShape(read("miniflux-4478.md"));

function row(id: string, filePath: string, over: Partial<SeedSymbolRow> = {}): SeedSymbolRow {
  return {
    id,
    qualifiedName: `${filePath}::${id}`,
    filePath,
    kind: "function",
    language: "go",
    startLine: 1,
    endLine: 9,
    ...over,
  };
}

function link(filePath: string, over: Partial<StoredLinkRow> = {}): StoredLinkRow {
  return {
    codeSymbolId: null,
    filePath,
    startLine: null,
    endLine: null,
    confidence: 0.7,
    source: "semantic",
    ...over,
  };
}

/** Stored-link lookups over a fixed graph: `graph` is every symbol the project still has. */
function linkDeps(links: StoredLinkRow[], graph: SeedSymbolRow[]) {
  return {
    loadLinks: vi.fn(async () => links),
    loadFileSymbols: vi.fn(async (files: string[]) =>
      graph.filter((r) => files.includes(r.filePath)),
    ),
  } satisfies StoredLinkDeps;
}

const NEW_FILE = "internal/reader/age.go";
const GRAPH = [
  ...CAPTURE.symbols,
  row("AGE-1", NEW_FILE, { startLine: 1, endLine: 20 }),
  row("AGE-2", NEW_FILE, { startLine: 30, endLine: 40 }),
  row("AGE-MOD", NEW_FILE, { kind: "module", startLine: 1, endLine: 99 }),
];

describe("resolveChangeSeeds with the stored-link channel (#1754)", () => {
  const hybridOnly = () =>
    resolveChangeSeeds(CHANGE_4478!, "p1", {
      searcher: capturedSearcher,
      loadSymbols: capturedLoader,
    });
  const withLinks = (links: StoredLinkRow[], requirementId: string | null = "req-1") =>
    resolveChangeSeeds({ ...CHANGE_4478!, requirementId }, "p1", {
      searcher: capturedSearcher,
      loadSymbols: capturedLoader,
      storedLinks: linkDeps(links, GRAPH),
    });

  it("keeps every hybrid seed, in order, with its original score, and adds the links after", async () => {
    const base = await hybridOnly();
    const hybridFile = base.editCandidates[0]!.filePath;
    const relatedFile = base.related[0]!.filePath;
    const seeds = await withLinks([
      link(NEW_FILE),
      link(hybridFile, { codeSymbolId: base.editCandidates[0]!.codeSymbolId }),
      link(relatedFile, { codeSymbolId: base.related[0]!.codeSymbolId, source: "manual" }),
    ]);
    expect(seeds.editCandidates.slice(0, base.editCandidates.length)).toEqual(base.editCandidates);
    expect(seeds.related).toEqual(base.related);
    expect(seeds.schemaSeeds).toEqual(base.schemaSeeds);
    expect(seeds.retrievalMode).toEqual(base.retrievalMode);
    // The manual link first, then the semantic one; the link to a symbol the
    // hybrid seeding already named adds nothing.
    expect(seeds.editCandidates.slice(base.editCandidates.length)).toEqual([
      {
        codeSymbolId: base.related[0]!.codeSymbolId,
        filePath: relatedFile,
        qualifiedName: base.related[0]!.qualifiedName,
        startLine: base.related[0]!.startLine,
        endLine: base.related[0]!.endLine,
        confidence: 0.7,
      },
      expect.objectContaining({ codeSymbolId: "AGE-1", filePath: NEW_FILE, confidence: 0.7 }),
      expect.objectContaining({ codeSymbolId: "AGE-2", filePath: NEW_FILE, confidence: 0.7 }),
    ]);
    expect(seeds.evidence?.storedLinks).toEqual({ used: 3, stale: 0 });
    expect(seeds.evidence?.editCandidates[0]).toEqual({
      filePath: hybridFile,
      channels: ["hybrid", "stored-link"],
    });
    expect(seeds.evidence?.editCandidates.slice(-2)).toEqual([
      { filePath: relatedFile, channels: ["stored-link"] },
      { filePath: NEW_FILE, channels: ["stored-link"] },
    ]);
  });

  it("is the hybrid result, with no evidence, for a change with no requirement", async () => {
    const base = await hybridOnly();
    const deps = linkDeps([link(NEW_FILE)], GRAPH);
    const seeds = await resolveChangeSeeds({ ...CHANGE_4478!, requirementId: null }, "p1", {
      searcher: capturedSearcher,
      loadSymbols: capturedLoader,
      storedLinks: deps,
    });
    expect(seeds).toEqual(base);
    expect("evidence" in seeds).toBe(false);
    expect(deps.loadLinks).not.toHaveBeenCalled();
  });

  it("is the hybrid result, with no evidence, when the channel is off", async () => {
    const base = await hybridOnly();
    const seeds = await resolveChangeSeeds({ ...CHANGE_4478!, requirementId: "req-1" }, "p1", {
      searcher: capturedSearcher,
      loadSymbols: capturedLoader,
    });
    expect(seeds).toEqual(base);
    expect("evidence" in seeds).toBe(false);
  });

  it("reads the links of THIS requirement in THIS project", async () => {
    const deps = linkDeps([], GRAPH);
    await resolveChangeSeeds({ ...CHANGE_4478!, requirementId: "req-9" }, "proj-7", {
      searcher: capturedSearcher,
      loadSymbols: capturedLoader,
      storedLinks: deps,
    });
    expect(deps.loadLinks).toHaveBeenCalledWith("req-9", "proj-7");
  });
});

describe("unionStoredLinks (#1754)", () => {
  const hybrid: ChangeSeeds = {
    editCandidates: [
      {
        codeSymbolId: "H1",
        filePath: "pkg/h.go",
        qualifiedName: "pkg/h.go::H1",
        startLine: 1,
        endLine: 9,
        confidence: 1,
      },
    ],
    related: [],
    schemaSeeds: [],
    retrievalMode: "hybrid",
  };
  const graph = [
    row("H1", "pkg/h.go"),
    row("A1", "pkg/a.go", { startLine: 1, endLine: 10 }),
    row("A2", "pkg/a.go", { startLine: 20, endLine: 30 }),
    row("A3", "pkg/a.go", { startLine: 40, endLine: 50 }),
    row("T1", "db/schema.sql", { kind: "table", language: "sql" }),
    row("B1", "pkg/b.go", { startLine: 5, endLine: 8 }),
  ];

  it("never seeds a link whose file left the code graph, and counts it", async () => {
    const out = await unionStoredLinks(
      hybrid,
      "r",
      "p",
      linkDeps([link("pkg/deleted.go", { source: "manual", confidence: 1 })], graph),
    );
    expect(out.editCandidates).toEqual(hybrid.editCandidates);
    expect(out.evidence).toEqual({
      storedLinks: { used: 0, stale: 1 },
      editCandidates: [{ filePath: "pkg/h.go", channels: ["hybrid"] }],
    });
  });

  it("seeds a link's own symbol, else the symbols on its lines, else the file's first code symbols", async () => {
    const own = await unionStoredLinks(
      hybrid,
      "r",
      "p",
      linkDeps([link("pkg/a.go", { codeSymbolId: "A3" })], graph),
    );
    expect(own.editCandidates.slice(1).map((m) => m.codeSymbolId)).toEqual(["A3"]);
    const lines = await unionStoredLinks(
      hybrid,
      "r",
      "p",
      linkDeps([link("pkg/a.go", { startLine: 25, endLine: 45 })], graph),
    );
    expect(lines.editCandidates.slice(1).map((m) => m.codeSymbolId)).toEqual(["A2", "A3"]);
    // A symbol id the graph lost (re-ingest) falls back to the lines, then the file.
    const whole = await unionStoredLinks(
      hybrid,
      "r",
      "p",
      linkDeps([link("pkg/a.go", { codeSymbolId: "GONE", startLine: 90, endLine: 99 })], graph),
    );
    expect(whole.editCandidates.slice(1).map((m) => m.codeSymbolId)).toEqual(["A1", "A2", "A3"]);
  });

  it("ranks manual links ahead of semantic ones, then the surer, and clamps confidence", async () => {
    const out = await unionStoredLinks(
      hybrid,
      "r",
      "p",
      linkDeps(
        [
          link("pkg/b.go", { confidence: 0.95 }),
          link("pkg/a.go", { codeSymbolId: "A1", confidence: 0.4, source: "manual" }),
          link("pkg/a.go", { codeSymbolId: "A2", confidence: 1.7, source: "manual" }),
        ],
        graph,
      ),
    );
    expect(out.editCandidates.map((m) => [m.codeSymbolId, m.confidence])).toEqual([
      ["H1", 1],
      ["A2", 1],
      ["A1", 0.4],
      ["B1", 0.95],
    ]);
    expect(out.evidence?.storedLinks).toEqual({ used: 3, stale: 0 });
  });

  it("keeps the hybrid seeds and records nothing used when the lookup fails", async () => {
    const deps: StoredLinkDeps = {
      loadLinks: vi.fn().mockRejectedValue(new Error("db down")),
      loadFileSymbols: vi.fn(),
    };
    const out = await unionStoredLinks(hybrid, "r", "p", deps);
    expect(out.editCandidates).toEqual(hybrid.editCandidates);
    expect(out.evidence?.storedLinks).toEqual({ used: 0, stale: 0 });
    expect(deps.loadFileSymbols).not.toHaveBeenCalled();
  });

  it("does not look the files up when the requirement has no link", async () => {
    const deps = linkDeps([], graph);
    const out = await unionStoredLinks(hybrid, "r", "p", deps);
    expect(deps.loadFileSymbols).not.toHaveBeenCalled();
    expect(out.evidence?.storedLinks).toEqual({ used: 0, stale: 0 });
  });
});

describe("prismaStoredLinkDeps (#1754)", () => {
  it("filters links on the requirement AND the project, and symbols on the project", async () => {
    const mappings = vi.fn(async () => [] as StoredLinkRow[]);
    const symbols = vi.fn(async () => [] as SeedSymbolRow[]);
    const deps = prismaStoredLinkDeps({
      requirementCodeMapping: { findMany: mappings },
      codeSymbol: { findMany: symbols },
    } as never);
    await deps.loadLinks("req-1", "proj-1");
    expect(mappings).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requirementId: "req-1", projectId: "proj-1" } }),
    );
    const files = Array.from({ length: 501 }, (_, i) => `f${i}.go`);
    await deps.loadFileSymbols(files, "proj-1");
    expect(symbols).toHaveBeenCalledTimes(2);
    expect(symbols).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { projectId: "proj-1", filePath: { in: files.slice(0, 500) } },
      }),
    );
  });
});

describe("impactStoredLinkSeedsEnabled (#1754)", () => {
  const prior = process.env.IMPACT_STORED_LINK_SEEDS;
  afterEach(() => {
    if (prior === undefined) delete process.env.IMPACT_STORED_LINK_SEEDS;
    else process.env.IMPACT_STORED_LINK_SEEDS = prior;
  });

  it("is off by default and on only when the flag says so", () => {
    delete process.env.IMPACT_STORED_LINK_SEEDS;
    expect(impactStoredLinkSeedsEnabled()).toBe(false);
    process.env.IMPACT_STORED_LINK_SEEDS = "1";
    expect(impactStoredLinkSeedsEnabled()).toBe(true);
    process.env.IMPACT_STORED_LINK_SEEDS = "false";
    expect(impactStoredLinkSeedsEnabled()).toBe(false);
  });
});
