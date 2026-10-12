/**
 * #1060 — a small code graph in the shape of Miniflux #4511 ("last successful
 * refresh in the feed API"), and an in-memory `PlanLocalisationSource` over it.
 *
 * A UI handler and one UI file are what similarity retrieves. The migration,
 * the storage writers, the query builder and the client struct are not, and
 * share no word with the spec: the plan localisation has to reach them through
 * the graph.
 */
import {
  entityTypeKeysForTable,
  type CodeSymbolDetail,
  type SchemaImpactDataSource,
} from "../../src/lib/impact-analysis/schema-impact.js";
import type { PlanLocalisationSource } from "../../src/lib/spec-kit/plan-localisation.js";

export interface Sym extends CodeSymbolDetail {
  name: string;
  text?: string;
}
export interface Edge {
  from: string;
  to: string;
  kind: "calls" | "reads" | "writes" | "persists-to";
  source?: string | null;
  /** The callee as written, for a call. */
  callee?: string;
}

export function sym(
  id: string,
  kind: string,
  qualifiedName: string,
  filePath: string,
  startLine = 1,
  text?: string,
): Sym {
  // `pkg/file.go::Name` for code, `table.column` for schema: the last segment either way.
  const tail = qualifiedName.slice(qualifiedName.lastIndexOf("::") + 1).replace(/^:/, "");
  const name = kind === "table" || kind === "column" ? tail.slice(tail.lastIndexOf(".") + 1) : tail;
  return {
    id,
    kind,
    name,
    qualifiedName,
    filePath,
    startLine,
    endLine: startLine + 9,
    language: kind === "table" || kind === "column" ? "sql" : "go",
    ...(text ? { text } : {}),
  };
}

export const STORAGE = "internal/storage";
export const MIGRATIONS = "internal/database/migrations.go";

export function minifluxGraph(): { symbols: Sym[]; edges: Edge[] } {
  const symbols: Sym[] = [
    // Retrieved by similarity.
    sym(
      "h-refresh",
      "function",
      "internal/ui/feed_refresh.go::refreshFeed",
      "internal/ui/feed_refresh.go",
      17,
    ),
    sym("m-entries", "module", "internal/ui/feed_entries.go", "internal/ui/feed_entries.go"),
    sym(
      "f-show",
      "function",
      "internal/ui/feed_entries.go::showFeedEntriesPage",
      "internal/ui/feed_entries.go",
      15,
    ),
    // The data layer: never retrieved.
    sym(
      "st-update",
      "function",
      `${STORAGE}/feed.go::UpdateFeed`,
      `${STORAGE}/feed.go`,
      331,
      "function UpdateFeed in internal/storage/feed.go\nfunc (s *Storage) UpdateFeed(feed *model.Feed) error {\n\tquery := `UPDATE feeds SET checked_at=$1, title=$2 WHERE id=$3`\n}",
    ),
    sym("st-create", "function", `${STORAGE}/feed.go::CreateFeed`, `${STORAGE}/feed.go`, 216),
    sym("st-byid", "function", `${STORAGE}/feed.go::FeedByID`, `${STORAGE}/feed.go`, 200),
    sym("st-exists", "function", `${STORAGE}/feed.go::FeedExists`, `${STORAGE}/feed.go`, 36),
    sym(
      "st-nav",
      "function",
      `${STORAGE}/nav_metadata.go::GetNavMetadata`,
      `${STORAGE}/nav_metadata.go`,
      20,
    ),
    sym("st-user", "function", `${STORAGE}/user.go::UserByID`, `${STORAGE}/user.go`, 345),
    sym(
      "qb-new",
      "function",
      `${STORAGE}/feed_query_builder.go::NewFeedQueryBuilder`,
      `${STORAGE}/feed_query_builder.go`,
      32,
    ),
    sym(
      "util-json",
      "function",
      "internal/http/response/json.go::JSON",
      "internal/http/response/json.go",
      18,
    ),
    // Schema.
    sym("tbl-feeds", "table", "feeds", MIGRATIONS, 1471),
    sym("col-checked", "column", "feeds.checked_at", `${STORAGE}/feed.go`),
    sym("col-title", "column", "feeds.title", `${STORAGE}/feed.go`),
    sym("col-id", "column", "feeds.id", `${STORAGE}/feed.go`),
    sym("tbl-users", "table", "users", MIGRATIONS, 313),
    sym("col-uid", "column", "users.id", `${STORAGE}/user.go`),
    // The types named for the table.
    sym(
      "ty-model",
      "class",
      "internal/model/feed.go::Feed",
      "internal/model/feed.go",
      24,
      'class Feed in internal/model/feed.go\ntype Feed struct {\n\tID int64 `json:"id"`\n\tCheckedAt time.Time `json:"checked_at"`\n}',
    ),
    sym("ty-client", "class", "client/model.go::Feed", "client/model.go", 143),
    // A structural twin of the retrieved page handler.
    sym(
      "f-cat",
      "function",
      "internal/ui/category_entries.go::showCategoryEntriesPage",
      "internal/ui/category_entries.go",
      15,
    ),
    // Never to be named.
    sym(
      "t-writer",
      "function",
      `${STORAGE}/feed_test.go::TestUpdateFeed`,
      `${STORAGE}/feed_test.go`,
      10,
    ),
    sym("sql-origin", "method", `${MIGRATIONS}::sql@1471`, MIGRATIONS, 1471),
    sym("orm-model", "method", "schema.prisma::Feed", "prisma/schema.prisma", 5),
  ];
  const edges: Edge[] = [
    { from: "h-refresh", to: "st-update", kind: "calls", callee: "UpdateFeed" },
    { from: "h-refresh", to: "st-byid", kind: "calls", callee: "FeedByID" },
    { from: "h-refresh", to: "util-json", kind: "calls", callee: "JSON" },
    { from: "f-show", to: "st-byid", kind: "calls", callee: "FeedByID" },
    { from: "f-show", to: "st-user", kind: "calls", callee: "UserByID" },
    { from: "st-byid", to: "qb-new", kind: "calls", callee: "NewFeedQueryBuilder" },
    { from: "st-update", to: "col-checked", kind: "writes" },
    { from: "st-update", to: "col-title", kind: "writes" },
    { from: "st-create", to: "col-title", kind: "persists-to" },
    { from: "st-create", to: "tbl-feeds", kind: "persists-to" },
    { from: "st-exists", to: "col-id", kind: "reads" },
    { from: "st-nav", to: "tbl-feeds", kind: "reads" },
    { from: "st-update", to: "col-id", kind: "reads" },
    { from: "st-user", to: "col-uid", kind: "reads" },
    { from: "t-writer", to: "col-title", kind: "writes" },
    { from: "sql-origin", to: "col-title", kind: "writes" },
    { from: "orm-model", to: "col-title", kind: "persists-to", source: "orm" },
  ];
  // Twins: the two page handlers share seven callee names.
  for (const callee of ["a", "b", "c", "d", "e", "f", "g"]) {
    edges.push({ from: "f-show", to: "", kind: "calls", callee });
    edges.push({ from: "f-cat", to: "", kind: "calls", callee });
  }
  return { symbols, edges };
}

