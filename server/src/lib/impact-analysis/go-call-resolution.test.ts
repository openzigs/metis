/**
 * #791 — Go call binding for impact analysis. Shapes are Miniflux v2.3.3's:
 * handlers call `h.store.X(…)`, recorded by the parser as a bare `X` with no
 * `toSymbolId`, and the storage method is a plain `function` symbol.
 */
import { describe, expect, it, vi } from "vitest";
import {
  goPackageDir,
  loadResolvedGoCalls,
  loadResolvedGoCallsFrom,
  resolveGoCalls,
  type GoCallable,
  type GoImport,
} from "./go-call-resolution.js";

const STORAGE = "miniflux.app/v2/internal/storage";

const callables: GoCallable[] = [
  { id: "set-status", name: "SetEntriesStatus", filePath: "internal/storage/entry.go" },
  { id: "mark-all", name: "MarkAllAsRead", filePath: "internal/storage/entry.go" },
  { id: "client-mark-all", name: "MarkAllAsRead", filePath: "client/client.go" },
  { id: "before-date", name: "MarkAllAsReadBeforeDate", filePath: "internal/storage/entry.go" },
  { id: "helper", name: "newHelper", filePath: "internal/fever/helper.go" },
  { id: "test-helper", name: "fixture", filePath: "internal/storage/entry_test.go" },
  { id: "dup-a", name: "Dup", filePath: "internal/storage/a.go" },
  { id: "dup-b", name: "Dup", filePath: "internal/model/b.go" },
];

const imports: GoImport[] = [
  // The field `h.store` is declared in handler.go, so only that file imports storage.
  { filePath: "internal/fever/handler.go", importPath: STORAGE },
  { filePath: "internal/googlereader/handler.go", importPath: STORAGE },
  { filePath: "internal/googlereader/handler.go", importPath: "miniflux.app/v2/internal/model" },
];

describe("goPackageDir", () => {
  it("is the directory of the file, or empty at the root", () => {
    expect(goPackageDir("internal/storage/entry.go")).toBe("internal/storage");
    expect(goPackageDir("main.go")).toBe("");
  });
});

describe("resolveGoCalls (#791)", () => {
  it("binds a call through an imported package to its only declaration", () => {
    const out = resolveGoCalls(
      [
        {
          fromSymbolId: "fever-write-items",
          filePath: "internal/fever/handler.go",
          toQualifiedName: "SetEntriesStatus",
        },
      ],
      callables,
      imports,
    );
    expect(out).toEqual([{ fromSymbolId: "fever-write-items", toSymbolId: "set-status" }]);
  });

  it("pools imports across the files of one package", () => {
    // writeitems.go has no import of storage of its own; handler.go does.
    const out = resolveGoCalls(
      [
        {
          fromSymbolId: "w",
          filePath: "internal/fever/writeitems.go",
          toQualifiedName: "h.store.MarkAllAsReadBeforeDate",
        },
      ],
      callables,
      imports,
    );
    expect(out).toEqual([{ fromSymbolId: "w", toSymbolId: "before-date" }]);
  });

  it("disambiguates a shared name by what the caller's package imports", () => {
    // `client.MarkAllAsRead` exists too, but the fever package never imports `client`.
    const out = resolveGoCalls(
      [
        {
          fromSymbolId: "groups",
          filePath: "internal/fever/handler.go",
          toQualifiedName: "MarkAllAsRead",
        },
      ],
      callables,
      imports,
    );
    expect(out).toEqual([{ fromSymbolId: "groups", toSymbolId: "mark-all" }]);
  });

  it("binds a same-package call without an import", () => {
    const out = resolveGoCalls(
      [{ fromSymbolId: "h", filePath: "internal/fever/handler.go", toQualifiedName: "newHelper" }],
      callables,
      [],
    );
    expect(out).toEqual([{ fromSymbolId: "h", toSymbolId: "helper" }]);
  });

  it("leaves a call unresolved when two visible packages declare the name", () => {
    const out = resolveGoCalls(
      [{ fromSymbolId: "g", filePath: "internal/googlereader/handler.go", toQualifiedName: "Dup" }],
      callables,
      imports,
    );
    expect(out).toEqual([]);
  });

  it("never binds to a package the caller cannot see, or to an unknown name", () => {
    const out = resolveGoCalls(
      [
        { fromSymbolId: "x", filePath: "cmd/main.go", toQualifiedName: "SetEntriesStatus" },
        { fromSymbolId: "y", filePath: "internal/fever/handler.go", toQualifiedName: "Println" },
      ],
      callables,
      imports,
    );
    expect(out).toEqual([]);
  });

  it("does not offer a test file to a production caller, nor a function to itself", () => {
    const out = resolveGoCalls(
      [
        { fromSymbolId: "p", filePath: "internal/storage/entry.go", toQualifiedName: "fixture" },
        { fromSymbolId: "t", filePath: "internal/storage/x_test.go", toQualifiedName: "fixture" },
        {
          fromSymbolId: "set-status",
          filePath: "internal/storage/entry.go",
          toQualifiedName: "SetEntriesStatus",
        },
      ],
      callables,
      [],
    );
    expect(out).toEqual([{ fromSymbolId: "t", toSymbolId: "test-helper" }]);
  });
});

