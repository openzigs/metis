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
import { tokenizeCodeRoots } from "../code-graph/hybrid-search.js";
import { describe, expect, it, vi } from "vitest";
import {
  extractChangesByShape,
  requestRetrievalText,
  RETRIEVAL_PART_HEADROOM,
  type ChangeRequest,
} from "./change-request.js";
import {
  EDIT_POOL,
  fileScore,
  isSchemaSymbol,
  MAX_EDIT_FILES,
  MAX_RELATED,
  MAX_SYMBOLS_PER_EDIT_FILE,
  prismaSeedSymbolLoader,
  rankEditFiles,
  RELATED_CONFIDENCE_FACTOR,
  resolveChangeSeeds,
  SCHEMA_SEED_TOP,
  SEED_POOL_PER_QUERY,
  MAX_SEED_QUERY_CHARS,
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

describe("seedQueries — the query handed to the search is capped (PR #1090 review 2)", () => {
  it("cuts a long request to MAX_SEED_QUERY_CHARS, at a word boundary", () => {
    const body = "alpha beta gamma ".repeat(2000);
    const [title, whole] = seedQueries({ title: "Mark all as read", body });
    expect(title).toBe("Mark all as read");
    expect(whole!.length).toBeLessThanOrEqual(MAX_SEED_QUERY_CHARS);
    expect(whole!.length).toBeGreaterThan(MAX_SEED_QUERY_CHARS - 10);
    expect(whole!.startsWith("Mark all as read\n\nalpha beta gamma")).toBe(true);
    expect(/(alpha|beta|gamma)$/.test(whole!)).toBe(true);
  });

  it("cuts a whitespace-free token, and a long title, by length", () => {
    const [title, whole] = seedQueries({ title: "Export", body: "A".repeat(200_000) });
    expect(title).toBe("Export");
    expect(whole).toHaveLength(MAX_SEED_QUERY_CHARS);
    // A title past the cap: both queries are cut to the same text, so there is one.
    const queries = seedQueries({ title: "T".repeat(9000), body: "x" });
    expect(queries.map((q) => q.length)).toEqual([MAX_SEED_QUERY_CHARS]);
  });

  it("caps an issue's retrieval text too", () => {
    const issue = `# [Feature]: Export\n\n### Feature Summary\n\nExport it.\n\n### Proposed Solution\n\n${"A".repeat(200_000)}`;
    const [change] = extractChangesByShape(issue);
    expect(change!.request).toBeDefined();
    for (const query of seedQueries(change!)) {
      expect(query.length).toBeLessThanOrEqual(MAX_SEED_QUERY_CHARS);
    }
  });

  it("leaves a request under the cap exactly as it was: the six run-7 issues are 0.6 to 1.7 KB", () => {
    const body = "word ".repeat(700).trim();
    expect(seedQueries({ title: "T", body })).toEqual(["T", `T\n\n${body}`]);
  });

  it("keeps the search tokenizer off 200 KB: 200 KB of capitals is tokenized in well under a second", () => {
    const queries = seedQueries({ title: "Export", body: "A".repeat(200_000) });
    const start = performance.now();
    for (const q of queries) tokenizeCodeRoots(q);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

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

  it("keeps a MyBatis mapper statement editable: kind `method`, language `sql`, in mapper XML (PR #1090 panel)", async () => {
    // What `createOriginSymbol` stores for `<update id="updateStatus">`.
    const XML = "src/main/resources/mapper/OrderMapper.xml";
    const statement = row("updateStatus", XML, {
      kind: "method",
      language: "sql",
      qualifiedName: "com.shop.OrderMapper.updateStatus",
    });
    const deps = fixed([statement, row("A", "pkg/a.java", { language: "java" })], {
      updateStatus: 1,
      A: 0.9,
    });
    const seeds = await resolveChangeSeeds(change, "p1", deps);
    expect(seeds.editCandidates.map((m) => [m.codeSymbolId, m.filePath])).toEqual([
      ["updateStatus", XML],
      ["A", "pkg/a.java"],
    ]);
    // Code, so not a schema seed — and it is the BEST hit, so it would have been one.
    expect(seeds.schemaSeeds).toEqual([]);
  });

  it("lists a mapper statement below the edit cut for review, rather than dropping it", async () => {
    const XML = "src/main/resources/mapper/OrderMapper.xml";
    const statement = row("selectAll", XML, { kind: "method", language: "sql" });
    const deps = fixed([row("A", "pkg/a.java"), statement], { A: 1, selectAll: 0.1 });
    const seeds = await resolveChangeSeeds(change, "p1", deps);
    expect(seeds.editCandidates.map((m) => m.codeSymbolId)).toEqual(["A"]);
    expect(seeds.related.map((m) => m.codeSymbolId)).toEqual(["selectAll"]);
  });

  it("decides what is schema by kind: a table, a column, a stored routine — not by language", () => {
    const of = (kind: string, language: string) => isSchemaSymbol({ kind, language });
    expect([of("table", "sql"), of("column", "sql"), of("procedure", "sql")]).toEqual([
      true,
      true,
      true,
    ]);
    // A stored SQL function shares its kind with code, so here the language decides.
    expect(of("function", "sql")).toBe(true);
    expect(of("function", "go")).toBe(false);
    expect(of("method", "sql")).toBe(false);
    expect(of("method", "java")).toBe(false);
    expect(of("module", "sql")).toBe(false);
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
      onRetrievalMode: expect.any(Function),
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
  /** Searched and found nothing: the lists are empty, and no mode was reported. */
  const searchedNone = { ...none, retrievalMode: null };

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
    expect(await resolveChangeSeeds(change, "p1", fixed([], {}))).toEqual(searchedNone);
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

describe("resolveChangeSeeds — which channels answered (#1036, PR #1090 review)", () => {
  const rows = [row("A", "pkg/a.go")];
  /** A searcher that reports one mode per query, in order. */
  function reporting(modes: Array<"hybrid" | "bm25-only" | null>) {
    let call = 0;
    const searcher: SeedSearcher = {
      async search(_query, _projectId, opts) {
        const mode = modes[call++] ?? null;
        if (mode) opts?.onRetrievalMode?.(mode);
        return [hit("A", "pkg/a.go", 1)];
      },
    };
    return { searcher, loadSymbols: async () => rows };
  }

  it("is hybrid when every query had the vector channel", async () => {
    const seeds = await resolveChangeSeeds(change, "p1", reporting(["hybrid", "hybrid"]));
    expect(seeds.retrievalMode).toBe("hybrid");
  });

  it("is bm25-only as soon as one query ran without it", async () => {
    const seeds = await resolveChangeSeeds(change, "p1", reporting(["hybrid", "bm25-only"]));
    expect(seeds.retrievalMode).toBe("bm25-only");
    expect(seeds.editCandidates.map((m) => m.codeSymbolId)).toEqual(["A"]);
  });

  it("is null when the searcher does not say — a replayed capture, an injected searcher", async () => {
    expect(
      (await resolveChangeSeeds(change, "p1", reporting([null, null]))).retrievalMode,
    ).toBeNull();
    const captured = await resolveChangeSeeds(CHANGE_4478!, "p1", {
      searcher: capturedSearcher,
      loadSymbols: capturedLoader,
    });
    expect(captured.retrievalMode).toBeNull();
  });

  it("reports the mode even when the search found nothing", async () => {
    const searcher: SeedSearcher = {
      async search(_q, _p, opts) {
        opts?.onRetrievalMode?.("bm25-only");
        return [];
      },
    };
    const seeds = await resolveChangeSeeds(change, "p1", { searcher, loadSymbols: vi.fn() });
    expect(seeds).toEqual({
      editCandidates: [],
      related: [],
      schemaSeeds: [],
      retrievalMode: "bm25-only",
    });
  });
});

describe("seedQueries — the request is cut BEFORE it is cleaned, and the query is the same (PR #1090 review 3)", () => {
  /** `capQuery` as `change-seeds.ts` has it. */
  const cap = (text: string): string => {
    if (text.length <= MAX_SEED_QUERY_CHARS) return text;
    const head = text.slice(0, MAX_SEED_QUERY_CHARS);
    const lastBreak = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
    return lastBreak >= MAX_SEED_QUERY_CHARS - 100 ? head.slice(0, lastBreak).trimEnd() : head;
  };
  /** The request query as it was built before: clean ALL of it, then cut. */
  const before = (request: ChangeRequest): string => cap(requestRetrievalText(request));
  /** Through `seedQueries`, with no title: the request query is the only one (none when empty). */
  const now = (request: ChangeRequest): string =>
    seedQueries({ title: "", body: "", request })[0] ?? "";
  const PART_LIMIT = MAX_SEED_QUERY_CHARS * RETRIEVAL_PART_HEADROOM;

  const request = (
    primary: string,
    subs: string[] = [],
    context: string[] = [],
  ): ChangeRequest => ({
    title: "T",
    kind: "feature",
    primaryRequest: primary,
    subAspects: subs.map((text, i) => ({ heading: `Sub ${i}`, text })),
    context: context.map((text, i) => ({
      heading: i % 3 === 2 ? "Alternatives considered" : `Context ${i}`,
      text,
    })),
    ignored: [],
  });

  it.each(["miniflux-4478.md", "miniflux-4336.md", "miniflux-4479.md", "miniflux-4386.md"])(
    "%s: byte-identical query",
    (name) => {
      const [change] = extractChangesByShape(read(name));
      expect(change!.request).toBeDefined();
      expect(now(change!.request!)).toBe(before(change!.request!));
      // …and under the cap, so it is the whole cleaned request.
      expect(now(change!.request!)).toBe(requestRetrievalText(change!.request!));
    },
  );

  /** Everything the replace chain acts on, closed and unclosed. */
  const FRAGMENTS = [
    "mark all as read ",
    "older than 30 days. ",
    "[a link](https://example.com/x) ",
    "[an unclosed link](https://example.com/",
    "[ ",
    "https://example.com/path?q=1 ",
    "```\nSELECT 1;\n```\n",
    "```\nnever closed ",
    "~~~\nfenced\n~~~\n",
    "   \t  ",
    "\n\n\n\n",
    "\n",
    "MarkAllAsReadBeforeDate ",
    "x",
  ];

  it("is byte-identical on 3,000 generated requests whose sections are each within the pre-clean limit", () => {
    let seed = 1090;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const section = (maxLength: number): string => {
      const target = next(maxLength);
      let text = "";
      while (text.length < target) {
        const fragment = FRAGMENTS[next(FRAGMENTS.length)]!;
        // Now and then, a long run of one fragment.
        text += next(10) === 0 ? fragment.repeat(1 + next(200)) : fragment;
      }
      return text.slice(0, maxLength);
    };
    let underCap = 0;
    let overCap = 0;
    for (let i = 0; i < 3000; i++) {
      // A third small (the six run-7 issues are 0.6 to 1.7 KB), a third around
      // the cap, a third well over it in total with every section in the limit.
      const size = [600, 3000, PART_LIMIT][i % 3]!;
      const r = request(
        section(size),
        Array.from({ length: next(4) }, () => section(size)),
        Array.from({ length: next(4) }, () => section(size)),
      );
      const all = [r.primaryRequest, ...r.subAspects, ...r.context].map((part) =>
        typeof part === "string" ? part.length : part.text.length,
      );
      expect(Math.max(...all)).toBeLessThanOrEqual(PART_LIMIT);
      if (requestRetrievalText(r).length <= MAX_SEED_QUERY_CHARS) underCap++;
      else overCap++;
      expect(now(r), `request ${i}`).toBe(before(r));
    }
    // Both sides of the cap are really exercised.
    expect(underCap).toBeGreaterThan(500);
    expect(overCap).toBeGreaterThan(500);
  });

  it("reads no more of a section than the pre-clean limit: the rest of 500,000 characters changes nothing", () => {
    const head = "alpha beta ".repeat(PART_LIMIT).slice(0, PART_LIMIT);
    const short = request(head);
    for (const tail of [
      "x".repeat(484_000),
      "[a](http://x".repeat(40_000),
      "```".repeat(160_000),
    ]) {
      expect(now(request(head + tail))).toBe(now(short));
    }
    expect(now(short).length).toBeLessThanOrEqual(MAX_SEED_QUERY_CHARS);
  });

  it("stops cleaning sections once the query is full: 100,000 later sections cost nothing", () => {
    const full = "alpha beta ".repeat(500);
    expect(full.length).toBeGreaterThan(MAX_SEED_QUERY_CHARS);
    const many = request(
      full,
      Array.from({ length: 100_000 }, () => "later"),
    );
    // Each cleaned section is five `replace` calls. Counted, not timed.
    const replace = vi.spyOn(String.prototype, "replace");
    let calls: number;
    let query: string;
    try {
      query = now(many);
      calls = replace.mock.calls.length;
    } finally {
      replace.mockRestore();
    }
    expect(calls).toBeLessThan(20);
    expect(query).toBe(before(many));
  });

  it("a section longer than the limit is cleaned from its head alone (the documented difference)", () => {
    // A fence that closes past the cut is read as unclosed: the text after it is
    // lost to this query, where cleaning the whole section would have kept it.
    const long = `intro\n\`\`\`\n${"x".repeat(PART_LIMIT)}\n\`\`\`\nafter the fence`;
    expect(before(request(long))).toBe("intro\n \nafter the fence");
    expect(now(request(long))).toBe("intro");
  });
});
