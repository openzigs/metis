/**
 * #1060 — `/speckit.plan` localisation: from the code similarity retrieved, down
 * the code graph to the files a plan has to name.
 *
 * The fixture is the shape of Miniflux #4511 ("last successful refresh in the
 * feed API"): a UI handler is retrieved; the migration, the storage writers,
 * the query builder and the client struct are not, and share no word with the
 * spec. Every one of them has to come out of the walk.
 */
import { describe, expect, it, vi } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  MIGRATIONS,
  STORAGE,
  fakeSource,
  minifluxGraph,
  sym,
} from "../../../tests/helpers/plan-localisation-graph.js";
import {
  LOCALISATION_HEADER,
  MAX_CALLEES,
  MAX_LISTED_TWINS,
  MAX_NAMED_LEFT_OUT,
  MAX_OTHER_CALLEES,
  MAX_READERS_PER_TABLE,
  MAX_SCANNED_SPEC_CHARS,
  MAX_WRITERS_PER_TABLE,
  buildPlanLocalisation,
  countEntityMentions,
  nameSome,
  rankTables,
  renderLocalisation,
  roundRobin,
  type LocalisationSection,
  type LocalisationSeed,
  type PlanLocalisationSource,
} from "./plan-localisation.js";

const SPEC =
  "Record, per feed, the time of the feed's most recent successful refresh, and expose it wherever the feed is returned. A feed that never succeeded shows none.";

const SEEDS: LocalisationSeed[] = [
  {
    id: "h-refresh",
    name: "refreshFeed",
    filePath: "internal/ui/feed_refresh.go",
    kind: "function",
  },
  {
    id: "m-entries",
    name: "feed_entries.go",
    filePath: "internal/ui/feed_entries.go",
    kind: "module",
  },
];

const localise = (over: Partial<Parameters<typeof buildPlanLocalisation>[0]> = {}) =>
  buildPlanLocalisation({
    projectId: "p1",
    requirementText: SPEC,
    seeds: SEEDS,
    tokenBudget: 4000,
    source: fakeSource(minifluxGraph()),
    ...over,
  });

// ── The walk ─────────────────────────────────────────────────────────────────

