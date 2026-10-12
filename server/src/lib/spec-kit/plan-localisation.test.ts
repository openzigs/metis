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
  type Edge,
  type Sym,
} from "../../../tests/helpers/plan-localisation-graph.js";
import { DEFAULT_MAX_DOWNSTREAM_DEPTH } from "../impact-analysis/schema-impact.js";
import {
  MAX_TWINS,
  MAX_TWINS_PER_SEED,
  MAX_TWIN_SEEDS,
} from "../impact-analysis/structural-twins.js";
import {
  LOCALISATION_HEADER,
  LOCALISATION_TIME_BUDGET_MS,
  MAX_CALLEES,
  MAX_COLUMNS_PER_WRITER,
  MAX_FUNCTIONS_PER_SEED_FILE,
  MAX_LISTED_TWINS,
  MAX_NAMED_CALLERS,
  MAX_NAMED_LEFT_OUT,
  MAX_OTHER_CALLEES,
  MAX_READERS_PER_TABLE,
  MAX_SCANNED_SPEC_CHARS,
  MAX_TABLES,
  MAX_TYPE_EXCERPT_CHARS,
  MAX_WRITERS_PER_TABLE,
  MIN_TABLE_SHARE,
  TWIN_MAX_CANDIDATES,
  TWIN_MAX_CANDIDATE_CALL_EDGES,
  TWIN_MAX_POOLED_CALLEE_NAMES,
  TWIN_MAX_PROJECT_CALL_EDGES,
  TWIN_TIME_BUDGET_MS,
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

/** The base fixture reaches `users` too (showFeedEntriesPage → UserByID); the spec is about feeds. */
const USERS_NOT_FOLLOWED =
  "Tables: 1 more table the retrieved code reaches was not followed (users)";

/**
 * Both time limits are off unless a test sets one: the block these tests pin
 * must not depend on how busy the machine is (the full gate runs every package
 * at once). The tests of the limits themselves pass their own.
 */
const localise = (over: Partial<Parameters<typeof buildPlanLocalisation>[0]> = {}) =>
  buildPlanLocalisation({
    projectId: "p1",
    requirementText: SPEC,
    seeds: SEEDS,
    tokenBudget: 4000,
    source: fakeSource(minifluxGraph()),
    timeBudgetMs: Number.POSITIVE_INFINITY,
    twinTimeBudgetMs: Number.POSITIVE_INFINITY,
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
    // Nothing was cut for the budget or a list cap; the one table not followed is said.
    expect(r.dropped).toEqual([USERS_NOT_FOLLOWED]);
  });

  it("lists every writer, the retrieved code's own first, and what each writes", async () => {
    // CreateFeed is the WIDER writer here (three columns to UpdateFeed's two), so
    // width alone would put it first: only "what the retrieved code reaches"
    // puts UpdateFeed, which the retrieved handler calls, above it.
    const graph = minifluxGraph();
    graph.edges.push(
      { from: "st-create", to: "col-checked", kind: "writes" },
      { from: "st-create", to: "col-id", kind: "writes" },
    );
    const r = await localise({ source: fakeSource(graph) });
    const writers = r.block.slice(
      r.block.indexOf("### Writers of `feeds`"),
      r.block.indexOf("### Readers of `feeds`"),
    );
    expect(writers).toContain("CreateFeed (function) — internal/storage/feed.go:216-225 — writes");
    expect(writers.indexOf("- UpdateFeed")).toBeGreaterThan(-1);
    expect(writers.indexOf("- UpdateFeed")).toBeLessThan(writers.indexOf("- CreateFeed"));
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

  it("does not list what the retrieval already named, and lists nothing twice", async () => {
    const graph = minifluxGraph();
    graph.edges.push(
      // A retrieved handler calls the other retrieved function, and reads the table itself.
      { from: "h-refresh", to: "f-show", kind: "calls", callee: "showFeedEntriesPage" },
      { from: "h-refresh", to: "col-id", kind: "reads" },
      // The twin of a retrieved function is also called by retrieved code.
      { from: "h-refresh", to: "f-cat", kind: "calls", callee: "showCategoryEntriesPage" },
    );
    const r = await localise({ source: fakeSource(graph) });
    const rows = (name: string) => r.block.split("\n").filter((l) => l.startsWith(`- ${name} (`));
    // Retrieved: never a row, neither as a callee nor as a reader.
    expect(rows("refreshFeed")).toHaveLength(0);
    expect(rows("showFeedEntriesPage")).toHaveLength(0);
    // Listed once: a writer the handler calls is not also a callee …
    expect(rows("UpdateFeed")).toHaveLength(1);
    // … and a callee is not also a twin.
    expect(rows("showCategoryEntriesPage")).toHaveLength(1);
    expect(r.block).toContain(
      "- showCategoryEntriesPage (function) — internal/ui/category_entries.go:15-24 (called by refreshFeed)",
    );
    expect(r.block).not.toContain("built like");
  });

  it("lists a function that reads one table and writes another as a reader of the first", async () => {
    // Review #1094 L3: `DupAToB` reads alpha and writes beta. "Readers of alpha"
    // means "without writing ALPHA".
    const symbols = [
      sym("top", "function", "ui/top.go::top", "ui/top.go"),
      sym("tbl-a", "table", "alpha", MIGRATIONS, 1),
      sym("tbl-b", "table", "beta", MIGRATIONS, 2),
      sym("wa", "function", `${STORAGE}/a.go::WriteA`, `${STORAGE}/a.go`),
      sym("dup", "function", `${STORAGE}/dup.go::DupAToB`, `${STORAGE}/dup.go`),
    ];
    const edges: Edge[] = [
      { from: "top", to: "wa", kind: "calls", callee: "WriteA" },
      { from: "top", to: "dup", kind: "calls", callee: "DupAToB" },
      { from: "wa", to: "tbl-a", kind: "writes" },
      { from: "wa", to: "tbl-a", kind: "reads" },
      { from: "dup", to: "tbl-a", kind: "reads" },
      { from: "dup", to: "tbl-b", kind: "writes" },
    ];
    const r = await localise({
      requirementText: "alpha beta",
      seeds: [{ id: "top", name: "top", filePath: "ui/top.go", kind: "function" }],
      source: fakeSource({ symbols, edges }),
    });
    expect(r.tables).toEqual(["alpha", "beta"]);
    const section = (title: string) => {
      const from = r.block.indexOf(`### ${title}`);
      const to = r.block.indexOf("\n\n###", from + 1);
      return from === -1 ? "" : r.block.slice(from, to === -1 ? undefined : to);
    };
    expect(section("Readers of `alpha`")).toContain("- DupAToB (function)");
    expect(section("Writers of `beta`")).toContain("- DupAToB (function)");
    // WriteA reads alpha too, and writes it: a writer of alpha, not a reader of it.
    expect(section("Readers of `alpha`")).not.toContain("WriteA");
    expect(section("Writers of `alpha`")).toContain("- WriteA (function)");
  });

  it("takes the second call hop only inside the data layer", async () => {
    const graph = minifluxGraph();
    graph.symbols.push(
      // Called by the data layer, from outside it: a second-hop callee that is not kept, and counted.
      sym("deep", "function", "internal/timezone/tz.go::Convert", "internal/timezone/tz.go"),
      // Called by a first-hop callee that is itself outside the data layer: not followed.
      sym(
        "enc",
        "function",
        "internal/http/response/enc.go::Encode",
        "internal/http/response/enc.go",
      ),
    );
    graph.edges.push(
      { from: "st-byid", to: "deep", kind: "calls", callee: "Convert" },
      { from: "util-json", to: "enc", kind: "calls", callee: "Encode" },
    );
    const r = await localise({ source: fakeSource(graph) });
    // The hop itself is still taken where it should be.
    expect(r.block).toContain("- NewFeedQueryBuilder (function)");
    expect(r.block).not.toContain("Convert");
    expect(r.block).not.toContain("Encode");
    expect(r.files).not.toContain("internal/timezone/tz.go");
    expect(r.files).not.toContain("internal/http/response/enc.go");
    // `Convert` was read and then not kept, so it is counted. `Encode` was never
    // read (the hop is not taken from outside the data layer): nothing to count.
    expect(r.dropped).toEqual([
      "Called by the Retrieved Code and the Data Layer: 1 callee one call further out, outside the data layer, not listed (in internal/timezone/tz.go)",
      USERS_NOT_FOLLOWED,
    ]);
  });

  it("never names a test or a synthetic SQL origin as a reader, a callee or a twin", async () => {
    const graph = minifluxGraph();
    graph.symbols.push(
      sym(
        "t-reader",
        "function",
        `${STORAGE}/feed_test.go::TestFeedExists`,
        `${STORAGE}/feed_test.go`,
        30,
      ),
      sym("sql-reader", "method", `${MIGRATIONS}::sql@99`, MIGRATIONS, 99),
      sym("t-callee", "function", "internal/ui/ui_test.go::fakeStore", "internal/ui/ui_test.go"),
      sym("sql-callee", "method", `${STORAGE}/feed.go::sql@205`, `${STORAGE}/feed.go`, 205),
      sym(
        "t-twin",
        "function",
        "internal/ui/feed_entries_test.go::testShowPage",
        "internal/ui/feed_entries_test.go",
      ),
    );
    graph.edges.push(
      { from: "t-reader", to: "col-id", kind: "reads" },
      { from: "sql-reader", to: "col-id", kind: "reads" },
      { from: "h-refresh", to: "t-callee", kind: "calls", callee: "fakeStore" },
      { from: "st-byid", to: "sql-callee", kind: "calls", callee: "sql@205" },
    );
    for (const callee of ["a", "b", "c", "d", "e", "f", "g"]) {
      graph.edges.push({ from: "t-twin", to: "", kind: "calls", callee });
    }
    const r = await localise({ source: fakeSource(graph) });
    for (const name of ["TestFeedExists", "sql@99", "fakeStore", "sql@205", "testShowPage"]) {
      expect(r.block, name).not.toContain(name);
    }
    for (const file of [
      `${STORAGE}/feed_test.go`,
      "internal/ui/ui_test.go",
      "internal/ui/feed_entries_test.go",
    ]) {
      expect(r.files, file).not.toContain(file);
    }
    // The production rows beside them are all still there.
    expect(r.block).toContain("- FeedExists (function)");
    expect(r.block).toContain("- NewFeedQueryBuilder (function)");
    expect(r.block).toContain("- showCategoryEntriesPage (function)");
  });

  it("renders the same block whatever order the graph returns its rows in", async () => {
    // Review #1094 L4: the block sits in the cached system prefix of five calls.
    // The fake source returns rows in array order, as a query without `orderBy` may.
    const graph = minifluxGraph();
    // A callee with more callers than are named: WHICH three are named must not move.
    graph.symbols.push(
      sym("h3", "function", "internal/ui/a.go::alphaPage", "internal/ui/a.go"),
      sym("h4", "function", "internal/ui/z.go::zetaPage", "internal/ui/z.go"),
    );
    for (const from of ["h3", "h4"]) {
      graph.edges.push({ from, to: "st-byid", kind: "calls", callee: "FeedByID" });
    }
    // More functions in the retrieved file than are walked: WHICH are left out must not move.
    for (let i = 0; i < MAX_FUNCTIONS_PER_SEED_FILE + 1; i++) {
      graph.symbols.push(
        sym(
          `more${i}`,
          "function",
          `internal/ui/feed_entries.go::helper${i}`,
          "internal/ui/feed_entries.go",
          100 + i * 10,
        ),
      );
    }
    const seeds: LocalisationSeed[] = [
      ...SEEDS,
      { id: "h4", name: "zetaPage", filePath: "internal/ui/z.go" },
      { id: "h3", name: "alphaPage", filePath: "internal/ui/a.go" },
    ];
    const run = (symbols: Sym[], edges: Edge[]) =>
      localise({
        // Both tables are followed: two table rows, whose order must not move either.
        requirementText: "Show the feed owner: the user of each feed.",
        seeds,
        tokenBudget: 20_000,
        source: fakeSource({ symbols, edges }),
      });
    const a = await run(graph.symbols, graph.edges);
    const b = await run(graph.symbols, [...graph.edges].reverse());
    const c = await run([...graph.symbols].reverse(), [...graph.edges].reverse());
    expect(a.tables).toEqual(["feeds", "users"]);
    expect(a.block).toContain(
      [
        "- table `users` — defined in internal/database/migrations.go (a schema change to it goes in this file)",
        "- table `feeds` — defined in internal/database/migrations.go (a schema change to it goes in this file)",
      ].join("\n"),
    );
    expect(a.dropped.join("\n")).toContain(
      "Retrieved files: 2 functions were not followed, past the first 12 of a retrieved file (helper11 in internal/ui/feed_entries.go, helper12 in internal/ui/feed_entries.go)",
    );
    expect(a.block).toContain(
      "- FeedByID (function) — internal/storage/feed.go:200-209 (called by alphaPage, refreshFeed, showFeedEntriesPage +1 more)",
    );
    expect(b.block).toBe(a.block);
    expect(c.block).toBe(a.block);
    expect(c.files).toEqual(a.files);
    expect(c.dropped).toEqual(a.dropped);
  });

  it("keeps a table the spec does not name out, and a second one it does name in", async () => {
    // `users` is reached (showFeedEntriesPage → UserByID) but the spec is about feeds.
    expect((await localise()).tables).toEqual(["feeds"]);
    const both = await localise({ requirementText: "Show the feed owner: the user of each feed." });
    expect(both.tables).toEqual(["feeds", "users"]);
    expect(both.block).toContain("### Data model of `feeds`, `users`");
    expect(both.block).toContain("### Readers of `users`");
    // UserByID reads `users` and is called by the retrieved page: listed as a
    // reader, and not a second time under what the retrieved code calls.
    expect(both.block.match(/^- UserByID \(/gm)).toHaveLength(1);
    expect(both.block.slice(both.block.indexOf("### Readers of `users`"))).toContain(
      "- UserByID (function) — internal/storage/user.go:345-354\n",
    );
  });

  it("ranks a table reached one call out above one reached two calls out", async () => {
    // Neither table is named by the spec, and one function touches each: only
    // the call depth tells them apart. Without it they tie, and `alpha` sorts first.
    const symbols = [
      sym("top", "function", "ui/top.go::top", "ui/top.go"),
      sym("near", "function", `${STORAGE}/near.go::Near`, `${STORAGE}/near.go`),
      sym("mid", "function", `${STORAGE}/mid.go::Mid`, `${STORAGE}/mid.go`),
      sym("far", "function", `${STORAGE}/far.go::Far`, `${STORAGE}/far.go`),
      sym("tbl-z", "table", "zeta", MIGRATIONS, 1),
      sym("tbl-a", "table", "alpha", MIGRATIONS, 2),
    ];
    const edges: Edge[] = [
      { from: "top", to: "near", kind: "calls", callee: "Near" },
      { from: "top", to: "mid", kind: "calls", callee: "Mid" },
      { from: "mid", to: "far", kind: "calls", callee: "Far" },
      { from: "near", to: "tbl-z", kind: "writes" },
      { from: "far", to: "tbl-a", kind: "writes" },
    ];
    const r = await localise({
      requirementText: "nothing that names a table",
      seeds: [{ id: "top", name: "top", filePath: "ui/top.go", kind: "function" }],
      source: fakeSource({ symbols, edges }),
    });
    expect(r.tables).toEqual(["zeta", "alpha"]);
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
      USERS_NOT_FOLLOWED,
    ]);
    expect(tight.block).toContain("### Left out of this block");
    for (const sentence of tight.dropped) expect(tight.block).toContain(`- ${sentence}`);
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
    // The rows themselves are capped, not only counted: a list of all 21 writers
    // under "5 more not listed" would say one thing and show another.
    const rowsOf = (title: string) => {
      const from = r.block.indexOf(`### ${title}`);
      const to = r.block.indexOf("\n### ", from + 1);
      return r.block.slice(from, to === -1 ? undefined : to).match(/^- /gm) ?? [];
    };
    expect(rowsOf("Writers of `feeds`")).toHaveLength(MAX_WRITERS_PER_TABLE);
    expect(rowsOf("Readers of `feeds`")).toHaveLength(MAX_READERS_PER_TABLE);
    expect(all).toMatch(
      /Called by the Retrieved Code and the Data Layer: \d+ more callees not listed/,
    );
    // Only so many callees outside the data layer are listed (JSON and three of
    // the six added here); the rest are counted.
    expect(r.block.match(/^- (?:Other\d+|JSON) \(/gm)).toHaveLength(MAX_OTHER_CALLEES);
    // showFeedEntriesPage has six twins (the category page and five added) and
    // `second` has five. The finder keeps four for each: eight, of which six are
    // listed. Left out: the two this list's cap removed AND the three the
    // finder's own per-function cap removed before this list saw them.
    expect(all).toMatch(/Structural Twins of Retrieved Functions: 5 more twins not listed/);
    expect(r.block.match(/built like/g)).toHaveLength(MAX_LISTED_TWINS);
    // Every sentence is in the block the model reads, not only in the result.
    for (const sentence of r.dropped) expect(r.block).toContain(`- ${sentence}`);
    // A long list of files is cut to a count, never to silence.
    expect(all).toMatch(/\+\d+ more\)/);
  });
});

