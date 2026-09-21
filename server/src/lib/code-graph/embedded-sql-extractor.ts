/**
 * Embedded-SQL extractor — Epic #294 (#305).
 *
 * Broadens schema-usage extraction beyond the MyBatis (`mybatis-extractor.ts`),
 * ORM (`orm-extractor.ts`), and `.sql`-file (`sql-rule-miner.ts`) paths to cover
 * SQL **embedded as string literals** in ordinary application code across
 * TS/JS/Python/Go/Java (Java raw JDBC — Issue #888, epic #880). It:
 *
 *   1. uses the existing tree-sitter parsers ({@link findStringLiterals}, or
 *      {@link findJavaConcatSqlCandidates} for Java — which additionally
 *      assembles `+`-concatenated string constants and simple
 *      `StringBuilder`/`StringBuffer` append chains, Issue #889) to locate
 *      string/template literals in a source file,
 *   2. heuristically keeps the ones that look like SQL,
 *   3. hands each to the `metis-sql-lineage` sidecar via the #304 client
 *      (passing the introspected schema — the column-accuracy lever), and
 *   4. persists the returned tables/columns as `reads`/`writes`/`persists-to`
 *      edges in the schema graph with `source = "sqlglot"`.
 *
 * Graceful degradation (the #294 requirement): when the sidecar is disabled or
 * unreachable, {@link extractUsageSafe} returns null and this extractor emits
 * NOTHING for that file rather than throwing — doc/impact generation proceeds and
 * the unresolved SQL stays `uncertain` upstream (never dropped). Any `uncertain`
 * entry the sidecar DOES return is reported back so the caller can record it.
 *
 * It does NOT touch `node-sql-parser` (the SELECT validator at
 * `connectors/db/sql-validator.ts`) — that stays the query-time guard.
 */
import type { Language } from "./parsers.js";
import { detectLanguage, findJavaConcatSqlCandidates, findStringLiterals } from "./parsers.js";
import type { SchemaGraphWriter } from "./schema-graph.js";
import {
  extractUsageSafe,
  type ExtractUsageResult,
  type IntrospectedSchema,
  type SqlLineageAccess,
  type SqlLineageClient,
} from "./sql-lineage-client.js";

/** Map an access kind from the sidecar to a schema-graph edge kind. */
const ACCESS_EDGE_KIND: Record<SqlLineageAccess, "reads" | "writes" | "persists-to"> = {
  read: "reads",
  write: "writes",
  persist: "persists-to",
};

/** Languages whose embedded SQL we scan, and the dialect hint to send. */
const LANGUAGE_DIALECT: Partial<Record<Language, string>> = {
  // We don't know the target DB from app code, so send the permissive ANSI
  // default and let sqlglot parse generically. Callers with a known connector
  // dialect can override via {@link extractEmbeddedSql} options.
  ts: "",
  js: "",
  py: "",
  go: "",
  // Issue #900 — C# ADO.NET (`SqlCommand`) + Dapper (`connection.Query<T>("...")`
  // / `Execute("...")`) raw SQL lives in ordinary string literals, so it rides
  // the same embedded-SQL path. No target DB is known from app code, so send the
  // permissive ANSI default (callers with a known connector dialect override).
  cs: "",
  // Issue #888 — Java raw JDBC (PreparedStatement/Statement string SQL).
  // Oracle is the default dialect (the user's stack per the epic); callers
  // with a known connector dialect can still override via
  // {@link EmbeddedSqlOptions.dialect}. `normalize_dialect` in the sidecar
  // maps "oracle" → sqlglot's "oracle" dialect directly.
  java: "oracle",
};

/** Minimum length for a literal to be worth SQL-sniffing (avoids tiny strings). */
const MIN_SQL_LEN = 12;

// A literal looks like SQL when it starts with (or clearly contains) a DML/DDL
// verb followed by SQL structure. Intentionally conservative — false positives
// just cost a sidecar round-trip that returns nothing; false negatives miss a
// usage edge. Anchored, literal alternations (Semgrep-safe).
const SQL_LEADING_RE =
  /^\s*(?:with\b[\s\S]*?\bselect\b|select\b|insert\s+into\b|update\b|delete\s+from\b|merge\s+into\b|replace\s+into\b|create\s+(?:or\s+replace\s+)?(?:table|view|procedure|function)\b|call\b|exec(?:ute)?\b)/i;
// Secondary check: a SELECT/FROM pairing anywhere (covers leading comments).
const SQL_SHAPE_RE = /\bselect\b[\s\S]*\bfrom\b|\b(?:insert\s+into|update|delete\s+from)\b/i;

/**
 * Heuristic: does this string literal look like a SQL statement? Used to avoid
 * shipping every string in a file to the sidecar.
 */
export function looksLikeSql(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_SQL_LEN) return false;
  return SQL_LEADING_RE.test(t) || SQL_SHAPE_RE.test(t);
}

export interface EmbeddedSqlOptions {
  /** Override the dialect hint (e.g. from a known DB connector on the project). */
  dialect?: string;
  /** Introspected schema for SELECT* expansion / column qualification. */
  schema?: IntrospectedSchema | null;
  /** Inject a client (tests); production uses the env-configured singleton. */
  client?: SqlLineageClient;
  /** Epic #882 (#894) — resolved per-project SQL-lineage override. */
  sqlLineageOverride?: boolean | null;
}

export interface EmbeddedSqlCandidate {
  sql: string;
  line: number;
  /** True when the literal interpolates (dynamic SQL → expected uncertain). */
  dynamic: boolean;
}

