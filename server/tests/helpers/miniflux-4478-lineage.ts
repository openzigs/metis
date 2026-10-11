/**
 * Miniflux v2.3.3's "mark all as read" data path, as METIS's graph records it
 * after #807 — the fixture behind the #791 gate tests and the #1051 persistence
 * tests.
 *
 * One UI handler (`markAllAsRead`) calls the storage layer; two storage
 * functions write `entries.status` / `entries.changed_at`, and one of them,
 * `MarkAllAsReadBeforeDate`, also READS `entries.published_at` — the WHERE of
 * its UPDATE. Its stored text is the run-7 graph's, verbatim.
 */
import type { SchemaEdgeKind } from "@metis/shared";
import { InMemoryCodeGraphDataSource } from "../../src/lib/impact-analysis/impact-analysis-engine.js";
import type {
  AffectedTableInput,
  SchemaImpactDataSource,
} from "../../src/lib/impact-analysis/schema-impact.js";

export const ENTRY = "internal/storage/entry.go";
export const UI = "internal/ui/unread_mark_all_read.go";

export interface Sym {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}
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
const schema = (qualifiedName: string): Sym => {
  const [table, column] = qualifiedName.split(".");
  return {
    id: qualifiedName,
    kind: column ? "column" : "table",
    name: column ?? table!,
    qualifiedName,
    filePath: "internal/database/migrations.go",
    startLine: 1,
    endLine: 1,
    language: "sql",
  };
};

export const SYMBOLS: Sym[] = [
  fn("markAllAsRead", UI, 13),
  fn("MarkAllAsRead", ENTRY, 506),
  fn("MarkAllAsReadBeforeDate", ENTRY, 523),
  fn("UserByID", "internal/storage/user.go", 200),
  ...[
    "entries",
    "entries.status",
    "entries.changed_at",
    "entries.published_at",
    "entries.user_id",
  ].map(schema),
  ...["users", "users.id"].map(schema),
];
export const EDGES: { fromSymbolId: string; toSymbolId: string; kind: SchemaEdgeKind }[] = [
  { fromSymbolId: "MarkAllAsRead", toSymbolId: "entries", kind: "writes" },
  { fromSymbolId: "MarkAllAsRead", toSymbolId: "entries.status", kind: "writes" },
  { fromSymbolId: "MarkAllAsRead", toSymbolId: "entries.changed_at", kind: "writes" },
  { fromSymbolId: "MarkAllAsRead", toSymbolId: "entries.user_id", kind: "reads" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries", kind: "writes" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.status", kind: "writes" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.changed_at", kind: "writes" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.published_at", kind: "reads" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.user_id", kind: "reads" },
  { fromSymbolId: "UserByID", toSymbolId: "users", kind: "reads" },
  { fromSymbolId: "UserByID", toSymbolId: "users.id", kind: "reads" },
];
/** The UI handler calls the storage layer through `h.store.X()`. */
export const CALLS = [
  { fromSymbolId: "markAllAsRead", toSymbolId: "MarkAllAsRead" },
  { fromSymbolId: "markAllAsRead", toSymbolId: "UserByID" },
];
/** `CodeSymbolEmbedding.text` of the run-7 graph, verbatim. */
export const TEXTS: Record<string, string> = {
  MarkAllAsReadBeforeDate: [
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
  ].join("\n"),
};

export function schemaDataSource(
  over: Partial<SchemaImpactDataSource> = {},
): SchemaImpactDataSource {
  const schemaRow = (s: Sym) => ({
    id: s.id,
    kind: s.kind as "table" | "column",
    name: s.name,
    qualifiedName: s.qualifiedName,
    source: "sqlglot" as const,
  });
  return {
    getSchemaEdgesFrom: async (ids) => EDGES.filter((e) => ids.includes(e.fromSymbolId)),
    getSchemaSymbolsByIds: async (ids) =>
      SYMBOLS.filter((s) => ids.includes(s.id) && s.language === "sql").map(schemaRow),
    getDownstreamCallEdgesFrom: async (ids) => CALLS.filter((c) => ids.includes(c.fromSymbolId)),
    getColumnsOfTables: async (tables) =>
      SYMBOLS.filter(
        (s) => s.kind === "column" && tables.includes(s.qualifiedName.split(".")[0]!),
      ).map(schemaRow),
    getWriterEdgesTo: async (ids) =>
      EDGES.filter((e) => ids.includes(e.toSymbolId) && e.kind === "writes"),
    getCodeSymbolDetails: async (ids) => SYMBOLS.filter((s) => ids.includes(s.id)),
    getCodeSymbolTexts: async (ids) =>
      ids.flatMap((id) => (TEXTS[id] ? [{ id, text: TEXTS[id]! }] : [])),
    ...over,
  };
}

export const graph = new InMemoryCodeGraphDataSource(
  SYMBOLS.filter((s) => s.language === "go").map(({ name: _name, ...rest }) => rest),
  [],
);

export function column(
  tableName: string,
  columnName: string,
  columnType: string,
): AffectedTableInput {
  return {
    objectKind: "column",
    tableName,
    columnName,
    columnType,
    changeKind: "add-column",
    suggestedDdl: `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}; -- SUGGESTED`,
    source: "sqlglot",
    reconciliation: null,
    confidence: 0.5,
  };
}

/** The seeding a run of this fixture starts from: the UI handler, nothing else. */
export const UI_HANDLER_SEEDS = {
  editCandidates: [
    {
      codeSymbolId: "markAllAsRead",
      filePath: UI,
      qualifiedName: `${UI}::markAllAsRead`,
      startLine: 13,
      endLine: 20,
      confidence: 1,
    },
  ],
  related: [],
  schemaSeeds: [],
};
