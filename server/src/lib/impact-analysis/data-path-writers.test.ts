/**
 * #791 — the functions that write the data a requirement changes. Shapes are
 * Miniflux v2.3.3's after #807 (lineage edges start at the enclosing function).
 */
import { describe, expect, it } from "vitest";
import {
  expandDataPathWriters,
  isOrmMappingEdge,
  isSyntheticSqlOrigin,
  MAX_WRITER_SQL_CHARS,
  parseWriterText,
  profileDataPathWriters,
  requirementIdentifierColumns,
  requirementNamedColumns,
  resolveDataPathWriters,
  type DataPathDataSource,
} from "./data-path-writers.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { AffectedTableInput } from "./schema-impact.js";

interface Sym {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}
interface Edge {
  fromSymbolId: string;
  toSymbolId: string;
  kind: "reads" | "writes" | "persists-to" | "executes";
}

const ENTRY = "internal/storage/entry.go";
const FEED = "internal/storage/feed.go";
const fn = (name: string, filePath: string, startLine: number): Sym => ({
  id: name,
  kind: "function",
  name,
  qualifiedName: `${filePath}::${name}`,
  filePath,
  startLine,
  endLine: startLine + 10,
  language: "go",
});
const col = (qn: string): Sym => {
  const [table, name] = qn.split(".");
  return {
    id: qn,
    kind: name ? "column" : "table",
    name: name ?? table,
    qualifiedName: qn,
    filePath: "internal/database/migrations.go",
    startLine: 1,
    endLine: 1,
    language: "sql",
  };
};

const symbols: Sym[] = [
  fn("SetEntriesStatus", ENTRY, 412),
  fn("SetEntriesStatusAndCountVisible", ENTRY, 431),
  fn("MarkAllAsRead", ENTRY, 506),
  fn("MarkAllAsReadBeforeDate", ENTRY, 523),
  fn("GetReadTime", ENTRY, 300),
  fn("createEntry", ENTRY, 81),
  fn("UpdateFeed", FEED, 331),
  fn("UpdateFeedError", FEED, 431),
  fn("markAllAsRead", "internal/ui/unread_mark_all_read.go", 13),
  { ...fn("sql@600", ENTRY, 600), kind: "method", language: "sql" },
  col("entries"),
  col("entries.status"),
  col("entries.changed_at"),
  col("entries.reading_time"),
  col("entries.id"),
  col("feeds"),
  col("feeds.checked_at"),
  col("feeds.parsing_error_count"),
];

const edges: Edge[] = [
  ...[
    "SetEntriesStatus",
    "SetEntriesStatusAndCountVisible",
    "MarkAllAsRead",
    "MarkAllAsReadBeforeDate",
  ].flatMap((f): Edge[] => [
    { fromSymbolId: f, toSymbolId: "entries.status", kind: "writes" },
    { fromSymbolId: f, toSymbolId: "entries.changed_at", kind: "writes" },
    { fromSymbolId: f, toSymbolId: "entries.id", kind: "reads" },
  ]),
  { fromSymbolId: "createEntry", toSymbolId: "entries.status", kind: "persists-to" },
  { fromSymbolId: "GetReadTime", toSymbolId: "entries.reading_time", kind: "reads" },
  { fromSymbolId: "UpdateFeed", toSymbolId: "feeds.checked_at", kind: "writes" },
  { fromSymbolId: "UpdateFeedError", toSymbolId: "feeds.checked_at", kind: "writes" },
  { fromSymbolId: "UpdateFeedError", toSymbolId: "feeds.parsing_error_count", kind: "writes" },
  // A pre-#807 synthetic origin: never named as a writer.
  { fromSymbolId: "sql@600", toSymbolId: "entries.status", kind: "writes" },
];