describe("buildPlanLocalisation — the files similarity cannot reach (#1060)", () => {
  it("names the migration, the model and client types, the writers and the query builder", async () => {
    const r = await localise();
    expect(r.tables).toEqual(["feeds"]);
    // The three files the run-7 plans called "not in the retrieved context", and the client struct.
    for (const file of [
      MIGRATIONS,
      "internal/model/feed.go",
      "client/model.go",
      `${STORAGE}/feed.go`,
      `${STORAGE}/feed_query_builder.go`,
    ]) {
      expect(r.files, file).toContain(file);
    }
    expect(r.block).toContain(LOCALISATION_HEADER);
    expect(r.block).toContain(
      "- table `feeds` — defined in internal/database/migrations.go (a schema change to it goes in this file)",
    );
    expect(r.block).toContain("- Feed (class) — internal/model/feed.go:24-33");
    expect(r.block).toContain("- Feed (class) — client/model.go:143-152");
    expect(r.block).toContain(
      "- UpdateFeed (function) — internal/storage/feed.go:331-340 — writes checked_at, title",
    );
    expect(r.block).toContain(
      "- CreateFeed (function) — internal/storage/feed.go:216-225 — writes title",
    );
    expect(r.dropped).toEqual([]);
    expect(r.block).not.toContain("Left out of this block");
  });

  it("lists every writer, the retrieved code's own first, and what each writes", async () => {
    const r = await localise();
    const writers = r.block.slice(r.block.indexOf("### Writers of `feeds`"));
    // UpdateFeed is called by the retrieved handler; CreateFeed is not.
    expect(writers.indexOf("UpdateFeed")).toBeLessThan(writers.indexOf("CreateFeed"));
  });

  it("shows a writer's signature and SQL, and a type's declaration, as excerpts", async () => {
    const r = await localise();
    expect(r.block).toContain("func (s *Storage) UpdateFeed(feed *model.Feed) error");
    expect(r.block).toContain("UPDATE feeds SET checked_at=$1, title=$2 WHERE id=$3");
    expect(r.block).toContain("CheckedAt time.Time");
    // The stored text's `kind name in path` header line is not part of the excerpt.
    expect(r.block).not.toContain("class Feed in internal/model/feed.go");
  });

  it("never names a test, a synthetic SQL origin or an ORM mapping as a writer", async () => {
    const r = await localise();
    expect(r.block).not.toContain("TestUpdateFeed");
    expect(r.block).not.toContain("sql@1471");
    expect(r.block).not.toContain("schema.prisma");
    expect(r.files).not.toContain(`${STORAGE}/feed_test.go`);
  });

  it("lists the readers that are not writers, one file before a second row for any file", async () => {
    const r = await localise();
    const readers = r.block.slice(
      r.block.indexOf("### Readers of `feeds`"),
      r.block.indexOf("### Called by"),
    );
    expect(readers).toContain("- FeedExists (function) — internal/storage/feed.go:36-45");
    expect(readers).toContain(
      "- GetNavMetadata (function) — internal/storage/nav_metadata.go:20-29",
    );
    // UpdateFeed reads feeds.id in its WHERE: it is a writer, and is listed once.
    expect(readers).not.toContain("UpdateFeed");
  });

  it("reaches the query builder through a second call hop inside the data layer", async () => {
    // Lineage cannot see SQL assembled from fragments: FeedByID has no lineage
    // edge, so only handler → FeedByID → NewFeedQueryBuilder leads there.
    const r = await localise();
    expect(r.block).toContain(
      "- NewFeedQueryBuilder (function) — internal/storage/feed_query_builder.go:32-41 (called by FeedByID)",
    );
    expect(r.block).toContain(
      "- FeedByID (function) — internal/storage/feed.go:200-209 (called by refreshFeed, showFeedEntriesPage)",
    );
  });

  it("starts from the functions of a file-level hit, which has no call edge of its own", async () => {
    const r = await localise({ seeds: [SEEDS[1]!] });
    // showFeedEntriesPage (declared in the retrieved file) calls FeedByID and UserByID.
    expect(r.block).toContain("called by showFeedEntriesPage");
    expect(r.files).toContain(`${STORAGE}/feed_query_builder.go`);
  });

  it("names the structural twin of a retrieved function", async () => {
    const r = await localise();
    expect(r.block).toContain(
      "- showCategoryEntriesPage (function) — internal/ui/category_entries.go:15-24 (built like showFeedEntriesPage: 78% of callees shared)",
    );
    expect(r.files).toContain("internal/ui/category_entries.go");
  });

  it("does not list what the retrieval already named", async () => {
    const r = await localise();
    expect(r.block).not.toMatch(/^- refreshFeed \(/m);
    expect(r.block).not.toMatch(/^- showFeedEntriesPage \(/m);
  });

  it("keeps a table the spec does not name out, and a second one it does name in", async () => {
    // `users` is reached (showFeedEntriesPage → UserByID) but the spec is about feeds.
    expect((await localise()).tables).toEqual(["feeds"]);
    const both = await localise({ requirementText: "Show the feed owner: the user of each feed." });
    expect(both.tables).toEqual(["feeds", "users"]);
    expect(both.block).toContain("### Data model of `feeds`, `users`");
    expect(both.block).toContain("### Readers of `users`");
  });

  it("lists callees with no table at all: a change that touches no stored data", async () => {
    const graph = minifluxGraph();
    graph.edges = graph.edges.filter((e) => e.kind === "calls");
    const r = await localise({ source: fakeSource(graph) });
    expect(r.tables).toEqual([]);
    expect(r.block).not.toContain("### Data model");
    expect(r.block).toContain("- JSON (function) — internal/http/response/json.go:18-27");
    expect(r.files).not.toContain(MIGRATIONS);
  });
});

describe("buildPlanLocalisation — never fails the command", () => {
  it("returns nothing, without touching the graph, when there is no seed", async () => {
    const source = fakeSource(minifluxGraph());
    const spy = vi.spyOn(source, "getFunctionsInFiles");
    const r = await localise({ seeds: [], source });
    expect(r).toEqual({ block: "", files: [], tables: [], dropped: [], usedSymbols: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores a seed in a test file", async () => {
    const r = await localise({
      seeds: [{ id: "t-writer", name: "TestUpdateFeed", filePath: `${STORAGE}/feed_test.go` }],
    });
    expect(r.block).toBe("");
  });

  it("is off at a zero budget, and for a project id that is empty", async () => {
    expect((await localise({ tokenBudget: 0 })).block).toBe("");
    expect((await localise({ projectId: "" })).block).toBe("");
  });

  it("returns nothing when a file-level hit declares no function", async () => {
    const r = await localise({
      seeds: [{ id: "m-x", name: "x.go", filePath: "internal/x/x.go", kind: "module" }],
    });
    expect(r.block).toBe("");
  });

  it("returns nothing when a lookup throws", async () => {
    const source = fakeSource(minifluxGraph());
    source.schema.getSchemaEdgesFrom = vi.fn(async () => {
      throw new Error("database is locked");
    });
    await expect(localise({ source })).resolves.toEqual({
      block: "",
      files: [],
      tables: [],
      dropped: [],
      usedSymbols: 0,
    });
  });

  it("degrades to what the data source can answer when the optional hooks are absent", async () => {
    const full = fakeSource(minifluxGraph());
    const source: PlanLocalisationSource = {
      ...full,
      schema: {
        getSchemaEdgesFrom: full.schema.getSchemaEdgesFrom,
        getSchemaSymbolsByIds: full.schema.getSchemaSymbolsByIds,
      },
    };
    // The table is found through the retrieved seed's own lineage; nothing else can be named.
    const graph = minifluxGraph();
    graph.edges.push({ from: "h-refresh", to: "col-title", kind: "writes" });
    const withEdge = fakeSource(graph);
    source.schema.getSchemaEdgesFrom = withEdge.schema.getSchemaEdgesFrom;
    const r = await localise({ source });
    expect(r.tables).toEqual(["feeds"]);
    expect(r.block).toBe("");
  });
});

// ── The budget: nothing is dropped silently ──────────────────────────────────

describe("buildPlanLocalisation — the token budget", () => {
  it("drops excerpts before locators, and names every excerpt it dropped", async () => {
    const full = await localise();
    // The smallest budget that still lists every row.
    let tokenBudget = 4000;
    while ((await localise({ tokenBudget: tokenBudget - 10 })).files.length === full.files.length) {
      tokenBudget -= 10;
    }
    const tight = await localise({ tokenBudget });
    expect(tight.files).toEqual(full.files);
    expect(tight.block).not.toContain("UPDATE feeds SET");
    expect(tight.dropped).toEqual([
      "Excerpts not shown for the token budget (the locator is listed): Feed in internal/model/feed.go, UpdateFeed",
    ]);
    expect(tight.block).toContain("### Left out of this block");
    expect(tight.block).toContain(tight.dropped[0]);
  });

  it("names the rows it could not list, and keeps their files out of the manifest", async () => {
    const r = await localise({ tokenBudget: 330 });
    expect(r.files).toContain(MIGRATIONS);
    expect(r.files).not.toContain(`${STORAGE}/feed_query_builder.go`);
    expect(r.dropped.some((d) => d.includes("not listed for the token budget"))).toBe(true);
    expect(r.dropped.join(" ")).toContain("NewFeedQueryBuilder");
  });

  it("keeps the header, rows and excerpts within the budget", async () => {
    for (const tokenBudget of [330, 620, 900, 4000]) {
      const r = await localise({ tokenBudget });
      const body = r.block.split("\n\n### Left out of this block")[0]!;
      expect(Math.ceil(body.length / 4), `budget ${tokenBudget}`).toBeLessThanOrEqual(tokenBudget);
    }
  });

  it("renders nothing when not even one row fits", async () => {
    const r = await localise({ tokenBudget: 10 });
    expect(r.block).toBe("");
    expect(r.files).toEqual([]);
    expect(r.dropped.length).toBeGreaterThan(0);
  });

  it("says how many writers, readers, callees and twins a cap removed, and in which files", async () => {
    const graph = minifluxGraph();
    for (let i = 0; i < MAX_WRITERS_PER_TABLE + 3; i++) {
      graph.symbols.push(
        sym(`w${i}`, "function", `${STORAGE}/w${i}.go::Write${i}`, `${STORAGE}/w${i}.go`),
      );
      graph.edges.push({ from: `w${i}`, to: "col-title", kind: "writes" });
    }
    for (let i = 0; i < MAX_READERS_PER_TABLE + 2; i++) {
      graph.symbols.push(
        sym(`r${i}`, "function", `${STORAGE}/r${i}.go::Read${i}`, `${STORAGE}/r${i}.go`),
      );
      graph.edges.push({ from: `r${i}`, to: "col-id", kind: "reads" });
    }
    for (let i = 0; i < MAX_CALLEES + 2; i++) {
      graph.symbols.push(
        sym(`c${i}`, "function", `${STORAGE}/c${i}.go::Call${i}`, `${STORAGE}/c${i}.go`),
      );
      graph.edges.push({ from: "h-refresh", to: `c${i}`, kind: "calls", callee: `Call${i}` });
    }
    for (let i = 0; i < MAX_OTHER_CALLEES + 2; i++) {
      graph.symbols.push(
        sym(`o${i}`, "function", `internal/o/o${i}.go::Other${i}`, `internal/o/o${i}.go`),
      );
      graph.edges.push({ from: "h-refresh", to: `o${i}`, kind: "calls", callee: `Other${i}` });
    }
    // Twins of two retrieved functions, four kept for each (the finder's own
    // per-function cap): eight, of which {@link MAX_LISTED_TWINS} are listed.
    graph.symbols.push(sym("h2", "function", "internal/ui/h2.go::second", "internal/ui/h2.go"));
    for (const [seed, twin, callees] of [
      ["f-show", "t", ["a", "b", "c", "d", "e", "f", "g"]],
      ["h2", "u", ["p", "q", "r", "s", "t", "u", "v"]],
    ] as const) {
      for (const callee of callees) {
        if (seed === "h2") graph.edges.push({ from: seed, to: "", kind: "calls", callee });
      }
      for (let i = 0; i < 5; i++) {
        const id = `${twin}${i}`;
        graph.symbols.push(
          sym(id, "function", `internal/ui/${id}.go::twin${id}`, `internal/ui/${id}.go`),
        );
        for (const callee of callees) graph.edges.push({ from: id, to: "", kind: "calls", callee });
      }
    }
    expect(MAX_LISTED_TWINS).toBeLessThan(8);
    const r = await localise({
      source: fakeSource(graph),
      tokenBudget: 20_000,
      seeds: [...SEEDS, { id: "h2", name: "second", filePath: "internal/ui/h2.go" }],
    });
    const all = r.dropped.join("\n");
    // 2 original writers + 19 added, 16 listed.
    expect(all).toMatch(/Writers of `feeds`: 5 more writers not listed \(in /);
    expect(all).toMatch(/Readers of `feeds`: \d+ more readers not listed \(in /);
    expect(all).toMatch(
      /Called by the Retrieved Code and the Data Layer: \d+ more callees not listed/,
    );
    // Only so many callees outside the data layer are listed (JSON and three of
    // the six added here); the rest are counted.
    expect(r.block.match(/^- (?:Other\d+|JSON) \(/gm)).toHaveLength(MAX_OTHER_CALLEES);
    expect(all).toMatch(/Structural Twins of Retrieved Functions: 2 more twins not listed/);
    expect(r.block.match(/built like/g)).toHaveLength(MAX_LISTED_TWINS);
    // A long list of files is cut to a count, never to silence.
    expect(all).toMatch(/\+\d+ more\)/);
  });
});

// ── The pure parts ───────────────────────────────────────────────────────────

describe("countEntityMentions", () => {
  it("counts a table by its name, its singular and its unseparated form", () => {
    const counts = countEntityMentions(
      "A feed and two feeds. Each user_sessions row is a UserSession; usersessions too. An entry.",
      ["feeds", "user_sessions", "entries", "public.icons"],
    );
    expect(counts.get("feeds")).toBe(2);
    expect(counts.get("user_sessions")).toBe(3);
    expect(counts.get("entries")).toBe(1);
    expect(counts.get("public.icons")).toBe(0);
  });

  it("matches whole words only", () => {
    expect(countEntityMentions("feedback on the newsfeed", ["feeds"]).get("feeds")).toBe(0);
  });

  it("reads only the head of a very long spec", () => {
    const text = `${"x ".repeat(MAX_SCANNED_SPEC_CHARS)}feed`;
    expect(countEntityMentions(text, ["feeds"]).get("feeds")).toBe(0);
  });

  it("is linear in the spec text, whatever it is made of", () => {
    for (const unit of ["feed ", "a_", "`", "feed_", "\n# ", "é "]) {
      expectLinearTime(`countEntityMentions on ${JSON.stringify(unit)}`, (size) => {
        const text = unit.repeat(Math.ceil(size / unit.length));
        return () => countEntityMentions(text, ["feeds", "entries"]);
      });
    }
  });
});

describe("rankTables", () => {
  const touch = (table: string, fromSymbolId: string, depth = 0) => ({
    table,
    fromSymbolId,
    depth,
  });

  it("ranks by reach times mentions, and counts a symbol once per table", () => {
    const ranked = rankTables(
      [touch("feeds", "a"), touch("feeds", "a"), touch("feeds", "b", 1), touch("users", "a")],
      new Map([
        ["feeds", 3],
        ["users", 0],
      ]),
    );
    // feeds: (1 + 0.5) × 4 = 6; users: 1 × 1 = 1, under a quarter of the best.
    expect(ranked).toEqual([{ name: "feeds", score: 6 }]);
  });

  it("keeps a symbol's closest touch, and at most two tables", () => {
    const ranked = rankTables(
      [touch("a", "x", 2), touch("a", "x", 0), touch("b", "x"), touch("c", "x"), touch("d", "x")],
      new Map(),
    );
    expect(ranked.map((t) => t.name)).toEqual(["a", "b"]);
    expect(ranked[0]!.score).toBe(1);
  });

  it("returns nothing when nothing was touched", () => {
    expect(rankTables([], new Map())).toEqual([]);
  });
});

describe("roundRobin", () => {
  it("gives every group one row before any group gets a second", () => {
    expect(roundRobin(["a1", "a2", "a3", "b1", "c1", "b2"], (s) => s[0]!)).toEqual([
      "a1",
      "b1",
      "c1",
      "a2",
      "b2",
      "a3",
    ]);
    expect(roundRobin([], () => "x")).toEqual([]);
  });
});

describe("nameSome", () => {
  it("spells out the first names and counts the rest", () => {
    expect(nameSome(["a", "b"])).toBe("a, b");
    const many = Array.from({ length: MAX_NAMED_LEFT_OUT + 3 }, (_, i) => `n${i}`);
    expect(nameSome(many)).toBe(`${many.slice(0, MAX_NAMED_LEFT_OUT).join(", ")} +3 more`);
  });
});

describe("renderLocalisation", () => {
  const section = (title: string, n: number, excerpt?: string): LocalisationSection => ({
    title,
    entries: Array.from({ length: n }, (_, i) => ({
      line: `${title}${i} — pkg/${title}.go:${i}-${i + 1}`,
      filePath: `pkg/${title}.go`,
      label: `${title}${i}`,
      ...(excerpt ? { excerpt } : {}),
    })),
  });

  it("renders nothing for no sections, or sections with no entry", () => {
    expect(renderLocalisation([], 1000).block).toBe("");
    expect(renderLocalisation([section("A", 0)], 1000).block).toBe("");
  });

  it("lists each file once, in first-named order", () => {
    const r = renderLocalisation([section("A", 2), section("B", 1)], 1000);
    expect(r.files).toEqual(["pkg/A.go", "pkg/B.go"]);
    expect(r.usedSymbols).toBe(3);
  });

  it("stops excerpts at the first that does not fit, so the order shown is the order ranked", () => {
    const big = "x".repeat(400);
    const r = renderLocalisation([section("A", 3, big)], 420);
    expect(r.block.match(/x{400}/g)).toHaveLength(2);
    expect(r.dropped).toEqual([
      "Excerpts not shown for the token budget (the locator is listed): A2",
    ]);
  });
});

// ── The production source ────────────────────────────────────────────────────

describe("createDefaultPlanLocalisationSource", () => {
  it("reads only the given project's graph", async () => {
    vi.resetModules();
    const codeEdge = { findMany: vi.fn() };
    const codeSymbol = { findMany: vi.fn() };
    vi.doMock("../prisma.js", () => ({ prisma: { codeEdge, codeSymbol } }));
    const mod = await import("./plan-localisation.js");
    const source = mod.createDefaultPlanLocalisationSource("p1");

    codeEdge.findMany.mockResolvedValueOnce([{ fromSymbolId: "f", toSymbolId: "c" }]);
    await expect(source.getReaderEdgesTo(["c"])).resolves.toEqual([
      { fromSymbolId: "f", toSymbolId: "c" },
    ]);
    expect(codeEdge.findMany.mock.calls[0]![0].where).toEqual({
      projectId: "p1",
      kind: "reads",
      toSymbolId: { in: ["c"] },
    });
    await expect(source.getReaderEdgesTo([])).resolves.toEqual([]);

    await expect(source.getFunctionsInFiles([])).resolves.toEqual([]);
    codeSymbol.findMany.mockResolvedValueOnce([]);
    await source.getFunctionsInFiles(["a.go"]);
    expect(codeSymbol.findMany.mock.calls[0]![0].where).toMatchObject({
      projectId: "p1",
      filePath: { in: ["a.go"] },
      kind: { in: ["function", "method"] },
      language: { not: "sql" },
    });

    codeEdge.findMany.mockResolvedValueOnce([
      { fromSymbolId: "f", toQualifiedName: "A" },
      { fromSymbolId: "f", toQualifiedName: "B" },
      { fromSymbolId: "g", toQualifiedName: "A" },
    ]);
    const names = await source.calleeNameSets();
    expect([...names.get("f")!]).toEqual(["A", "B"]);
    expect([...names.get("g")!]).toEqual(["A"]);
    expect(codeEdge.findMany.mock.calls.at(-1)![0].where).toEqual({
      projectId: "p1",
      kind: "calls",
      toQualifiedName: { not: null },
    });
    vi.doUnmock("../prisma.js");
  });
});