describe("loadResolvedGoCalls", () => {
  it("reads nothing else for a project with no Go functions", async () => {
    const prisma = {
      codeSymbol: { findMany: vi.fn().mockResolvedValue([]) },
      codeEdge: { findMany: vi.fn() },
    };
    expect(await loadResolvedGoCalls(prisma as never, "p")).toEqual([]);
    expect(prisma.codeEdge.findMany).not.toHaveBeenCalled();
  });

  it("resolves the project's unresolved Go calls from its rows", async () => {
    const edges = vi
      .fn()
      .mockResolvedValueOnce([
        {
          fromSymbolId: "gr",
          filePath: "internal/googlereader/handler.go",
          toQualifiedName: "MarkAllAsReadBeforeDate",
        },
        { fromSymbolId: "gr", filePath: "internal/googlereader/handler.go", toQualifiedName: null },
      ])
      .mockResolvedValueOnce([
        { filePath: "internal/googlereader/handler.go", toQualifiedName: STORAGE },
        { filePath: "internal/googlereader/handler.go", toQualifiedName: null },
      ]);
    const prisma = {
      codeSymbol: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "before-date",
            qualifiedName: "internal/storage/entry.go::MarkAllAsReadBeforeDate",
            filePath: "internal/storage/entry.go",
          },
        ]),
      },
      codeEdge: { findMany: edges },
    };
    expect(await loadResolvedGoCalls(prisma as never, "p")).toEqual([
      { fromSymbolId: "gr", toSymbolId: "before-date" },
    ]);
    expect(edges.mock.calls[0][0].where).toMatchObject({
      projectId: "p",
      kind: "calls",
      toSymbolId: null,
    });
    // Impact analysis passes no names and still reads every unresolved call.
    expect(edges.mock.calls[0][0].where).not.toHaveProperty("toQualifiedName");
  });

  describe("calleeNames (#1034)", () => {
    const symbols = [
      {
        id: "before-date",
        qualifiedName: "internal/storage/entry.go::MarkAllAsReadBeforeDate",
        filePath: "internal/storage/entry.go",
      },
    ];

    it("narrows the unresolved-calls read to those names, and nothing else", async () => {
      const edges = vi
        .fn()
        .mockResolvedValueOnce([
          {
            fromSymbolId: "gr",
            filePath: "internal/googlereader/handler.go",
            toQualifiedName: "MarkAllAsReadBeforeDate",
          },
        ])
        .mockResolvedValueOnce([
          { filePath: "internal/googlereader/handler.go", toQualifiedName: STORAGE },
        ]);
      const prisma = {
        codeSymbol: { findMany: vi.fn().mockResolvedValue(symbols) },
        codeEdge: { findMany: edges },
      };
      expect(
        await loadResolvedGoCalls(prisma as never, "p", {
          calleeNames: ["MarkAllAsReadBeforeDate"],
        }),
      ).toEqual([{ fromSymbolId: "gr", toSymbolId: "before-date" }]);
      expect(edges.mock.calls[0][0].where).toEqual({
        projectId: "p",
        kind: "calls",
        toSymbolId: null,
        filePath: { endsWith: ".go" },
        toQualifiedName: { in: ["MarkAllAsReadBeforeDate"] },
      });
      // Candidates and imports stay whole: ambiguity is judged over them.
      expect(prisma.codeSymbol.findMany.mock.calls[0][0].where).not.toHaveProperty("name");
      expect(edges.mock.calls[1][0].where).not.toHaveProperty("toQualifiedName");
    });

    it("reads nothing for an empty list", async () => {
      const prisma = {
        codeSymbol: { findMany: vi.fn().mockResolvedValue(symbols) },
        codeEdge: { findMany: vi.fn() },
      };
      expect(await loadResolvedGoCalls(prisma as never, "p", { calleeNames: [] })).toEqual([]);
      expect(prisma.codeSymbol.findMany).not.toHaveBeenCalled();
      expect(prisma.codeEdge.findMany).not.toHaveBeenCalled();
    });
  });
});