// ── Every cap says what it cut ───────────────────────────────────────────────
//
// One fixture per constant that EXCEEDS it. A cap applied where the block is
// rendered is easy to count; the ones below are applied upstream (where tables
// are ranked, a file is expanded, twins are found) and used to cut before
// anything was counted (#1094 review M1, L1, L2). Each test asserts the sentence
// in `dropped` AND in the block: the command's message and `plan-context.md`
// are built from `dropped` (`spec-kit-mvp-runners.test.ts`).

/** `dropped` has a sentence matching `pattern`, and the block's closing note carries it. */
function expectLeftOut(r: { block: string; dropped: string[] }, pattern: RegExp): string {
  const sentence = r.dropped.find((d) => pattern.test(d));
  expect(sentence, `${pattern} in ${JSON.stringify(r.dropped)}`).toBeDefined();
  const note = r.block.slice(r.block.indexOf("### Left out of this block"));
  expect(note).toContain(`- ${sentence}`);
  return sentence as string;
}

const TOP_SEED: LocalisationSeed[] = [
  { id: "top", name: "top", filePath: "ui/top.go", kind: "function" },
];

/** One retrieved handler calling one writer for each of `names`' tables. */
function tablesGraph(names: readonly string[]): { symbols: Sym[]; edges: Edge[] } {
  const symbols: Sym[] = [sym("top", "function", "ui/top.go::top", "ui/top.go")];
  const edges: Edge[] = [];
  for (const t of names) {
    symbols.push(
      sym(`tbl-${t}`, "table", t, MIGRATIONS, 10),
      sym(`w-${t}`, "function", `${STORAGE}/${t}.go::Write${t}`, `${STORAGE}/${t}.go`),
    );
    edges.push(
      { from: "top", to: `w-${t}`, kind: "calls", callee: `Write${t}` },
      { from: `w-${t}`, to: `tbl-${t}`, kind: "writes" },
    );
  }
  return { symbols, edges };
}