/** In-memory data source over the fixture rows. */
function dataSource(
  calls: Array<{ from: string; to: string; inferred?: boolean }> = [],
): DataPathDataSource {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  return {
    async getSchemaEdgesFrom(ids) {
      return edges.filter((e) => ids.includes(e.fromSymbolId));
    },
    async getSchemaSymbolsByIds(ids) {
      return symbols
        .filter((s) => ids.includes(s.id) && s.language === "sql" && s.kind !== "method")
        .map((s) => ({
          id: s.id,
          kind: s.kind as "table" | "column",
          name: s.name,
          qualifiedName: s.qualifiedName,
          source: "sqlglot" as const,
        }));
    },
    async getDownstreamCallEdgesFrom(ids) {
      return calls
        .filter((c) => ids.includes(c.from))
        .map((c) => ({ fromSymbolId: c.from, toSymbolId: c.to, inferred: c.inferred }));
    },
    async getColumnsOfTables(tables) {
      return symbols
        .filter((s) => s.kind === "column" && tables.includes(s.qualifiedName.split(".")[0]))
        .map((s) => ({
          id: s.id,
          kind: "column" as const,
          name: s.name,
          qualifiedName: s.qualifiedName,
          source: "sqlglot" as const,
        }));
    },
    async getWriterEdgesTo(ids) {
      return edges
        .filter(
          (e) => ids.includes(e.toSymbolId) && (e.kind === "writes" || e.kind === "persists-to"),
        )
        .map((e) => ({ ...e, source: "sqlglot" }));
    },
    async getCodeSymbolDetails(ids) {
      return ids.flatMap((id) => {
        const s = byId.get(id);
        return s ? [s] : [];
      });
    },
  };
}

const table = (tableName: string, columnName: string | null = null): AffectedTableInput => ({
  objectKind: columnName ? "column" : "table",
  tableName,
  columnName,
  columnType: null,
  changeKind: "reference",
  suggestedDdl: null,
  source: "sqlglot",
  reconciliation: null,
  confidence: 0.95,
});

const READ_AT =
  "Track reading time — add read_at timestamp to entries. The changed_at field updates whenever an entry is modified (including status changes). When an entry transitions from unread to read, set read_at = NOW().";

