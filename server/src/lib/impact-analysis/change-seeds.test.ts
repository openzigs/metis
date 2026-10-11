/**
 * #1036 — hybrid seeding, split into edit candidates and the rest.
 *
 * `__fixtures__/miniflux-4478-hits.json` is a CAPTURE: the top 60 hits the
 * production `HybridCodeSearch` returned for each of #4478's two seed queries on
 * the run-7 Miniflux graph (v2.3.3, gte-modernbert vectors), with symbol ids
 * shortened. The searcher is real output replayed, not a hand-built ranking.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { extractChangesByShape } from "./change-request.js";
import {
  EDIT_POOL,
  fileScore,
  MAX_EDIT_FILES,
  MAX_RELATED,
  MAX_SYMBOLS_PER_EDIT_FILE,
  prismaSeedSymbolLoader,
  rankEditFiles,
  RELATED_CONFIDENCE_FACTOR,
  resolveChangeSeeds,
  SCHEMA_SEED_TOP,
  SEED_POOL_PER_QUERY,
  seedQueries,
  type SeedSearcher,
  type SeedSearchHit,
  type SeedSymbolRow,
} from "./change-seeds.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "__fixtures__", name), "utf8");

const ISSUE_4478 = read("miniflux-4478.md");
const CAPTURE = JSON.parse(read("miniflux-4478-hits.json")) as {
  queries: { query: string; hits: SeedSearchHit[] }[];
  symbols: SeedSymbolRow[];
};

/** Replays the captured hits for the query it is asked. */
const capturedSearcher: SeedSearcher = {
  async search(query) {
    const captured = CAPTURE.queries.find((q) => q.query === query);
    if (!captured) throw new Error(`no capture for query: ${query.slice(0, 60)}`);
    return captured.hits;
  },
};
const capturedLoader = async (ids: string[]) => CAPTURE.symbols.filter((s) => ids.includes(s.id));

const [CHANGE_4478] = extractChangesByShape(ISSUE_4478);

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

function hit(id: string, filePath: string, score: number): SeedSearchHit {
  return { symbolId: id, filePath, name: id, kind: "function", score };
}

/** A searcher + loader over one hand-built hit list (every query gets the same hits). */
function fixed(rows: SeedSymbolRow[], scores: Record<string, number>) {
  const hits = rows.map((r) => hit(r.id, r.filePath, scores[r.id] ?? 0));
  return {
    searcher: { search: vi.fn(async () => hits) } satisfies SeedSearcher,
    loadSymbols: vi.fn(async (ids: string[]) => rows.filter((r) => ids.includes(r.id))),
  };
}

const change = { title: "Do the thing", body: "Do the thing, properly." };

describe("seedQueries (#1036)", () => {
  it("searches an issue by its title and by the request without rejected alternatives", () => {
    const queries = seedQueries(CHANGE_4478!);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe("Mark all as read older than X");
    expect(queries[1]).toContain("Times could be configured in settings.");
    expect(queries[1]).not.toContain("miniflux-sanity");
    // The capture was taken with exactly these queries.
    expect(queries).toEqual(CAPTURE.queries.map((q) => q.query));
  });

  it("searches a splitter-made change by its title and its whole text", () => {
    expect(seedQueries(change)).toEqual([
      "Do the thing",
      "Do the thing\n\nDo the thing, properly.",
    ]);
  });

  it("does not ask the same question twice", () => {
    expect(seedQueries({ title: "Same", body: "" })).toEqual(["Same"]);
  });
});

describe("fileScore / rankEditFiles (#1036)", () => {
  it("halves each further hit, so agreement counts and size does not", () => {
    expect(fileScore([1])).toBe(1);
    expect(fileScore([1, 1, 1])).toBe(1.75);
    // Order does not matter: the best hit is always the full-weight one.
    expect(fileScore([0.2, 1])).toBe(fileScore([1, 0.2]));
  });

  it("ranks a file with two strong hits above a big file with many weak ones", () => {
    const hits = [
      { filePath: "small.go", score: 1 },
      { filePath: "small.go", score: 0.9 },
      ...Array.from({ length: 12 }, () => ({ filePath: "hub.go", score: 0.5 })),
    ];
    expect(rankEditFiles(hits)).toEqual(["small.go", "hub.go"]);
  });

  it("drops a file scoring under half the best, and caps the list", () => {
    expect(
      rankEditFiles([
        { filePath: "best.go", score: 1 },
        { filePath: "near.go", score: 0.5 },
        { filePath: "far.go", score: 0.49 },
      ]),
    ).toEqual(["best.go", "near.go"]);
    const many = Array.from({ length: 9 }, (_, i) => ({
      filePath: `f${i}.go`,
      score: 1 - i / 100,
    }));
    expect(rankEditFiles(many)).toHaveLength(MAX_EDIT_FILES);
  });

  it("returns nothing when no hit has a positive score", () => {
    expect(rankEditFiles([])).toEqual([]);
    expect(rankEditFiles([{ filePath: "a.go", score: 0 }])).toEqual([]);
  });
});