describe("buildPlanLocalisation — every cap says what it cut", () => {
  it("MAX_TABLES: names the tables it reached and did not follow", async () => {
    const names = ["alpha", "beta", "gamma", "delta"];
    expect(names.length).toBeGreaterThan(MAX_TABLES);
    const r = await localise({
      requirementText: names.join(" "),
      seeds: TOP_SEED,
      source: fakeSource(tablesGraph(names)),
    });
    expect(r.tables).toEqual(["alpha", "beta"]);
    expect(expectLeftOut(r, /^Tables: /)).toBe(
      "Tables: 2 more tables the retrieved code reaches were not followed (delta, gamma)",
    );
  });

  it("MIN_TABLE_SHARE: names a table it reached and ranked too low to follow", async () => {
    // One table is kept, so MAX_TABLES is not what cut `users`.
    const r = await localise();
    expect(r.tables).toEqual(["feeds"]);
    expect(MIN_TABLE_SHARE).toBeGreaterThan(0);
    expect(expectLeftOut(r, /^Tables: /)).toBe(USERS_NOT_FOLLOWED);
  });

  it("MAX_FUNCTIONS_PER_SEED_FILE: names the functions of a retrieved file it did not walk", async () => {
    const n = MAX_FUNCTIONS_PER_SEED_FILE + 2;
    const symbols: Sym[] = [
      sym("m", "module", "ui/page.go", "ui/page.go"),
      sym("tbl-feeds", "table", "feeds", MIGRATIONS, 10),
      sym("w", "function", `${STORAGE}/feed.go::UpdateFeed`, `${STORAGE}/feed.go`),
      sym("w2", "function", `${STORAGE}/feed.go::RemoveFeed`, `${STORAGE}/feed.go`, 50),
    ];
    const edges: Edge[] = [
      { from: "w", to: "tbl-feeds", kind: "writes" },
      { from: "w2", to: "tbl-feeds", kind: "writes" },
    ];
    for (let i = 0; i < n; i++) {
      const name = `fn${String(i).padStart(2, "0")}`;
      symbols.push(sym(`f${i}`, "function", `ui/page.go::${name}`, "ui/page.go", 10 + i * 10));
    }
    // The first function reaches the table; so does the LAST, which is past the cap.
    edges.push(
      { from: "f0", to: "w", kind: "calls", callee: "UpdateFeed" },
      { from: `f${n - 1}`, to: "w2", kind: "calls", callee: "RemoveFeed" },
    );
    const seeds = [{ id: "m", name: "page.go", filePath: "ui/page.go", kind: "module" }];
    const r = await localise({
      requirementText: "feed",
      seeds,
      source: fakeSource({ symbols, edges }),
    });
    expect(expectLeftOut(r, /^Retrieved files: /)).toBe(
      `Retrieved files: 2 functions were not followed, past the first ${MAX_FUNCTIONS_PER_SEED_FILE} of a retrieved file (fn12 in ui/page.go, fn13 in ui/page.go)`,
    );
    // Review L1's own shape: ONLY the function past the cap reaches anything.
    // Nothing can be listed, so there is no block, and the result still says why.
    const only = await localise({
      requirementText: "feed",
      seeds,
      source: fakeSource({ symbols, edges: edges.filter((e) => e.from !== "f0") }),
    });
    expect(only.block).toBe("");
    expect(only.dropped).toEqual([
      `Retrieved files: 2 functions were not followed, past the first ${MAX_FUNCTIONS_PER_SEED_FILE} of a retrieved file (fn12 in ui/page.go, fn13 in ui/page.go)`,
    ]);
  });

  it("MAX_FUNCTIONS_PER_SEED_FILE: a function retrieved in its own right does not use up the file's allowance", async () => {
    const symbols: Sym[] = [sym("m", "module", "ui/page.go", "ui/page.go")];
    for (let i = 0; i <= MAX_FUNCTIONS_PER_SEED_FILE; i++) {
      symbols.push(sym(`f${i}`, "function", `ui/page.go::fn${i}`, "ui/page.go", 10 + i * 10));
    }
    const r = await localise({
      seeds: [
        { id: "f0", name: "fn0", filePath: "ui/page.go", kind: "function" },
        { id: "m", name: "page.go", filePath: "ui/page.go", kind: "module" },
      ],
      source: fakeSource({ symbols, edges: [] }),
    });
    // Thirteen functions: one retrieved directly, twelve from the file. None is cut.
    expect(r.dropped).toEqual([]);
  });

  it("MAX_COLUMNS_PER_WRITER and MAX_NAMED_CALLERS: a row cut short is counted on the row and named", async () => {
    const graph = minifluxGraph();
    for (let i = 0; i < MAX_COLUMNS_PER_WRITER; i++) {
      graph.symbols.push(sym(`col-x${i}`, "column", `feeds.x${i}`, `${STORAGE}/feed.go`));
      graph.edges.push({ from: "st-update", to: `col-x${i}`, kind: "writes" });
    }
    const seeds: LocalisationSeed[] = [...SEEDS];
    for (let i = 0; i < MAX_NAMED_CALLERS; i++) {
      graph.symbols.push(
        sym(`p${i}`, "function", `internal/ui/p${i}.go::page${i}`, `internal/ui/p${i}.go`),
      );
      graph.edges.push({ from: `p${i}`, to: "st-byid", kind: "calls", callee: "FeedByID" });
      seeds.push({ id: `p${i}`, name: `page${i}`, filePath: `internal/ui/p${i}.go` });
    }
    const r = await localise({ seeds, source: fakeSource(graph), tokenBudget: 20_000 });
    // UpdateFeed writes checked_at, title and five more: seven columns, five named.
    expect(r.block).toContain(
      "- UpdateFeed (function) — internal/storage/feed.go:331-340 — writes checked_at, title, x0, x1, x2 +2 more",
    );
    expect(expectLeftOut(r, /^Writers of `feeds`: 1 writer with more than/)).toBe(
      `Writers of \`feeds\`: 1 writer with more than ${MAX_COLUMNS_PER_WRITER} columns: the rest are counted on the row, not named (UpdateFeed)`,
    );
    // FeedByID has five callers, three named.
    expect(r.block).toContain("(called by page0, page1, page2 +2 more)");
    expect(expectLeftOut(r, /1 callee with more than/)).toBe(
      `Called by the Retrieved Code and the Data Layer: 1 callee with more than ${MAX_NAMED_CALLERS} callers: the rest are counted on the row, not named (FeedByID)`,
    );
  });

  it("MAX_TYPE_EXCERPT_CHARS: says which type declaration was cut", async () => {
    const graph = minifluxGraph();
    const model = graph.symbols.find((s) => s.id === "ty-model")!;
    const fields = Array.from({ length: 200 }, (_, i) => `\tField${i} string`).join("\n");
    model.text = `class Feed in internal/model/feed.go\ntype Feed struct {\n${fields}\n}`;
    expect(model.text.length).toBeGreaterThan(MAX_TYPE_EXCERPT_CHARS);
    const r = await localise({ source: fakeSource(graph), tokenBudget: 20_000 });
    expect(r.block).toContain("… (excerpt cut)");
    expect(r.block).not.toContain("Field199");
    expect(expectLeftOut(r, /type declaration cut/)).toBe(
      "Data model of `feeds`: 1 type declaration cut at 1,600 characters (Feed in internal/model/feed.go)",
    );
  });

  it("MAX_SCANNED_SPEC_CHARS: says how much of a long spec was read for table names", async () => {
    const text = `${SPEC} ${"x ".repeat(MAX_SCANNED_SPEC_CHARS / 2)}`;
    const r = await localise({ requirementText: text });
    expect(expectLeftOut(r, /^Spec text: /)).toBe(
      `Spec text: only the first 20,000 of ${text.length.toLocaleString("en-US")} characters were read for table names`,
    );
    // A spec that fits is read whole, and nothing is said.
    expect((await localise()).dropped.join("\n")).not.toContain("Spec text:");
  });

  /** `seeds` retrieved functions with seven callee names each, and `twinsEach` twins for each. */
  function twinsGraph(seeds: number, twinsEach: number) {
    const symbols: Sym[] = [];
    const edges: Edge[] = [];
    const retrieved: LocalisationSeed[] = [];
    for (let s = 0; s < seeds; s++) {
      const id = `s${String(s).padStart(2, "0")}`;
      symbols.push(sym(id, "function", `ui/${id}.go::seed${s}`, `ui/${id}.go`));
      retrieved.push({ id, name: `seed${s}`, filePath: `ui/${id}.go` });
      const callees = Array.from({ length: 7 }, (_, c) => `${id}-callee${c}`);
      for (const callee of callees) edges.push({ from: id, to: "", kind: "calls", callee });
      for (let t = 0; t < twinsEach; t++) {
        const twin = `${id}-t${t}`;
        symbols.push(sym(twin, "function", `ui/${twin}.go::twin${s}x${t}`, `ui/${twin}.go`));
        for (const callee of callees) edges.push({ from: twin, to: "", kind: "calls", callee });
      }
    }
    return { graph: { symbols, edges }, retrieved };
  }

  it("MAX_TWINS_PER_SEED: counts the twins the finder cut before this list saw them", async () => {
    const { graph, retrieved } = twinsGraph(1, MAX_TWINS_PER_SEED + 3);
    const r = await localise({ seeds: retrieved, source: fakeSource(graph) });
    expect(r.block.match(/built like seed0/g)).toHaveLength(MAX_TWINS_PER_SEED);
    expect(MAX_TWINS_PER_SEED).toBeLessThan(MAX_LISTED_TWINS);
    expect(expectLeftOut(r, /more twins not listed/)).toBe(
      "Structural Twins of Retrieved Functions: 3 more twins not listed (in ui/s00-t4.go, ui/s00-t5.go, ui/s00-t6.go)",
    );
  });

  it("MAX_TWINS: counts the twins the finder's overall cap cut", async () => {
    // Seven functions with four twins each: 28 found, 24 kept by the finder, six listed.
    const seeds = MAX_TWINS / MAX_TWINS_PER_SEED + 1;
    const { graph, retrieved } = twinsGraph(seeds, MAX_TWINS_PER_SEED);
    const r = await localise({ seeds: retrieved, source: fakeSource(graph) });
    expect(r.block.match(/built like/g)).toHaveLength(MAX_LISTED_TWINS);
    const found = seeds * MAX_TWINS_PER_SEED;
    expect(found).toBeGreaterThan(MAX_TWINS);
    expect(expectLeftOut(r, /more twins not listed/)).toContain(
      `Structural Twins of Retrieved Functions: ${found - MAX_LISTED_TWINS} more twins not listed (in `,
    );
  });

  it("MAX_TWIN_SEEDS: says how many retrieved functions were never compared", async () => {
    // showFeedEntriesPage comes from the retrieved FILE, so it is the last seed:
    // with 60 functions retrieved ahead of it, it is the 61st and is not compared.
    const graph = minifluxGraph();
    const seeds: LocalisationSeed[] = [SEEDS[0]!];
    for (let i = 1; i < MAX_TWIN_SEEDS; i++) {
      graph.symbols.push(
        sym(`x${i}`, "function", `internal/ui/x${i}.go::x${i}`, `internal/ui/x${i}.go`),
      );
      seeds.push({ id: `x${i}`, name: `x${i}`, filePath: `internal/ui/x${i}.go` });
    }
    seeds.push(SEEDS[1]!);
    const r = await localise({ seeds, source: fakeSource(graph) });
    expect(r.block).not.toContain("showCategoryEntriesPage");
    expect(expectLeftOut(r, /not compared for twins/)).toBe(
      `Structural Twins of Retrieved Functions: 1 retrieved function was not compared for twins, past the first ${MAX_TWIN_SEEDS}`,
    );
  });

  it("a twin step the source skipped is said, though the section has no row", async () => {
    const source = fakeSource(minifluxGraph());
    const skipped =
      "structural twins skipped: project has 2,500,000 call edges, over the limit of 2,000,000";
    source.calleeNameSets = async () => ({ sets: new Map(), skipped });
    const r = await localise({ source });
    expect(r.block).not.toContain("### Structural Twins");
    expect(expectLeftOut(r, /structural twins skipped/)).toBe(
      `Structural Twins of Retrieved Functions: ${skipped}`,
    );
    // The rest of the walk is unaffected.
    expect(r.files).toContain(`${STORAGE}/feed_query_builder.go`);
  });

  it("what the source left out while still answering is said beside the twins it found", async () => {
    const full = fakeSource(minifluxGraph());
    const source: PlanLocalisationSource = {
      ...full,
      calleeNameSets: async (ids) => ({
        ...(await full.calleeNameSets(ids)),
        notes: ["more than 2,000 functions share callee names with the retrieved code"],
      }),
    };
    const r = await localise({ source });
    expect(r.block).toContain("- showCategoryEntriesPage (function)");
    expectLeftOut(r, /more than 2,000 functions share callee names/);
  });

  it("second call hop: a callee outside the data layer is fetched, not listed, and counted", async () => {
    // handle → Load (data layer) → Format, Trace (plumbing). The second hop is
    // read to find query builders; what it finds elsewhere is in hand, so it is
    // counted like every other cut (#1094 cycle 2).
    const graph = {
      symbols: [
        sym("h", "function", "ui/h.go::handle", "ui/h.go"),
        sym("t-feeds", "table", "feeds", "db/migrations.go"),
        sym("c-id", "column", "feeds.id", "db/migrations.go"),
        sym("w", "function", "st/feed.go::SaveFeed", "st/feed.go"),
        sym("load", "function", "st/load.go::Load", "st/load.go"),
        sym("builder", "function", "st/builder.go::NewBuilder", "st/builder.go"),
        sym("fmt", "function", "util/format.go::Format", "util/format.go"),
        sym("trace", "function", "log/trace.go::Trace", "log/trace.go"),
      ] as Sym[],
      edges: [
        { from: "w", to: "c-id", kind: "writes" },
        { from: "h", to: "w", kind: "calls", callee: "SaveFeed" },
        { from: "h", to: "load", kind: "calls", callee: "Load" },
        { from: "load", to: "builder", kind: "calls", callee: "NewBuilder" },
        { from: "load", to: "fmt", kind: "calls", callee: "Format" },
        { from: "load", to: "trace", kind: "calls", callee: "Trace" },
      ] as Edge[],
    };
    const r = await localise({
      requirementText: "feeds",
      seeds: [{ id: "h", name: "handle", filePath: "ui/h.go", kind: "function" }],
      tokenBudget: 20_000,
      source: fakeSource(graph),
    });
    // The second hop inside the data layer is listed, as before.
    expect(r.block).toContain("- Load (function)");
    expect(r.block).toContain("- NewBuilder (function)");
    expect(r.block).not.toContain("- Format (function)");
    expect(r.block).not.toContain("- Trace (function)");
    expect(expectLeftOut(r, /one call further out/)).toBe(
      "Called by the Retrieved Code and the Data Layer: 2 callees one call further out, outside the data layer, not listed (in log/trace.go, util/format.go)",
    );
  });

  it("second call hop: not taken from a callee outside the data layer, so there is nothing in hand to count", async () => {
    // handle → D1 → D2, neither in the data layer. D2 is never read: this is the
    // depth bound the header states, not a cut.
    const graph = {
      symbols: [
        sym("h", "function", "ui/h.go::handle", "ui/h.go"),
        sym("t-feeds", "table", "feeds", "db/migrations.go"),
        sym("c-id", "column", "feeds.id", "db/migrations.go"),
        sym("w", "function", "st/feed.go::SaveFeed", "st/feed.go"),
        sym("d1", "function", "svc/d.go::D1", "svc/d.go", 20),
        sym("d2", "function", "svc/d.go::D2", "svc/d.go", 40),
      ] as Sym[],
      edges: [
        { from: "w", to: "c-id", kind: "writes" },
        { from: "h", to: "w", kind: "calls", callee: "SaveFeed" },
        { from: "h", to: "d1", kind: "calls", callee: "D1" },
        { from: "d1", to: "d2", kind: "calls", callee: "D2" },
      ] as Edge[],
    };
    const source = fakeSource(graph);
    const asked = vi.spyOn(source.schema, "getCodeSymbolDetails");
    const r = await localise({
      requirementText: "feeds",
      seeds: [{ id: "h", name: "handle", filePath: "ui/h.go", kind: "function" }],
      tokenBudget: 20_000,
      source,
    });
    expect(r.block).toContain("- D1 (function)");
    expect(r.block).not.toContain("- D2 (function)");
    expect(r.dropped.filter((d) => d.includes("one call further out"))).toEqual([]);
    expect(asked.mock.calls.flatMap((c) => c[0])).not.toContain("d2");
  });

  it("the depth bounds are stated in the header: past them nothing is enumerated to count", () => {
    expect(DEFAULT_MAX_DOWNSTREAM_DEPTH).toBe(2);
    expect(LOCALISATION_HEADER).toContain("The walk goes two");
    expect(LOCALISATION_HEADER).toContain("calls out from the retrieved code and one more inside");
    expect(LOCALISATION_HEADER).toContain("code further away is");
  });
});