/** Locate the SQL-looking string literals in one source file. */
export function findEmbeddedSqlCandidates(
  source: string,
  language: Language,
): EmbeddedSqlCandidate[] {
  // Java (#888/#889): a single scan handles lone literals, `+` concatenation of
  // string constants, and simple `StringBuilder`/`StringBuffer` append chains,
  // assembling each into ONE SQL string before the SQL-shape filter. A chain
  // that mixes in a non-constant operand comes back `dynamic: true`.
  const literals =
    language === "java"
      ? findJavaConcatSqlCandidates(source)
      : findStringLiterals(source, language);
  const out: EmbeddedSqlCandidate[] = [];
  for (const lit of literals) {
    if (looksLikeSql(lit.text)) {
      out.push({ sql: lit.text, line: lit.line, dynamic: lit.dynamic });
    }
  }
  return out;
}

export interface EmbeddedSqlResult {
  /** Number of schema edges written. */
  edges: number;
  /** Number of SQL candidates located. */
  candidates: number;
  /** Number of candidates the sidecar could resolve to at least one table. */
  resolved: number;
  /** Uncertain refs reported by the sidecar (e.g. dynamic SQL) — never dropped. */
  uncertain: { reason: string; detail: string; line: number }[];
}

/** Build the `from` symbol id for a SQL literal in app code. */
async function originFor(
  writer: SchemaGraphWriter,
  filePath: string,
  line: number,
): Promise<string> {
  return writer.createOriginSymbol(
    "method",
    `sql@${line}`,
    `${filePath}::sql@${line}`,
    filePath,
    line,
  );
}

/** Persist one sidecar result's tables/columns as schema edges (source sqlglot). */
async function persistResult(
  writer: SchemaGraphWriter,
  filePath: string,
  line: number,
  result: ExtractUsageResult,
): Promise<number> {
  if (result.tables.length === 0) return 0;
  const fromId = await originFor(writer, filePath, line);
  let edges = 0;
  // Index columns by their owning table for per-table edge attribution.
  const colsByTable = new Map<string, { column: string; access: SqlLineageAccess }[]>();
  for (const c of result.columns) {
    const list = colsByTable.get(c.table) ?? [];
    list.push({ column: c.column, access: c.access });
    colsByTable.set(c.table, list);
  }
  for (const table of result.tables) {
    const kind = ACCESS_EDGE_KIND[table.access];
    const tableId = await writer.ensureTable(table.name, "sqlglot", {
      schema: table.schema || undefined,
      filePath,
      line,
    });
    await writer.addEdge(fromId, kind, tableId, "sqlglot", {
      toQualifiedName: table.qualifiedName,
      filePath,
      line,
    });
    edges++;
    for (const col of colsByTable.get(table.qualifiedName) ?? []) {
      const colId = await writer.ensureColumn(table.name, col.column, "sqlglot", {
        schema: table.schema || undefined,
        filePath,
        line,
      });
      await writer.addEdge(fromId, ACCESS_EDGE_KIND[col.access], colId, "sqlglot", {
        toQualifiedName: `${table.qualifiedName}.${col.column}`,
        filePath,
        line,
      });
      edges++;
    }
  }
  return edges;
}

/**
 * Extract embedded SQL from one source file and persist the resulting schema
 * edges. Returns counts + any uncertain refs. Never throws on sidecar problems
 * (graceful degradation). When the language is unsupported or no SQL is found,
 * returns a zeroed result without contacting the sidecar.
 */
export async function extractEmbeddedSql(
  writer: SchemaGraphWriter,
  filePath: string,
  source: string,
  opts: EmbeddedSqlOptions = {},
): Promise<EmbeddedSqlResult> {
  const empty: EmbeddedSqlResult = { edges: 0, candidates: 0, resolved: 0, uncertain: [] };
  const language = detectLanguage(filePath);
  if (!language || !(language in LANGUAGE_DIALECT)) return empty;

  const candidates = findEmbeddedSqlCandidates(source, language);
  if (candidates.length === 0) return empty;

  const dialect = opts.dialect ?? LANGUAGE_DIALECT[language] ?? "";
  const result: EmbeddedSqlResult = { ...empty, candidates: candidates.length, uncertain: [] };

  for (const candidate of candidates) {
    // Java concatenation with a non-constant operand (#889): the assembled
    // fragments are missing the runtime piece, so the statement's identifiers
    // can't be trusted. Record it as unresolved/dynamic rather than shipping a
    // truncated string to sqlglot and mis-parsing it. (Other languages preserve
    // their interpolation markers verbatim, so their dynamic candidates are
    // still parseable and are left to the sidecar as before.)
    if (language === "java" && candidate.dynamic) {
      result.uncertain.push({
        reason: "dynamic-reference",
        detail: "java SQL built with a non-constant operand; not parsed",
        line: candidate.line,
      });
      continue;
    }
    const extraction = await extractUsageSafe(
      { sql: candidate.sql, dialect, schema: opts.schema ?? null },
      opts.client,
      opts.sqlLineageOverride,
    );
    if (!extraction) {
      // Sidecar unavailable/disabled — degrade. A dynamic candidate is recorded
      // as uncertain so it is never silently dropped; a static one is simply
      // left for a later run when the sidecar is back.
      if (candidate.dynamic) {
        result.uncertain.push({
          reason: "dynamic-reference",
          detail: "sidecar unavailable; dynamic SQL unresolved",
          line: candidate.line,
        });
      }
      continue;
    }
    result.edges += await persistResult(writer, filePath, candidate.line, extraction);
    if (extraction.tables.length > 0) result.resolved++;
    for (const u of extraction.uncertain) {
      result.uncertain.push({ reason: u.reason, detail: u.detail, line: candidate.line });
    }
  }

  return result;
}