describe("resolveChangeSeeds — the verbatim #4478 issue on captured hits (#1036)", () => {
  const seeds = () =>
    resolveChangeSeeds(CHANGE_4478!, "p1", {
      searcher: capturedSearcher,
      loadSymbols: capturedLoader,
    });

  it("names the existing storage method MarkAllAsReadBeforeDate as an edit candidate", async () => {
    const { editCandidates } = await seeds();
    expect(editCandidates.map((m) => m.qualifiedName)).toContain(
      "internal/storage/entry.go::MarkAllAsReadBeforeDate",
    );
  });

  it("names the UI handler that has to take the age", async () => {
    const { editCandidates } = await seeds();
    expect(editCandidates.map((m) => m.qualifiedName)).toContain(
      "internal/ui/unread_mark_all_read.go::markAllAsRead",
    );
  });

  it("keeps the edit candidates to a handful of files, none of them a test", async () => {
    const { editCandidates } = await seeds();
    const files = [...new Set(editCandidates.map((m) => m.filePath))];
    expect(files.length).toBeLessThanOrEqual(MAX_EDIT_FILES);
    expect(files.some((f) => f.endsWith("_test.go"))).toBe(false);
    for (const f of files) {
      const inFile = editCandidates.filter((m) => m.filePath === f);
      expect(inFile.length).toBeLessThanOrEqual(MAX_SYMBOLS_PER_EDIT_FILE);
    }
  });

  it("returns everything else for review, with no symbol in both lists", async () => {
    const { editCandidates, related } = await seeds();
    expect(related.length).toBeGreaterThan(editCandidates.length);
    const edit = new Set(editCandidates.map((m) => m.codeSymbolId));
    expect(related.some((m) => edit.has(m.codeSymbolId))).toBe(false);
    // The Google Reader handler is the method's only caller today: review, not edit.
    expect(related.map((m) => m.qualifiedName)).toContain(
      "internal/googlereader/handler.go::markAllAsReadHandler",
    );
  });

  it("normalises confidence to the best hit", async () => {
    const { editCandidates, related } = await seeds();
    expect(Math.max(...editCandidates.map((m) => m.confidence))).toBe(1);
    expect(Math.max(...related.map((m) => m.confidence))).toBeLessThanOrEqual(
      RELATED_CONFIDENCE_FACTOR,
    );
  });
});