// ── The walk's own cost is bounded ───────────────────────────────────────────

/** Hold the thread for `ms`, as a synchronous SQLite query does. */
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // busy
  }
}

describe("buildPlanLocalisation — a slow walk does not delay the plan (#1094 review M2)", () => {
  it("has a time budget for the whole walk and a smaller one for the twin step", () => {
    expect(LOCALISATION_TIME_BUDGET_MS).toBe(5_000);
    expect(TWIN_TIME_BUDGET_MS).toBeLessThan(LOCALISATION_TIME_BUDGET_MS);
  });

  it("has no limit when the caller passes Infinity: nothing is skipped however slow a step is", async () => {
    // For a test or an offline replay. A read that comes back after a timer
    // turn: with a limit of Infinity handed to a timer, the timer fires at once.
    const source = fakeSource(minifluxGraph());
    const edges = source.schema.getSchemaEdgesFrom;
    source.schema.getSchemaEdgesFrom = async (ids) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return edges(ids);
    };
    const names = source.calleeNameSets;
    source.calleeNameSets = async (ids) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return names(ids);
    };
    const r = await localise({
      source,
      timeBudgetMs: Number.POSITIVE_INFINITY,
      twinTimeBudgetMs: Number.POSITIVE_INFINITY,
    });
    expect(r.block).toContain(LOCALISATION_HEADER);
    expect(r.block).toContain("- showCategoryEntriesPage (function)");
    expect(r.dropped.filter((d) => d.includes("skipped"))).toEqual([]);
    // The same walk with the limits unset is the same block: off is not a different walk.
    expect((await localise({ source: fakeSource(minifluxGraph()) })).block).toBe(r.block);
  });

  it("gives up on a query that does not come back, and says the localisation was skipped", async () => {
    const source = fakeSource(minifluxGraph());
    source.schema.getSchemaEdgesFrom = () => new Promise(() => undefined);
    const started = performance.now();
    const r = await localise({ source, timeBudgetMs: 30 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(r).toEqual({
      block: "",
      files: [],
      tables: [],
      usedSymbols: 0,
      dropped: [
        "Change localisation skipped: the code-graph walk did not finish within 30 ms, so this plan was given similarity retrieval alone",
      ],
    });
  });

  it("stops between steps when every query holds the thread, as with SQLite", async () => {
    // No timer can fire while the thread is held: the walk has to look at the clock itself.
    const source = fakeSource(minifluxGraph());
    let calls = 0;
    const slow =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        calls++;
        block(15);
        return fn(...args);
      };
    source.schema.getSchemaEdgesFrom = slow(source.schema.getSchemaEdgesFrom);
    source.schema.getSchemaSymbolsByIds = slow(source.schema.getSchemaSymbolsByIds);
    source.schema.getDataModelSymbols = slow(source.schema.getDataModelSymbols!);
    source.schema.getWriterEdgesTo = slow(source.schema.getWriterEdgesTo!);
    source.getReaderEdgesTo = slow(source.getReaderEdgesTo);
    const r = await localise({ source, timeBudgetMs: 20 });
    expect(r.block).toBe("");
    expect(r.dropped).toEqual([
      "Change localisation skipped: the code-graph walk did not finish within 20 ms, so this plan was given similarity retrieval alone",
    ]);
    // It stopped at the first look at the clock past the deadline, not at the end.
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("gives the event loop a turn during a walk made of synchronous steps", async () => {
    const source = fakeSource(minifluxGraph());
    const original = source.schema.getSchemaEdgesFrom;
    source.schema.getSchemaEdgesFrom = async (ids) => {
      block(30);
      return original(ids);
    };
    let turns = 0;
    const immediate = setImmediate(() => turns++);
    const r = await localise({ source });
    clearImmediate(immediate);
    expect(r.block).toContain(LOCALISATION_HEADER);
    // Without a yield every await here settles as a microtask and the callback never runs.
    expect(turns).toBe(1);
  });

  it("stops when its signal aborts, before or during the walk", async () => {
    const cancelled =
      "Change localisation skipped: the request was cancelled during the code-graph walk";
    const before = new AbortController();
    before.abort();
    const source = fakeSource(minifluxGraph());
    const spy = vi.spyOn(source.schema, "getSchemaEdgesFrom");
    expect((await localise({ source, signal: before.signal })).dropped).toEqual([cancelled]);
    expect(spy).not.toHaveBeenCalled();

    const during = new AbortController();
    const hung = fakeSource(minifluxGraph());
    hung.schema.getSchemaEdgesFrom = () => {
      queueMicrotask(() => during.abort());
      return new Promise(() => undefined);
    };
    const r = await localise({ source: hung, signal: during.signal });
    expect(r.block).toBe("");
    expect(r.dropped).toEqual([cancelled]);
  });

  it("skips only the twin step when that step is the slow one, and says so", async () => {
    const source = fakeSource(minifluxGraph());
    source.calleeNameSets = () => new Promise(() => undefined);
    // The whole walk has no limit here: only the twin step's can stop anything.
    const r = await localise({ source, twinTimeBudgetMs: 25 });
    // Everything before the twins is kept.
    expect(r.files).toContain(MIGRATIONS);
    expect(r.files).toContain(`${STORAGE}/feed_query_builder.go`);
    expect(r.block).not.toContain("showCategoryEntriesPage");
    expect(expectLeftOut(r, /structural twins skipped/)).toBe(
      "Structural Twins of Retrieved Functions: structural twins skipped: looking for them took longer than 25 ms",
    );
  });

  it("reports the whole walk's limit, not the twin step's, when the walk runs out during the twin step", async () => {
    // The twin step holds the thread past the WALK's limit and then looks at its
    // own clock, which carries the walk's deadline. "Twins skipped: took longer
    // than 5,000 ms" would be false: the walk stopped, at 60 ms.
    const source = fakeSource(minifluxGraph());
    source.calleeNameSets = async (_ids, checkpoint) => {
      block(120);
      await checkpoint?.();
      return { sets: new Map() };
    };
    const r = await localise({ source, timeBudgetMs: 60, twinTimeBudgetMs: 5_000 });
    expect(r.block).toBe("");
    expect(r.dropped).toEqual([
      "Change localisation skipped: the code-graph walk did not finish within 60 ms, so this plan was given similarity retrieval alone",
    ]);
  });

  it("stops a twin comparison that holds the thread, between two retrieved functions", async () => {
    const full = fakeSource(minifluxGraph());
    const source: PlanLocalisationSource = {
      ...full,
      calleeNameSets: async (ids) => {
        // A map whose iteration holds the thread: each seed's comparison costs 15 ms.
        const { sets } = await full.calleeNameSets(ids);
        const slowSets = new Map(sets);
        const entries = slowSets.entries.bind(slowSets);
        slowSets[Symbol.iterator] = () => {
          block(15);
          return entries();
        };
        return { sets: slowSets };
      },
    };
    // Two retrieved functions with enough callees to be compared.
    const seeds: LocalisationSeed[] = [
      { id: "f-show", name: "showFeedEntriesPage", filePath: "internal/ui/feed_entries.go" },
      { id: "f-cat", name: "showCategoryEntriesPage", filePath: "internal/ui/category_entries.go" },
    ];
    const r = await localise({ source, seeds, twinTimeBudgetMs: 10 });
    expectLeftOut(r, /structural twins skipped: looking for them took longer than 10 ms/);
  });

  it("propagates a failure of the twin step as a failure of the walk, not as a skip", async () => {
    const source = fakeSource(minifluxGraph());
    source.calleeNameSets = async () => {
      throw new Error("database is locked");
    };
    await expect(localise({ source })).resolves.toEqual({
      block: "",
      files: [],
      tables: [],
      dropped: [],
      usedSymbols: 0,
    });
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
    expect(ranked).toEqual({
      kept: [{ name: "feeds", score: 6 }],
      cut: [{ name: "users", score: 1 }],
    });
  });

  it("keeps a symbol's closest touch, and at most two tables, and returns the rest as cut", () => {
    const ranked = rankTables(
      [touch("a", "x", 2), touch("a", "x", 0), touch("b", "x"), touch("c", "x"), touch("d", "x")],
      new Map(),
    );
    expect(MAX_TABLES).toBe(2);
    expect(ranked.kept.map((t) => t.name)).toEqual(["a", "b"]);
    expect(ranked.kept[0]!.score).toBe(1);
    expect(ranked.cut.map((t) => t.name)).toEqual(["c", "d"]);
  });

  it("cuts a table under the share of the best one even when there is room for it", () => {
    // b scores 1 against a's 5: under MIN_TABLE_SHARE, though only one table is kept.
    const ranked = rankTables([touch("a", "x"), touch("b", "x")], new Map([["a", 4]]));
    expect(1 / 5).toBeLessThan(MIN_TABLE_SHARE);
    expect(ranked.kept.map((t) => t.name)).toEqual(["a"]);
    expect(ranked.cut.map((t) => t.name)).toEqual(["b"]);
  });

  it("returns nothing when nothing was touched", () => {
    expect(rankTables([], new Map())).toEqual({ kept: [], cut: [] });
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
    // More ids than one `IN (…)` list holds: each is asked for once, in lists SQLite can bind.
    codeEdge.findMany.mockReset();
    codeEdge.findMany.mockResolvedValue([]);
    const ids = Array.from({ length: 501 }, (_, i) => `col${i}`);
    await source.getReaderEdgesTo(ids);
    expect(codeEdge.findMany.mock.calls.flatMap((c) => c[0].where.toSymbolId.in)).toEqual(ids);
    for (const call of codeEdge.findMany.mock.calls) {
      expect(call[0].where.toSymbolId.in.length).toBeLessThanOrEqual(500);
    }
    codeEdge.findMany.mockReset();

    await expect(source.getFunctionsInFiles([])).resolves.toEqual([]);
    codeSymbol.findMany.mockResolvedValueOnce([]);
    await source.getFunctionsInFiles(["a.go"]);
    expect(codeSymbol.findMany.mock.calls[0]![0].where).toMatchObject({
      projectId: "p1",
      filePath: { in: ["a.go"] },
      kind: { in: ["function", "method"] },
      language: { not: "sql" },
    });

    // More files than one `IN (…)` list holds: every one of them is still asked for.
    codeSymbol.findMany.mockReset();
    codeSymbol.findMany.mockResolvedValue([]);
    const many = Array.from({ length: 501 }, (_, i) => `pkg/f${i}.go`);
    await source.getFunctionsInFiles(many);
    const asked = codeSymbol.findMany.mock.calls.flatMap((c) => c[0].where.filePath.in);
    expect(asked).toEqual(many);
    for (const call of codeSymbol.findMany.mock.calls) {
      expect(call[0].where.projectId).toBe("p1");
      expect(call[0].where.filePath.in.length).toBeLessThanOrEqual(500);
    }
    vi.doUnmock("../prisma.js");
  });
});

describe("createDefaultPlanLocalisationSource — callee names for the twin step (#1094 review M2)", () => {
  type Mock = ReturnType<typeof vi.fn>;
  async function load(): Promise<{
    source: PlanLocalisationSource;
    codeEdge: { findMany: Mock; count: Mock; groupBy: Mock };
    codeSymbol: { findMany: Mock };
  }> {
    vi.resetModules();
    const codeEdge = { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() };
    const codeSymbol = { findMany: vi.fn() };
    vi.doMock("../prisma.js", () => ({ prisma: { codeEdge, codeSymbol } }));
    const mod = await import("./plan-localisation.js");
    return { source: mod.createDefaultPlanLocalisationSource("p1"), codeEdge, codeSymbol };
  }
  const calls = (from: string, names: readonly string[]) =>
    names.map((toQualifiedName) => ({ fromSymbolId: from, toQualifiedName }));
  const SIX = ["A", "B", "C", "D", "E", "F"];

  it("reads the retrieved functions' callees, finds candidates by them, and reads only those", async () => {
    const { source, codeEdge } = await load();
    codeEdge.count.mockResolvedValue(21_666);
    codeEdge.findMany
      // The retrieved function's own calls (F twice: a name is counted once).
      .mockResolvedValueOnce([...calls("s", SIX), ...calls("s", ["F"])])
      // The one candidate's calls.
      .mockResolvedValueOnce(calls("t", [...SIX, "G"]));
    codeEdge.groupBy.mockResolvedValue([
      { fromSymbolId: "t", _count: { toQualifiedName: 6 } },
      // The retrieved function matches its own names: it is not read again.
      { fromSymbolId: "s", _count: { toQualifiedName: 7 } },
    ]);
    const checkpoint = vi.fn(async () => undefined);
    const r = await source.calleeNameSets(["s"], checkpoint);
    expect(r.skipped).toBeUndefined();
    expect(r.notes).toEqual([]);
    expect([...r.sets.get("s")!]).toEqual(SIX);
    expect([...r.sets.get("t")!]).toEqual([...SIX, "G"]);
    expect(checkpoint).toHaveBeenCalled();

    expect(codeEdge.count.mock.calls[0]![0]).toEqual({ where: { projectId: "p1", kind: "calls" } });
    expect(codeEdge.findMany.mock.calls[0]![0].where).toEqual({
      projectId: "p1",
      kind: "calls",
      fromSymbolId: { in: ["s"] },
      toQualifiedName: { not: null },
    });
    expect(codeEdge.groupBy.mock.calls[0]![0]).toEqual({
      by: ["fromSymbolId"],
      where: { projectId: "p1", kind: "calls", toQualifiedName: { in: SIX } },
      _count: { toQualifiedName: true },
      // A twin shares at least 70% of a union of six or more names: five.
      having: { toQualifiedName: { _count: { gte: 5 } } },
      orderBy: [{ _count: { toQualifiedName: "desc" } }, { fromSymbolId: "asc" }],
      // One more than the limit, to know there were more, and room for the
      // retrieved function itself, which matches its own names.
      take: TWIN_MAX_CANDIDATES + 2,
    });
    expect(codeEdge.findMany.mock.calls[1]![0]).toMatchObject({
      where: {
        projectId: "p1",
        kind: "calls",
        fromSymbolId: { in: ["t"] },
        toQualifiedName: { not: null },
      },
      take: TWIN_MAX_CANDIDATE_CALL_EDGES + 1,
    });
    // Never the whole project's call edges.
    for (const call of codeEdge.findMany.mock.calls) {
      expect(call[0].where.fromSymbolId).toBeDefined();
    }
    vi.doUnmock("../prisma.js");
  });

  it("TWIN_MAX_PROJECT_CALL_EDGES: skips the step on a project over the limit, reading nothing more", async () => {
    const { source, codeEdge } = await load();
    codeEdge.count.mockResolvedValue(TWIN_MAX_PROJECT_CALL_EDGES + 1);
    const r = await source.calleeNameSets(["s"]);
    expect(r.skipped).toBe(
      "structural twins skipped: project has 2,000,001 call edges, over the limit of 2,000,000",
    );
    expect(r.sets.size).toBe(0);
    expect(codeEdge.findMany).not.toHaveBeenCalled();
    expect(codeEdge.groupBy).not.toHaveBeenCalled();

    // At the limit the step runs.
    codeEdge.count.mockResolvedValue(TWIN_MAX_PROJECT_CALL_EDGES);
    codeEdge.findMany.mockResolvedValue([]);
    expect((await source.calleeNameSets(["s"])).skipped).toBeUndefined();
    vi.doUnmock("../prisma.js");
  });

  it("makes no candidate scan when no retrieved function has enough callees to be compared", async () => {
    const { source, codeEdge } = await load();
    codeEdge.count.mockResolvedValue(10);
    codeEdge.findMany.mockResolvedValueOnce(calls("s", SIX.slice(0, 5)));
    const r = await source.calleeNameSets(["s"]);
    expect(r).toMatchObject({ notes: [] });
    expect(codeEdge.groupBy).not.toHaveBeenCalled();
    vi.doUnmock("../prisma.js");
  });

  it("MAX_TWIN_SEEDS: reads the callees of the first 60 retrieved functions only", async () => {
    const { source, codeEdge } = await load();
    codeEdge.count.mockResolvedValue(10);
    codeEdge.findMany.mockResolvedValue([]);
    const ids = Array.from({ length: MAX_TWIN_SEEDS + 5 }, (_, i) => `s${i}`);
    await source.calleeNameSets(ids);
    expect(codeEdge.findMany.mock.calls[0]![0].where.fromSymbolId.in).toEqual(
      ids.slice(0, MAX_TWIN_SEEDS),
    );
    vi.doUnmock("../prisma.js");
  });

  it("TWIN_MAX_POOLED_CALLEE_NAMES: a retrieved function whose names no longer fit is not compared, and is counted", async () => {
    const { source, codeEdge } = await load();
    codeEdge.count.mockResolvedValue(10);
    const half = Math.floor(TWIN_MAX_POOLED_CALLEE_NAMES / 2) + 1;
    const namesOf = (p: string) => Array.from({ length: half }, (_, i) => `${p}${i}`);
    codeEdge.findMany.mockResolvedValueOnce([
      ...calls("s1", namesOf("a")),
      ...calls("s2", namesOf("b")),
      // Fits after s2 was left out: its names are all s1's.
      ...calls("s3", namesOf("a").slice(0, 6)),
    ]);
    // The database returns every function sharing five pooled names. That
    // includes the retrieved ones, and s2 if it shares that many, as two
    // functions of one file usually do. Returning `[]` here hid that s2 was
    // then read back in as its own candidate (#1094 cycle 2; the case on a real
    // database is in `plan-localisation-scoped-reads-1060.sqlite.test.ts`).
    codeEdge.groupBy.mockResolvedValue(
      ["s1", "s2", "s3"].map((fromSymbolId) => ({ fromSymbolId, _count: { toQualifiedName: 6 } })),
    );
    const r = await source.calleeNameSets(["s1", "s2", "s3"]);
    expect(r.notes).toEqual([
      `1 retrieved function was not compared for twins (the retrieved code calls more than ${TWIN_MAX_POOLED_CALLEE_NAMES} distinct names)`,
    ]);
    // Not compared at all: comparing it with candidates found by other names would miss its twins.
    expect(r.sets.has("s2")).toBe(false);
    // No retrieved function is read a second time as a candidate.
    expect(codeEdge.findMany).toHaveBeenCalledTimes(1);
    expect(r.sets.has("s1")).toBe(true);
    expect(r.sets.has("s3")).toBe(true);
    const asked = codeEdge.groupBy.mock.calls[0]![0].where.toQualifiedName.in as string[];
    expect(asked).toHaveLength(half);
    expect(asked.length).toBeLessThanOrEqual(TWIN_MAX_POOLED_CALLEE_NAMES);
    vi.doUnmock("../prisma.js");
  });

  it("TWIN_MAX_CANDIDATES: compares the candidates sharing most, and says there were more", async () => {
    const { source, codeEdge } = await load();
    codeEdge.count.mockResolvedValue(10);
    codeEdge.findMany.mockResolvedValueOnce(calls("s", SIX)).mockResolvedValue([]);
    codeEdge.groupBy.mockResolvedValue(
      Array.from({ length: TWIN_MAX_CANDIDATES + 1 }, (_, i) => ({
        fromSymbolId: `c${i}`,
        _count: { toQualifiedName: 6 },
      })),
    );
    const r = await source.calleeNameSets(["s"]);
    expect(r.notes).toEqual([
      "more than 2,000 functions share callee names with the retrieved code: only the 2,000 sharing most were compared for twins",
    ]);
    const read = codeEdge.findMany.mock.calls.slice(1).flatMap((c) => c[0].where.fromSymbolId.in);
    expect(read).toHaveLength(TWIN_MAX_CANDIDATES);
    expect(read).not.toContain(`c${TWIN_MAX_CANDIDATES}`);
    // In lists SQLite can bind.
    for (const call of codeEdge.findMany.mock.calls.slice(1)) {
      expect(call[0].where.fromSymbolId.in.length).toBeLessThanOrEqual(500);
    }
    vi.doUnmock("../prisma.js");
  });

  it("TWIN_MAX_CANDIDATE_CALL_EDGES: gives up, and says so, when the candidates' edges pass the limit", async () => {
    const { source, codeEdge } = await load();
    codeEdge.count.mockResolvedValue(10);
    const tooMany = { length: TWIN_MAX_CANDIDATE_CALL_EDGES + 1 };
    codeEdge.findMany
      .mockResolvedValueOnce(calls("s", SIX))
      .mockResolvedValueOnce(
        Array.from(tooMany, () => ({ fromSymbolId: "t", toQualifiedName: "A" })),
      );
    codeEdge.groupBy.mockResolvedValue([{ fromSymbolId: "t", _count: { toQualifiedName: 6 } }]);
    const r = await source.calleeNameSets(["s"]);
    expect(r.skipped).toBe(
      "structural twins skipped: the 1 candidate function has over 100,000 call edges",
    );
    expect(r.sets.size).toBe(0);
    vi.doUnmock("../prisma.js");
  });

  it("reads a Go project's unresolved calls for the walk's frontier only", async () => {
    const { source, codeEdge, codeSymbol } = await load();
    codeEdge.findMany
      // Resolved downstream edges out of the frontier.
      .mockResolvedValueOnce([{ fromSymbolId: "h", toSymbolId: "x" }])
      // The frontier's unresolved Go calls.
      .mockResolvedValueOnce([
        { fromSymbolId: "h", filePath: "internal/ui/h.go", toQualifiedName: "h.store.UpdateFeed" },
      ])
      // The imports of the caller's package.
      .mockResolvedValueOnce([
        { filePath: "internal/ui/handler.go", toQualifiedName: "miniflux.app/v2/internal/storage" },
        // A sub-package's import does not count for the caller's package.
        { filePath: "internal/ui/form/form.go", toQualifiedName: "miniflux.app/v2/internal/other" },
      ]);
    codeSymbol.findMany.mockResolvedValueOnce([
      {
        id: "st-update",
        qualifiedName: "internal/storage/feed.go::UpdateFeed",
        filePath: "internal/storage/feed.go",
      },
    ]);
    const edges = await source.schema.getDownstreamCallEdgesFrom!(["h"]);
    expect(edges).toEqual([
      { fromSymbolId: "h", toSymbolId: "x" },
      { fromSymbolId: "h", toSymbolId: "st-update", inferred: true },
    ]);
    expect(codeEdge.findMany.mock.calls[1]![0].where).toEqual({
      projectId: "p1",
      kind: "calls",
      fromSymbolId: { in: ["h"] },
      filePath: { endsWith: ".go" },
    });
    expect(codeSymbol.findMany.mock.calls[0]![0].where).toEqual({
      projectId: "p1",
      language: "go",
      kind: { in: ["function", "method"] },
      name: { in: ["UpdateFeed"] },
    });
    expect(codeEdge.findMany.mock.calls[2]![0].where).toEqual({
      projectId: "p1",
      kind: "imports",
      filePath: { endsWith: ".go" },
      OR: [{ filePath: { startsWith: "internal/ui/" } }],
    });
    vi.doUnmock("../prisma.js");
  });
});