// ── #1060 — the same decision, reading only the caller's side ────────────────

type Row = Record<string, string | null>;
type Clause = Record<string, unknown>;

/** The handful of Prisma `where` shapes the two loaders use, over in-memory rows. */
function matches(row: Row, where: Clause): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === "OR") return (want as Clause[]).some((w) => matches(row, w));
    const value = row[key];
    if (want === null || typeof want !== "object") return value === want;
    const cond = want as { in?: string[]; endsWith?: string; startsWith?: string };
    if (cond.in) return value !== null && value !== undefined && cond.in.includes(value);
    if (cond.endsWith !== undefined) return (value ?? "").endsWith(cond.endsWith);
    if (cond.startsWith !== undefined) return (value ?? "").startsWith(cond.startsWith);
    throw new Error(`unsupported where: ${JSON.stringify(want)}`);
  });
}

function inMemoryGraph(symbols: Row[], edges: Row[]) {
  const table = (rows: Row[]) => ({
    findMany: vi.fn(async (args: { where: Clause }) => rows.filter((r) => matches(r, args.where))),
  });
  return { codeSymbol: table(symbols), codeEdge: table(edges) };
}

describe("loadResolvedGoCallsFrom (#1060)", () => {
  const fn = (id: string, filePath: string, name: string): Row => ({
    id,
    projectId: "p",
    language: "go",
    kind: "function",
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
  });
  const call = (fromSymbolId: string, filePath: string, toQualifiedName: string): Row => ({
    projectId: "p",
    kind: "calls",
    fromSymbolId,
    toSymbolId: null,
    filePath,
    toQualifiedName,
  });
  const imp = (filePath: string, toQualifiedName: string): Row => ({
    projectId: "p",
    kind: "imports",
    fromSymbolId: `m:${filePath}`,
    toSymbolId: null,
    filePath,
    toQualifiedName,
  });
  const symbols = [
    fn("ui-refresh", "internal/ui/feed_refresh.go", "refreshFeed"),
    fn("ui-show", "internal/ui/feed_entries.go", "showFeedEntriesPage"),
    fn("ui-helper", "internal/ui/helper.go", "pagination"),
    fn("form-new", "internal/ui/form/feed.go", "NewFeedForm"),
    fn("st-update", "internal/storage/feed.go", "UpdateFeed"),
    fn("st-byid", "internal/storage/feed.go", "FeedByID"),
    fn("st-dup", "internal/storage/a.go", "Dup"),
    fn("model-dup", "internal/model/b.go", "Dup"),
    fn("client-update", "client/client.go", "UpdateFeed"),
    fn("root-main", "main.go", "main"),
    fn("root-run", "run.go", "run"),
    // Another project's function of the same name must never be a candidate.
    { ...fn("other-update", "internal/storage/feed.go", "UpdateFeed"), projectId: "q" },
  ];
  const edges = [
    call("ui-refresh", "internal/ui/feed_refresh.go", "h.store.UpdateFeed"),
    call("ui-refresh", "internal/ui/feed_refresh.go", "pagination"),
    // Already bound by the ingest: not an unresolved call, and never resolved again.
    {
      ...call("ui-refresh", "internal/ui/feed_refresh.go", "h.store.FeedByID"),
      toSymbolId: "st-byid",
    },
    // Ambiguous: storage and model both declare Dup, and the package imports both.
    call("ui-refresh", "internal/ui/feed_refresh.go", "Dup"),
    call("ui-show", "internal/ui/feed_entries.go", "h.store.FeedByID"),
    // Visible only through the sub-package's own import: not from internal/ui.
    call("ui-show", "internal/ui/feed_entries.go", "NewFeedForm"),
    call("form-new", "internal/ui/form/feed.go", "FeedByID"),
    call("root-main", "main.go", "run"),
    // From the root package (directory ""), through what `main.go` imports.
    call("root-main", "main.go", "ui.pagination"),
    call("st-update", "internal/storage/feed.go", "FeedByID"),
    imp("internal/ui/handler.go", "miniflux.app/v2/internal/storage"),
    imp("internal/ui/handler.go", "miniflux.app/v2/internal/model"),
    imp("internal/ui/form/feed.go", "miniflux.app/v2/internal/storage"),
    imp("main.go", "miniflux.app/v2/internal/ui"),
  ];
  const sorted = (rows: Array<{ fromSymbolId: string; toSymbolId: string }>) =>
    [...rows].sort((a, b) =>
      `${a.fromSymbolId}>${a.toSymbolId}`.localeCompare(`${b.fromSymbolId}>${b.toSymbolId}`),
    );

  it("gives, for any set of callers, what the whole-project resolution gives for them", async () => {
    const whole = await loadResolvedGoCalls(inMemoryGraph(symbols, edges) as never, "p");
    // The fixture exercises every rule: bound, ambiguous, invisible, same-package, root package.
    expect(sorted(whole)).toEqual([
      { fromSymbolId: "form-new", toSymbolId: "st-byid" },
      { fromSymbolId: "root-main", toSymbolId: "root-run" },
      { fromSymbolId: "root-main", toSymbolId: "ui-helper" },
      { fromSymbolId: "st-update", toSymbolId: "st-byid" },
      { fromSymbolId: "ui-refresh", toSymbolId: "st-update" },
      { fromSymbolId: "ui-refresh", toSymbolId: "ui-helper" },
      { fromSymbolId: "ui-show", toSymbolId: "st-byid" },
    ]);
    const callers = [
      ...new Set(edges.filter((e) => e.kind === "calls").map((e) => e.fromSymbolId!)),
    ];
    const subsets = [
      ...callers.map((c) => [c]),
      ["ui-refresh", "ui-show"],
      ["root-main", "form-new", "st-update"],
      callers,
    ];
    for (const subset of subsets) {
      const scoped = await loadResolvedGoCallsFrom(
        inMemoryGraph(symbols, edges) as never,
        "p",
        subset,
      );
      expect(sorted(scoped), subset.join(",")).toEqual(
        sorted(whole.filter((c) => subset.includes(c.fromSymbolId))),
      );
    }
  });

  it("reads the callers' calls, the candidates of their callee names and their packages' imports", async () => {
    const graph = inMemoryGraph(symbols, edges);
    await loadResolvedGoCallsFrom(graph as never, "p", ["ui-refresh"]);
    expect(graph.codeEdge.findMany.mock.calls[0]![0].where).toEqual({
      projectId: "p",
      kind: "calls",
      fromSymbolId: { in: ["ui-refresh"] },
      filePath: { endsWith: ".go" },
    });
    expect(graph.codeSymbol.findMany.mock.calls[0]![0].where).toEqual({
      projectId: "p",
      language: "go",
      kind: { in: ["function", "method"] },
      name: { in: ["Dup", "UpdateFeed", "pagination"] },
    });
    expect(graph.codeEdge.findMany.mock.calls[1]![0].where).toEqual({
      projectId: "p",
      kind: "imports",
      filePath: { endsWith: ".go" },
      OR: [{ filePath: { startsWith: "internal/ui/" } }],
    });
  });

  it("reads nothing for no caller, and no candidate for a caller with no unresolved call", async () => {
    const graph = inMemoryGraph(symbols, edges);
    expect(await loadResolvedGoCallsFrom(graph as never, "p", [])).toEqual([]);
    expect(graph.codeEdge.findMany).not.toHaveBeenCalled();
    expect(await loadResolvedGoCallsFrom(graph as never, "p", ["st-byid"])).toEqual([]);
    expect(graph.codeSymbol.findMany).not.toHaveBeenCalled();
    // No function of the project carries the name: the imports are not read either.
    const none = inMemoryGraph([], edges);
    expect(await loadResolvedGoCallsFrom(none as never, "p", ["ui-refresh"])).toEqual([]);
    expect(none.codeEdge.findMany).toHaveBeenCalledTimes(1);
  });

  it("asks in lists SQLite can bind, however many callers there are", async () => {
    const many = Array.from({ length: 1_201 }, (_, i) => `c${i}`);
    const graph = inMemoryGraph(symbols, edges);
    await loadResolvedGoCallsFrom(graph as never, "p", [...many, "ui-refresh"]);
    const callReads = graph.codeEdge.findMany.mock.calls.filter((c) => c[0].where.kind === "calls");
    expect(callReads).toHaveLength(3);
    const asked = callReads.flatMap((c) => (c[0].where.fromSymbolId as { in: string[] }).in);
    expect(asked).toEqual([...many, "ui-refresh"]);
  });
});