describe("resolveChangeSeeds — what can be an edit candidate (#1036)", () => {
  it("never selects a test file, and still returns it for review", async () => {
    const deps = fixed([row("T", "pkg/a_test.go"), row("A", "pkg/a.go")], { T: 1, A: 0.4 });
    const { editCandidates, related } = await resolveChangeSeeds(change, "p1", deps);
    expect(editCandidates.map((m) => m.codeSymbolId)).toEqual(["A"]);
    expect(related.map((m) => m.codeSymbolId)).toEqual(["T"]);
  });

  it("never selects a schema symbol as code to edit; it seeds the schema crossing instead", async () => {
    const deps = fixed(
      [row("col", "db/migrations.go", { kind: "column", language: "sql" }), row("A", "pkg/a.go")],
      { col: 1, A: 0.9 },
    );
    const seeds = await resolveChangeSeeds(change, "p1", deps);
    expect(seeds.editCandidates.map((m) => m.codeSymbolId)).toEqual(["A"]);
    expect(seeds.related).toEqual([]);
    expect(seeds.schemaSeeds.map((m) => [m.codeSymbolId, m.confidence])).toEqual([["col", 1]]);
  });

  it("only a table or column among the very best hits seeds the crossing", async () => {
    const code = Array.from({ length: SCHEMA_SEED_TOP }, (_, i) => row(`F${i}`, `pkg/f${i}.go`));
    const far = row("far", "db/migrations.go", { kind: "column", language: "sql" });
    const scores = Object.fromEntries(code.map((r, i) => [r.id, 1 - i / 100]));
    const seeds = await resolveChangeSeeds(
      change,
      "p1",
      fixed([...code, far], { ...scores, far: 0.5 }),
    );
    // Ranked 11th: neither a schema seed nor listed for review.
    expect(seeds.schemaSeeds).toEqual([]);
    expect(seeds.related.map((m) => m.codeSymbolId)).not.toContain("far");
  });

  it("drops a documentation-site artifact from both lists", async () => {
    const deps = fixed([row("D", "docs/index.xml"), row("A", "pkg/a.go")], { D: 1, A: 0.5 });
    const { editCandidates, related } = await resolveChangeSeeds(change, "p1", deps);
    expect([...editCandidates, ...related].map((m) => m.codeSymbolId)).toEqual(["A"]);
  });

  it("lists a file's functions rather than its module symbol when it has both", async () => {
    const deps = fixed([row("M", "pkg/a.go", { kind: "module" }), row("F", "pkg/a.go")], {
      M: 1,
      F: 0.8,
    });
    const { editCandidates, related } = await resolveChangeSeeds(change, "p1", deps);
    expect(editCandidates.map((m) => m.codeSymbolId)).toEqual(["F"]);
    // The rest of an edit file is not repeated under "review".
    expect(related).toEqual([]);
  });

  it("falls back to the module symbol when that is the file's only hit", async () => {
    const deps = fixed([row("M", "pkg/a.go", { kind: "module" })], { M: 1 });
    const { editCandidates } = await resolveChangeSeeds(change, "p1", deps);
    expect(editCandidates.map((m) => m.codeSymbolId)).toEqual(["M"]);
  });

  it("adds the scores of a symbol both queries found", async () => {
    const a = row("A", "pkg/a.go");
    const b = row("B", "pkg/b.go");
    const searcher: SeedSearcher = {
      // Title query: B leads. Whole-text query: only A.
      search: vi
        .fn()
        .mockResolvedValueOnce([hit("B", b.filePath, 0.6), hit("A", a.filePath, 0.5)])
        .mockResolvedValueOnce([hit("A", a.filePath, 0.5)]),
    };
    const { editCandidates } = await resolveChangeSeeds(change, "p1", {
      searcher,
      loadSymbols: async () => [a, b],
    });
    expect(editCandidates.map((m) => [m.codeSymbolId, m.confidence])).toEqual([
      ["A", 1],
      ["B", 0.6],
    ]);
    expect(searcher.search).toHaveBeenCalledWith("Do the thing", "p1", {
      limit: SEED_POOL_PER_QUERY,
    });
  });

  it("reads only the best hits for the file ranking, and caps what it returns for review", async () => {
    const rows = Array.from({ length: EDIT_POOL + MAX_RELATED + 40 }, (_, i) =>
      row(`S${i}`, `pkg/f${i}.go`),
    );
    const scores = Object.fromEntries(rows.map((r, i) => [r.id, 1 - i / 1000]));
    const { editCandidates, related } = await resolveChangeSeeds(change, "p1", fixed(rows, scores));
    expect(editCandidates).toHaveLength(MAX_EDIT_FILES);
    expect(related).toHaveLength(MAX_RELATED);
  });
});

describe("resolveChangeSeeds — it never throws (#1036)", () => {
  const none = { editCandidates: [], related: [], schemaSeeds: [] };

  it("returns no seeds when the search fails", async () => {
    const searcher: SeedSearcher = { search: vi.fn().mockRejectedValue(new Error("lance down")) };
    expect(await resolveChangeSeeds(change, "p1", { searcher, loadSymbols: vi.fn() })).toEqual(
      none,
    );
  });

  it("returns no seeds when the symbol lookup fails", async () => {
    const deps = fixed([row("A", "pkg/a.go")], { A: 1 });
    deps.loadSymbols.mockRejectedValue(new Error("db down"));
    expect(await resolveChangeSeeds(change, "p1", deps)).toEqual(none);
  });

  it("returns no seeds for a project with no code graph, or an empty change", async () => {
    expect(await resolveChangeSeeds(change, "p1", fixed([], {}))).toEqual(none);
    const deps = fixed([row("A", "pkg/a.go")], { A: 1 });
    expect(await resolveChangeSeeds({ title: " ", body: "" }, "p1", deps)).toEqual(none);
    expect(deps.searcher.search).not.toHaveBeenCalled();
  });

  it("drops a hit whose symbol was removed between search and lookup", async () => {
    const deps = fixed([row("A", "pkg/a.go"), row("GONE", "pkg/b.go")], { A: 0.5, GONE: 1 });
    deps.loadSymbols.mockResolvedValue([row("A", "pkg/a.go")]);
    const { editCandidates, related } = await resolveChangeSeeds(change, "p1", deps);
    expect([...editCandidates, ...related].map((m) => m.codeSymbolId)).toEqual(["A"]);
  });
});

describe("prismaSeedSymbolLoader (#1036)", () => {
  it("scopes the lookup to the project and chunks a long id list", async () => {
    const findMany = vi.fn(async () => [] as SeedSymbolRow[]);
    const load = prismaSeedSymbolLoader({ codeSymbol: { findMany } } as never);
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await load(ids, "proj-9");
    expect(findMany).toHaveBeenCalledTimes(2);
    const first = findMany.mock.calls[0] as unknown as [
      { where: { projectId: string; id: { in: string[] } } },
    ];
    expect(first[0].where.projectId).toBe("proj-9");
    expect(first[0].where.id.in).toHaveLength(500);
  });
});