describe("resolveDataPathWriters — a MyBatis mapper statement is a writer (PR #1090 panel)", () => {
  // What the MyBatis extractor stores: one origin per statement, kind `method`,
  // language `sql`, in the mapper XML, with the `writes` edges starting at it.
  const XML = "src/main/resources/mapper/OrderMapper.xml";
  const statement: Sym = {
    id: "stmt",
    kind: "method",
    name: "updateStatus",
    qualifiedName: "com.shop.OrderMapper.updateStatus",
    filePath: XML,
    startLine: 41,
    endLine: 41,
    language: "sql",
  };
  const synthetic: Sym = {
    ...statement,
    id: "syn",
    name: "sql@88",
    qualifiedName: `${XML}::sql@88`,
    startLine: 88,
    endLine: 88,
  };
  const orderColumn = { ...col("orders.status"), id: "orders.status" };
  const mybatis: DataPathDataSource = {
    getSchemaEdgesFrom: async () => [],
    getSchemaSymbolsByIds: async () => [],
    getDownstreamCallEdgesFrom: async () => [],
    getColumnsOfTables: async () => [
      {
        id: orderColumn.id,
        kind: "column" as const,
        name: "status",
        qualifiedName: "orders.status",
        source: "mybatis" as const,
      },
    ],
    getWriterEdgesTo: async () => [
      {
        fromSymbolId: "stmt",
        toSymbolId: "orders.status",
        kind: "writes" as const,
        source: "mybatis",
      },
      {
        fromSymbolId: "syn",
        toSymbolId: "orders.status",
        kind: "writes" as const,
        source: "mybatis",
      },
    ],
    getCodeSymbolDetails: async (ids) => [statement, synthetic].filter((s) => ids.includes(s.id)),
  };

  it("names the mapper statement, in its XML file, and still never a synthetic origin", async () => {
    const writers = await resolveDataPathWriters({
      requirementText: "Set the order status to shipped when the parcel leaves.",
      seedIds: [],
      primaryTables: [table("orders")],
      dataSource: mybatis,
      excludeIds: new Set(),
    });
    expect(writers.map((w) => [w.qualifiedName, w.filePath, w.startLine])).toEqual([
      ["com.shop.OrderMapper.updateStatus", XML, 41],
    ]);
  });

  /**
   * Every shape `createOriginSymbol` stores — all kind `method`, language `sql` —
   * with the edges its extractor records, on one column the requirement names.
   */
  const origin = (id: string, qualifiedName: string, filePath: string, startLine: number): Sym => ({
    id,
    kind: "method",
    name: qualifiedName.split(/[.:]/).pop()!,
    qualifiedName,
    filePath,
    startLine,
    endLine: startLine,
    language: "sql",
  });
  const JAVA = "src/main/java/com/shop/OrderRepository.java";
  const SHAPES: Array<{
    sym: Sym;
    edge: { kind: "writes" | "persists-to"; source: string };
    writer: boolean;
  }> = [
    // MyBatis: `<update>` writes, `<insert>` persists — both are statements a change edits.
    {
      sym: origin("mb-update", "com.shop.OrderMapper.updateStatus", XML, 41),
      edge: { kind: "writes", source: "mybatis" },
      writer: true,
    },
    {
      sym: origin("mb-insert", "com.shop.OrderMapper.insertOrder", XML, 12),
      edge: { kind: "persists-to", source: "mybatis" },
      writer: true,
    },
    // JPA `@Modifying @Query("update Order o set o.status = …")`.
    {
      sym: origin("jpa-query", `${JAVA}::markShipped#jpa-query`, JAVA, 30),
      edge: { kind: "writes", source: "orm" },
      writer: true,
    },
    // ORM mapping declarations: a Prisma `model` and a JPA `@Entity`.
    {
      sym: origin("prisma-model", "Order", "prisma/schema.prisma", 88),
      edge: { kind: "persists-to", source: "orm" },
      writer: false,
    },
    {
      sym: origin("jpa-entity", "com.shop.Order", "src/main/java/com/shop/Order.java", 14),
      edge: { kind: "persists-to", source: "orm" },
      writer: false,
    },
    // Synthetic statement origins: a line, not code.
    {
      sym: origin(
        "syn-sql",
        "internal/storage/order.go::sql@600",
        "internal/storage/order.go",
        600,
      ),
      edge: { kind: "writes", source: "sqlglot" },
      writer: false,
    },
    {
      sym: origin("syn-exec", "db/OrderDao.java::exec@7", "db/OrderDao.java", 7),
      edge: { kind: "writes", source: "sqlglot" },
      writer: false,
    },
    {
      sym: origin("syn-procsql", "etl/orders.sas::procsql@30", "etl/orders.sas", 30),
      edge: { kind: "writes", source: "sqlglot" },
      writer: false,
    },
  ];
  const shapes = (list: typeof SHAPES): DataPathDataSource => ({
    ...mybatis,
    getWriterEdgesTo: async () =>
      list.map(({ sym, edge }) => ({ fromSymbolId: sym.id, toSymbolId: "orders.status", ...edge })),
    getCodeSymbolDetails: async (ids) => list.map((s) => s.sym).filter((s) => ids.includes(s.id)),
  });
  const resolve = (list: typeof SHAPES) =>
    resolveDataPathWriters({
      requirementText: "Set the order status to shipped when the parcel leaves.",
      seedIds: [],
      primaryTables: [table("orders")],
      dataSource: shapes(list),
      excludeIds: new Set(),
      maxWriters: 50,
    });

  it("admits MyBatis statements and JPA @Query methods; never an entity declaration or a synthetic origin (PR #1090 review 2)", async () => {
    const writers = await resolve(SHAPES);
    expect(writers.map((w) => w.id).sort()).toEqual(
      SHAPES.filter((s) => s.writer)
        .map((s) => s.sym.id)
        .sort(),
    );
    expect(writers.map((w) => w.id).sort()).toEqual(["jpa-query", "mb-insert", "mb-update"]);
  });

  it.each(SHAPES.map((s) => [s.sym.id, s] as const))("%s, alone", async (_id, shape) => {
    // Alone, so the share-of-best cut cannot be what excludes it.
    const writers = await resolve([shape]);
    expect(writers.map((w) => w.id)).toEqual(shape.writer ? [shape.sym.id] : []);
  });

  it("isOrmMappingEdge is the ORM `persists-to` edge and no other", () => {
    expect(isOrmMappingEdge({ kind: "persists-to", source: "orm" })).toBe(true);
    expect(isOrmMappingEdge({ kind: "writes", source: "orm" })).toBe(false);
    expect(isOrmMappingEdge({ kind: "persists-to", source: "mybatis" })).toBe(false);
    expect(isOrmMappingEdge({ kind: "persists-to", source: "sqlglot" })).toBe(false);
    expect(isOrmMappingEdge({ kind: "persists-to" })).toBe(false);
    expect(isOrmMappingEdge({ kind: "persists-to", source: null })).toBe(false);
  });

  it("recognises a synthetic origin by its name, whatever the language says", () => {
    expect(
      ["a/b.go::sql@600", "x.sas::procsql@12", "a.java::exec@7", "sql@3"].map(isSyntheticSqlOrigin),
    ).toEqual([true, true, true, true]);
    expect(
      [
        "com.shop.OrderMapper.updateStatus",
        "a/b.go::MarkAllAsRead",
        "a/b.go::sql@x",
        "user@example.com::handler",
      ].map(isSyntheticSqlOrigin),
    ).toEqual([false, false, false, false]);
  });
});