export function fakeSource(graph: { symbols: Sym[]; edges: Edge[] }): PlanLocalisationSource & {
  schema: SchemaImpactDataSource;
} {
  const byId = new Map(graph.symbols.map((s) => [s.id, s]));
  const isSchema = (s: Sym) => s.kind === "table" || s.kind === "column";
  const detail = ({ name: _n, text: _t, ...d }: Sym): CodeSymbolDetail => d;
  const schema: SchemaImpactDataSource = {
    async getSchemaEdgesFrom(ids) {
      return graph.edges
        .filter((e) => ids.includes(e.from) && e.kind !== "calls")
        .map((e) => ({ fromSymbolId: e.from, toSymbolId: e.to, kind: e.kind as "reads" }));
    },
    async getSchemaSymbolsByIds(ids) {
      return graph.symbols
        .filter((s) => ids.includes(s.id) && isSchema(s))
        .map((s) => ({
          id: s.id,
          kind: s.kind as "table" | "column",
          name: s.name,
          qualifiedName: s.qualifiedName,
          source: null,
        }));
    },
    async getDownstreamCallEdgesFrom(ids) {
      return graph.edges
        .filter((e) => ids.includes(e.from) && e.kind === "calls" && e.to !== "")
        .map((e) => ({ fromSymbolId: e.from, toSymbolId: e.to }));
    },
    async getColumnsOfTables(tables) {
      return graph.symbols
        .filter(
          (s) => s.kind === "column" && tables.some((t) => s.qualifiedName.startsWith(`${t}.`)),
        )
        .map((s) => ({
          id: s.id,
          kind: "column" as const,
          name: s.name,
          qualifiedName: s.qualifiedName,
          source: null,
        }));
    },
    async getWriterEdgesTo(ids) {
      return graph.edges
        .filter((e) => ids.includes(e.to) && (e.kind === "writes" || e.kind === "persists-to"))
        .map((e) => ({
          fromSymbolId: e.from,
          toSymbolId: e.to,
          kind: e.kind as "writes",
          source: e.source ?? null,
        }));
    },
    async getCodeSymbolDetails(ids) {
      return ids.flatMap((id) => (byId.has(id) ? [detail(byId.get(id)!)] : []));
    },
    async getDataModelSymbols(tables) {
      return graph.symbols
        .filter(
          (s) =>
            (s.kind === "table" && tables.includes(s.qualifiedName)) ||
            (s.kind === "class" &&
              tables.some((t) => entityTypeKeysForTable(t).includes(s.name.toLowerCase()))),
        )
        .map(detail);
    },
    async getCodeSymbolTexts(ids) {
      return graph.symbols
        .filter((s) => ids.includes(s.id) && s.text)
        .map((s) => ({ id: s.id, text: s.text as string }));
    },
  };
  return {
    schema,
    async getReaderEdgesTo(ids) {
      return graph.edges
        .filter((e) => ids.includes(e.to) && e.kind === "reads")
        .map((e) => ({ fromSymbolId: e.from, toSymbolId: e.to }));
    },
    async getFunctionsInFiles(files) {
      return graph.symbols
        .filter((s) => files.includes(s.filePath) && s.kind === "function")
        .map(detail);
    },
    async calleeNameSets() {
      const out = new Map<string, Set<string>>();
      for (const e of graph.edges) {
        if (e.kind !== "calls" || !e.callee) continue;
        out.set(e.from, (out.get(e.from) ?? new Set<string>()).add(e.callee));
      }
      // Every caller: a superset of the candidates the production source narrows to.
      return { sets: out };
    },
  };
}
