/**
 * #791 — the functions that write the data a requirement changes. Shapes are
 * Miniflux v2.3.3's after #807 (lineage edges start at the enclosing function).
 */
import { describe, expect, it } from "vitest";
import {
  requirementNamedColumns,
  resolveDataPathWriters,
  type DataPathDataSource,
} from "./data-path-writers.js";
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
      return edges.filter(
        (e) => ids.includes(e.toSymbolId) && (e.kind === "writes" || e.kind === "persists-to"),
      );
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