describe("requirementNamedColumns (#791)", () => {
  it("matches a column the requirement names verbatim, never `id`", () => {
    const columns = symbols
      .filter((s) => s.kind === "column")
      .map((s) => ({ id: s.id, name: s.name }));
    expect(requirementNamedColumns(`${READ_AT} by id`, columns).sort()).toEqual([
      "entries.changed_at",
      "entries.status",
    ]);
  });
});

describe("resolveDataPathWriters (#791)", () => {
  it("names every function that writes a column the requirement names (read_at, #4336)", async () => {
    const writers = await resolveDataPathWriters({
      requirementText: READ_AT,
      seedIds: ["GetReadTime", "entries.changed_at"],
      primaryTables: [table("entries"), table("entries", "changed_at")],
      dataSource: dataSource(),
      excludeIds: new Set(["GetReadTime"]),
    });
    expect(writers.map((w) => w.qualifiedName)).toEqual([
      `${ENTRY}::MarkAllAsRead`,
      `${ENTRY}::MarkAllAsReadBeforeDate`,
      `${ENTRY}::SetEntriesStatus`,
      `${ENTRY}::SetEntriesStatusAndCountVisible`,
      `${ENTRY}::createEntry`,
    ]);
    const status = writers.find((w) => w.qualifiedName.endsWith("::SetEntriesStatus"))!;
    expect(status).toMatchObject({ filePath: ENTRY, startLine: 412, confidence: 0.8 });
    expect(status.columns).toEqual(["entries.changed_at", "entries.status"]);
    // The INSERT that sets one of the two columns ranks last, at the floor.
    expect(writers.at(-1)).toMatchObject({ id: "createEntry", confidence: 0.5 });
  });

  it("names an INSERT path when it is the only writer of a named column", async () => {
    const writers = await resolveDataPathWriters({
      requirementText: "Show the entry status",
      seedIds: [],
      primaryTables: [table("entries")],
      dataSource: dataSource(),
      excludeIds: new Set(["SetEntriesStatus", "SetEntriesStatusAndCountVisible", "MarkAllAsRead"]),
    });
    const insert = writers.find((w) => w.id === "createEntry")!;
    const update = writers.find((w) => w.id === "MarkAllAsReadBeforeDate")!;
    expect(insert.columns).toEqual(["entries.status"]);
    expect(update.confidence).toBeGreaterThan(insert.confidence);
    expect(insert.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it("reaches the existing sibling through what the seeded handler writes (#4478)", async () => {
    // The UI handler calls storage.MarkAllAsRead (a name-bound Go call); the
    // requirement names no column at all.
    const writers = await resolveDataPathWriters({
      requirementText: "Mark all as read older than X days.",
      seedIds: ["markAllAsRead"],
      primaryTables: [table("entries")],
      dataSource: dataSource([{ from: "markAllAsRead", to: "MarkAllAsRead", inferred: true }]),
      excludeIds: new Set(["markAllAsRead"]),
    });
    const names = writers.map((w) => w.qualifiedName);
    expect(names).toContain(`${ENTRY}::MarkAllAsReadBeforeDate`);
    expect(names).toContain(`${ENTRY}::MarkAllAsRead`);
    expect(names).not.toContain(`${ENTRY}::GetReadTime`);
  });

  it("names the refresh writers of the column the requirement names (checked_at, #4511)", async () => {
    const writers = await resolveDataPathWriters({
      requirementText: "the Last Refreshed parameter (checked_at) only tells me the last attempt",
      seedIds: [],
      primaryTables: [table("feeds"), table("feeds", "last_modified_header")],
      dataSource: dataSource(),
      excludeIds: new Set(),
    });
    expect(writers.map((w) => w.qualifiedName)).toEqual([
      `${FEED}::UpdateFeed`,
      `${FEED}::UpdateFeedError`,
    ]);
  });

  it("only looks at columns of the primary tables", async () => {
    const writers = await resolveDataPathWriters({
      requirementText: READ_AT,
      seedIds: [],
      primaryTables: [table("feeds")],
      dataSource: dataSource(),
      excludeIds: new Set(),
    });
    expect(writers).toEqual([]);
  });

  it("caps the writer list and skips symbols already in the result", async () => {
    const writers = await resolveDataPathWriters({
      requirementText: READ_AT,
      seedIds: [],
      primaryTables: [table("entries")],
      dataSource: dataSource(),
      excludeIds: new Set(["SetEntriesStatus"]),
      maxWriters: 2,
    });
    expect(writers).toHaveLength(2);
    expect(writers.map((w) => w.id)).not.toContain("SetEntriesStatus");
  });

  it("is a no-op without primary tables or without the optional data-source hooks", async () => {
    const base = {
      requirementText: READ_AT,
      seedIds: [],
      excludeIds: new Set<string>(),
    };
    expect(
      await resolveDataPathWriters({ ...base, primaryTables: [], dataSource: dataSource() }),
    ).toEqual([]);
    const { getWriterEdgesTo: _drop, ...partial } = dataSource();
    expect(
      await resolveDataPathWriters({
        ...base,
        primaryTables: [table("entries")],
        dataSource: partial,
      }),
    ).toEqual([]);
  });
});

describe("requirementIdentifierColumns (#1036)", () => {
  const columns = symbols
    .filter((s) => s.kind === "column")
    .map((s) => ({ id: s.id, name: s.name }));

  it("counts a compound column name, and not a bare English word that is also a column", () => {
    // `status` is in the text ("status changes") and so scores a writer, but it is
    // not evidence that the request is about that column. `changed_at` is.
    expect(requirementIdentifierColumns(READ_AT, columns)).toEqual(["entries.changed_at"]);
  });

  it("counts a one-word column when the request writes it as code", () => {
    expect(
      requirementIdentifierColumns("Set `status` to read when the entry is opened.", columns),
    ).toEqual(["entries.status"]);
  });

  it("is empty when the request names no column", () => {
    expect(requirementIdentifierColumns("Mark all as read older than X days.", columns)).toEqual(
      [],
    );
  });
});

describe("resolveDataPathWriters — namesRequirementColumn (#1036)", () => {
  it("is true only for a writer of a column the request names as an identifier", async () => {
    const writers = await resolveDataPathWriters({
      requirementText: READ_AT,
      seedIds: [],
      primaryTables: [table("entries")],
      dataSource: dataSource(),
      excludeIds: new Set(),
    });
    const byId = new Map(writers.map((w) => [w.id, w.namesRequirementColumn]));
    // UPDATE … SET status, changed_at — `changed_at` is named as an identifier.
    expect(byId.get("SetEntriesStatus")).toBe(true);
    // INSERTs `status` only, which the text mentions as an English word.
    expect(byId.get("createEntry")).toBe(false);
  });
});

describe("expandDataPathWriters (#1036)", () => {
  const graph: CodeGraphDataSource = {
    getSymbol: async () => null,
    getEdgesFrom: async () => [],
    getEdgesTo: async () => [],
    getSymbolsByFile: async () => [],
    getSymbolsByIds: async () => [],
  };
  const seed = {
    codeSymbolId: "SetEntriesStatus",
    filePath: ENTRY,
    qualifiedName: `${ENTRY}::SetEntriesStatus`,
    startLine: 412,
    endLine: 422,
    relation: "direct" as const,
    depth: 0,
    confidence: 1,
  };

  it("reports a writer the seeding already found, without listing it twice", async () => {
    const { symbols: out, writers } = await expandDataPathWriters([seed], {
      requirementText: READ_AT,
      seedIds: ["SetEntriesStatus"],
      primaryTables: [table("entries")],
      dataSource: dataSource(),
      graph,
    });
    // It is a writer: #791 needs to know that even though the row stays `direct`.
    expect(writers.map((w) => w.id)).toContain("SetEntriesStatus");
    expect(out.filter((s) => s.codeSymbolId === "SetEntriesStatus")).toEqual([seed]);
    expect(out.filter((s) => s.relation === "data-writer").map((s) => s.codeSymbolId)).toContain(
      "MarkAllAsReadBeforeDate",
    );
  });

  it("returns the symbols untouched, and still every writer, when all are already listed", async () => {
    const all = [
      "SetEntriesStatus",
      "SetEntriesStatusAndCountVisible",
      "MarkAllAsRead",
      "MarkAllAsReadBeforeDate",
      "createEntry",
    ].map((id) => ({ ...seed, codeSymbolId: id }));
    const { symbols: out, writers } = await expandDataPathWriters(all, {
      requirementText: READ_AT,
      seedIds: [],
      primaryTables: [table("entries")],
      dataSource: dataSource(),
      graph,
    });
    expect(out).toBe(all);
    expect(writers.length).toBeGreaterThanOrEqual(4);
  });
});

// The text METIS stored for this symbol in the run-7 Miniflux graph, verbatim
// (`CodeSymbolEmbedding.text`; the body is cut after ten lines at ingest).
const MARK_BEFORE_DATE_TEXT = [
  "function MarkAllAsReadBeforeDate in internal/storage/entry.go",
  "func (s *Storage) MarkAllAsReadBeforeDate(userID int64, before time.Time) error {",
  "\tquery := `",
  "\t\tUPDATE",
  "\t\t\tentries",
  "\t\tSET",
  "\t\t\tstatus=$1,",
  "\t\t\tchanged_at=now()",
  "\t\tWHERE",
  "\t\t\tuser_id=$2 AND status=$3 AND published_at < $4",
  "\t`",
].join("\n");

describe("parseWriterText (#791)", () => {
  it("reads a Go method: the receiver is not a parameter, the SQL ends at the backtick", () => {
    expect(parseWriterText(MARK_BEFORE_DATE_TEXT)).toEqual({
      signature: "func (s *Storage) MarkAllAsReadBeforeDate(userID int64, before time.Time) error",
      parameters: ["userID int64", "before time.Time"],
      sql: "UPDATE entries SET status=$1, changed_at=now() WHERE user_id=$2 AND status=$3 AND published_at < $4",
    });
  });

  it("keeps a parameter whose type has its own commas or parentheses whole", () => {
    const { parameters } = parseWriterText(
      "func Apply(ids map[string][]int64, fn func(a, b int) error, n int) {",
    );
    expect(parameters).toEqual(["ids map[string][]int64", "fn func(a, b int) error", "n int"]);
  });

  it("drops self/this from a method, and reads a declaration with no header line", () => {
    expect(parseWriterText("def mark_read(self, before: datetime):\n    pass").parameters).toEqual([
      "before: datetime",
    ]);
    expect(parseWriterText("async markRead(this: Store, before: Date) {").parameters).toEqual([
      "before: Date",
    ]);
  });

  it("returns no parameters for a declaration it cannot read, and no SQL when there is none", () => {
    expect(parseWriterText("type Entry struct {\n\tID int64\n}")).toEqual({
      signature: "type Entry struct",
      parameters: [],
      sql: null,
    });
    expect(parseWriterText("func broken(a int {").parameters).toEqual([]);
    expect(parseWriterText("")).toEqual({ signature: null, parameters: [], sql: null });
  });

  it("caps a long statement", () => {
    const long = `func f() {\n q := \`UPDATE t SET ${"a=1, ".repeat(200)}\``;
    expect(parseWriterText(long).sql!.length).toBe(MAX_WRITER_SQL_CHARS);
  });
});

describe("profileDataPathWriters (#791)", () => {
  // MarkAllAsReadBeforeDate as the lineage records it: it writes two entries
  // columns and READS three more — the WHERE of its UPDATE.
  const predicateEdges: Edge[] = [
    { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries", kind: "writes" },
    { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.published_at", kind: "reads" },
    { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "feeds.checked_at", kind: "reads" },
  ];
  const published = col("entries.published_at");
  const source = (texts: Record<string, string> | null): DataPathDataSource => {
    const base = dataSource();
    return {
      ...base,
      async getSchemaEdgesFrom(ids) {
        return [...edges, ...predicateEdges].filter((e) => ids.includes(e.fromSymbolId));
      },
      async getSchemaSymbolsByIds(ids) {
        return [...symbols, published]
          .filter((sym) => ids.includes(sym.id) && sym.language === "sql" && sym.kind !== "method")
          .map((sym) => ({
            id: sym.id,
            kind: sym.kind as "table" | "column",
            name: sym.name,
            qualifiedName: sym.qualifiedName,
            source: "sqlglot" as const,
          }));
      },
      ...(texts
        ? {
            async getCodeSymbolTexts(ids: string[]) {
              return ids.flatMap((id) => (texts[id] ? [{ id, text: texts[id]! }] : []));
            },
          }
        : {}),
    };
  };
  const writer = {
    id: "MarkAllAsReadBeforeDate",
    qualifiedName: `${ENTRY}::MarkAllAsReadBeforeDate`,
    filePath: ENTRY,
    startLine: 523,
    endLine: 533,
    confidence: 0.8,
    columns: ["entries.changed_at", "entries.status"],
    namesRequirementColumn: false,
  };

  it("separates the columns a writer filters on from the ones it writes", async () => {
    const [profile] = await profileDataPathWriters(
      [writer],
      source({ MarkAllAsReadBeforeDate: MARK_BEFORE_DATE_TEXT }),
    );
    expect(profile).toMatchObject({
      id: "MarkAllAsReadBeforeDate",
      writeTables: ["entries"],
      // `entries.id` and `entries.published_at` are read on the table it writes.
      predicateColumns: ["entries.id", "entries.published_at"],
      // A read of a table it does not write is not a predicate of this statement.
      readColumns: ["feeds.checked_at"],
      parameters: ["userID int64", "before time.Time"],
    });
    expect(profile!.sql).toContain("published_at < $4");
  });

  it("still profiles tables and predicates when no symbol text is stored", async () => {
    const [bare] = await profileDataPathWriters([writer], source(null));
    expect(bare).toMatchObject({
      writeTables: ["entries"],
      predicateColumns: ["entries.id", "entries.published_at"],
      signature: null,
      parameters: [],
      sql: null,
    });
    const [untexted] = await profileDataPathWriters([writer], source({}));
    expect(untexted!.signature).toBeNull();
  });

  it("asks nothing for no writers", async () => {
    expect(await profileDataPathWriters([], source({}))).toEqual([]);
  });
});
