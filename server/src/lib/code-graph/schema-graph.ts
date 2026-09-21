/**
 * Schema-graph writer — Epic #168 (#169).
 *
 * Reusable persistence primitives for the schema dimension of the code graph.
 * The MyBatis (#170), ORM (#171), and live-DB (#172) extractors all funnel
 * their inferred/authoritative table/column references through a
 * {@link SchemaGraphWriter}, which persists:
 *   - `table` / `column` {@link CodeSymbol} rows (new kinds from #169), and
 *   - `reads` / `writes` / `persists-to` {@link CodeEdge} rows linking a
 *     code/mapper/entity symbol → table/column,
 * each carrying a `source` provenance value (`live-db|mybatis|orm|ddl-file`).
 *
 * The writer caches table/column symbols by qualified name so repeated
 * references across many statements collapse onto a single symbol row.
 */
import { createHash } from "node:crypto";
import type { SchemaEdgeKind, SchemaRoutineKind, SchemaSource } from "@metis/shared";

/** Minimal Prisma surface the writer needs — injectable for unit tests. */
export interface SchemaGraphPrisma {
  codeSymbol: {
    create(args: { data: SchemaSymbolCreateData; select: { id: true } }): Promise<{ id: string }>;
  };
  codeEdge: {
    create(args: { data: SchemaEdgeCreateData }): Promise<unknown>;
  };
}

export interface SchemaSymbolCreateData {
  codeGraphId: string;
  projectId: string;
  kind: "table" | "column" | "method" | SchemaRoutineKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  contentHash: string;
  source: SchemaSource | null;
}

export interface SchemaEdgeCreateData {
  codeGraphId: string;
  projectId: string;
  kind: SchemaEdgeKind;
  fromSymbolId: string;
  toSymbolId: string | null;
  toQualifiedName: string | null;
  filePath: string;
  line: number;
  source: SchemaSource;
  /**
   * Edge-specific metadata, JSON-encoded before persistence. Mirrors the
   * existing `CodeEdge.metadata` column already used for TS import
   * `{ typeOnly: true }` (#308). Epic #881 (#890) uses it for the Tier-1 coarse
   * marker `{ tier: 1, coarse: true, direction: "unknown" }` so Tier-2
   * body-parsed edges (#891-#893) can detect and refine/override a coarse
   * `catalog-deps` edge.
   */
  metadata?: string | null;
}

/** Pseudo file path used for symbols sourced from a live DB (no repo file). */
export const LIVE_SCHEMA_FILE = "<live-db>";

/**
 * Normalize a SQL identifier: trim, strip surrounding quotes/backticks/brackets
 * and any schema-qualifying alias artifacts, and lowercase. Returns "" for an
 * empty/whitespace input so callers can reject it.
 */
export function normalizeIdentifier(raw: string): string {
  if (!raw) return "";
  let s = raw.trim();
  // Strip a trailing alias accidentally captured (e.g. "users u" handled by caller).
  s = s.replace(/^[`"[]/, "").replace(/[`"\]]$/, "");
  return s.trim().toLowerCase();
}

/** Schema-qualified identity for a table symbol. */
export function tableQualifiedName(schema: string | undefined, table: string): string {
  const t = normalizeIdentifier(table);
  const s = schema ? normalizeIdentifier(schema) : "";
  return s ? `${s}.${t}` : t;
}

/** Schema-qualified identity for a column symbol (`<table-qn>.<column>`). */
export function columnQualifiedName(
  schema: string | undefined,
  table: string,
  column: string,
): string {
  return `${tableQualifiedName(schema, table)}.${normalizeIdentifier(column)}`;
}

/**
 * Schema-qualified identity for a routine (procedure/function) symbol — #301.
 * Shares the `<schema>.<name>` shape with tables so reconciliation can resolve a
 * routine reference the same way. The routine `kind` (procedure vs function)
 * distinguishes it from a same-named table at the symbol level.
 */
export function routineQualifiedName(schema: string | undefined, routine: string): string {
  return tableQualifiedName(schema, routine);
}

/** Deterministic content hash for a schema symbol (provenance-aware). */
export function schemaSymbolHash(kind: string, qualifiedName: string, source: string): string {
  return createHash("sha256").update(`${kind}:${qualifiedName}:${source}`).digest("hex");
}

// ---- Unresolved/dynamic reference model (Epic #879, #886) -----------------
//
// Some parsers can determine a statement touches a table/column WITHOUT being
// able to resolve WHICH one — MyBatis `${tableName}` raw substitution (#886),
// Java raw JDBC string-concatenated identifiers (#888), PL/SQL
// `EXECUTE IMMEDIATE`-built SQL (#892), etc. Rather than inventing a new
// {@link SchemaEdgeKind} (which would force updates to every exhaustive
// edge-kind consumer — `SCHEMA_OBJECT_EDGE_KINDS`/`SCHEMA_IMPACT_EDGE_KINDS`/
// reconciliation), an unresolved reference is persisted as an ORDINARY edge
// (`reads`/`writes`/`persists-to`, chosen the normal way from the statement
// kind) whose target is a SYNTHETIC placeholder symbol, carrying an
// {@link UnresolvedRefMetadata} marker in `CodeEdge.metadata` — mirroring the
// Tier-1 coarse-lineage marker precedent (`TIER1_COARSE_METADATA`, #890).
//
// All extractors that can only see a dynamic/unresolved identifier should
// reuse THIS marker shape (via {@link unresolvedRefMetadata}) and THIS
// synthetic-name scheme (via {@link dynamicPlaceholderName}) so a downstream
// gap report (#895) can count "how much of the schema surface is dynamically
// resolved" consistently across MyBatis/JDBC/PL-SQL sources.

/** Prefix for a synthetic placeholder table/column qualifiedName standing in for
 * an unresolved dynamic identifier. SQL identifiers can never start with `?`,
 * so this can't collide with a real (case-insensitively normalized) table or
 * column name, and is trivially pattern-matchable for coverage counting via
 * `qualifiedName.startsWith(DYNAMIC_PLACEHOLDER_PREFIX)`. */
export const DYNAMIC_PLACEHOLDER_PREFIX = "?dynamic:";

/**
 * Build the canonical synthetic qualifiedName for an unresolved dynamic
 * table/column reference, given the raw placeholder expression text (e.g.
 * `tableName` from MyBatis `${tableName}`). Falls back to `unknown` for an
 * empty placeholder so a synthetic name is always well-formed.
 */
export function dynamicPlaceholderName(placeholder: string): string {
  const cleaned = normalizeIdentifier(placeholder).replace(/\s+/g, "_");
  return `${DYNAMIC_PLACEHOLDER_PREFIX}${cleaned || "unknown"}`;
}

/** Shared metadata marker for an edge whose target is an unresolved dynamic
 * identifier (#886). Every extractor that emits one of these edges should
 * produce the SAME shape so downstream consumers (#895) don't need to branch
 * per source. */
export interface UnresolvedRefMetadata extends Record<string, unknown> {
  unresolved: true;
  /** The raw dynamic expression text (e.g. `tableName` from `${tableName}`). */
  placeholder: string;
  /** The statement/call-site id the reference occurred in. */
  statementId: string;
  /** The mapper/class FQCN (or best-available identity) the statement belongs to. */
  mapper: string | null;
}

/** Build an {@link UnresolvedRefMetadata} marker. */
export function unresolvedRefMetadata(opts: {
  placeholder: string;
  statementId: string;
  mapper: string | null;
}): UnresolvedRefMetadata {
  return {
    unresolved: true,
    placeholder: opts.placeholder,
    statementId: opts.statementId,
    mapper: opts.mapper,
  };
}

export interface EnsureTableOptions {
  schema?: string;
  filePath?: string;
  line?: number;
}

export interface EnsureColumnOptions extends EnsureTableOptions {
  columnType?: string | null;
}

/**
 * Persists table/column symbols and schema edges for one code graph, deduping
 * symbols by qualified name within the writer's lifetime.
 */
export class SchemaGraphWriter {
  private readonly tableCache = new Map<string, string>();
  private readonly columnCache = new Map<string, string>();
  private readonly routineCache = new Map<string, string>();

  constructor(
    private readonly prisma: SchemaGraphPrisma,
    private readonly codeGraphId: string,
    private readonly projectId: string,
  ) {}

  /**
   * Seed the dedupe caches with ALREADY-PERSISTED schema symbols (#872) so
   * `ensureTable`/`ensureColumn` REUSE existing symbol ids instead of creating
   * duplicates. This keeps table/column ids STABLE across ingests — required
   * because ORM call-site edges from files that are NOT re-parsed on an
   * incremental ingest keep pointing at prior table ids; recreating the tables
   * would dangle those edges. Only `table`/`column` rows are seeded — a schema
   * `function` routine shares its kind string with ordinary code symbols, so
   * routines are deliberately NOT prewarmable through this bulk hook.
   */
  prewarm(rows: readonly { id: string; kind: string; qualifiedName: string }[]): void {
    for (const row of rows) {
      if (row.kind === "table") this.tableCache.set(row.qualifiedName, row.id);
      else if (row.kind === "column") this.columnCache.set(row.qualifiedName, row.id);
    }
  }

  /** Ensure a `table` symbol exists, returning its id (cached per qualified name). */
  async ensureTable(
    table: string,
    source: SchemaSource,
    opts: EnsureTableOptions = {},
  ): Promise<string> {
    const name = normalizeIdentifier(table);
    if (!name) throw new Error("ensureTable: empty table name");
    const qn = tableQualifiedName(opts.schema, table);
    const cached = this.tableCache.get(qn);
    if (cached) return cached;
    const created = await this.prisma.codeSymbol.create({
      data: {
        codeGraphId: this.codeGraphId,
        projectId: this.projectId,
        kind: "table",
        name,
        qualifiedName: qn,
        filePath: opts.filePath ?? LIVE_SCHEMA_FILE,
        startLine: opts.line ?? 0,
        endLine: opts.line ?? 0,
        language: "sql",
        contentHash: schemaSymbolHash("table", qn, source),
        source,
      },
      select: { id: true },
    });
    this.tableCache.set(qn, created.id);
    return created.id;
  }

  /** Ensure a `column` symbol exists, returning its id (cached per qualified name). */
  async ensureColumn(
    table: string,
    column: string,
    source: SchemaSource,
    opts: EnsureColumnOptions = {},
  ): Promise<string> {
    const colName = normalizeIdentifier(column);
    if (!colName) throw new Error("ensureColumn: empty column name");
    const qn = columnQualifiedName(opts.schema, table, column);
    const cached = this.columnCache.get(qn);
    if (cached) return cached;
    const created = await this.prisma.codeSymbol.create({
      data: {
        codeGraphId: this.codeGraphId,
        projectId: this.projectId,
        kind: "column",
        name: colName,
        qualifiedName: qn,
        filePath: opts.filePath ?? LIVE_SCHEMA_FILE,
        startLine: opts.line ?? 0,
        endLine: opts.line ?? 0,
        language: "sql",
        contentHash: schemaSymbolHash("column", qn, source),
        source,
      },
      select: { id: true },
    });
    this.columnCache.set(qn, created.id);
    return created.id;
  }

  /**
   * Ensure a `procedure`/`function` routine symbol exists, returning its id
   * (cached per qualified name) — Epic #293 Phase 2 (#301). Routines are
   * persisted from the read-only {@link DbRoutineInfo} introspection (#300); the
   * routine body is never stored. `source` is `live-db` for introspected
   * routines.
   */
  async ensureRoutine(
    routine: string,
    kind: SchemaRoutineKind,
    source: SchemaSource,
    opts: EnsureTableOptions = {},
  ): Promise<string> {
    const name = normalizeIdentifier(routine);
    if (!name) throw new Error("ensureRoutine: empty routine name");
    const qn = routineQualifiedName(opts.schema, routine);
    // Cache key includes the kind so a procedure and a same-named function are
    // distinct symbols.
    const cacheKey = `${kind}:${qn}`;
    const cached = this.routineCache.get(cacheKey);
    if (cached) return cached;
    const created = await this.prisma.codeSymbol.create({
      data: {
        codeGraphId: this.codeGraphId,
        projectId: this.projectId,
        kind,
        name,
        qualifiedName: qn,
        filePath: opts.filePath ?? LIVE_SCHEMA_FILE,
        startLine: opts.line ?? 0,
        endLine: opts.line ?? 0,
        language: "sql",
        contentHash: schemaSymbolHash(kind, qn, source),
        source,
      },
      select: { id: true },
    });
    this.routineCache.set(cacheKey, created.id);
    return created.id;
  }

  /**
   * Persist a generic code/mapper/entity symbol (e.g. a synthesized MyBatis
   * statement) so schema edges can originate from a stable `fromSymbolId`.
   */
  async createOriginSymbol(
    kind: "method",
    name: string,
    qualifiedName: string,
    filePath: string,
    line: number,
  ): Promise<string> {
    const created = await this.prisma.codeSymbol.create({
      data: {
        codeGraphId: this.codeGraphId,
        projectId: this.projectId,
        kind,
        name,
        qualifiedName,
        filePath,
        startLine: line,
        endLine: line,
        language: "sql",
        contentHash: schemaSymbolHash(kind, qualifiedName, "mybatis"),
        source: null,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Persist a schema edge. The `kind` may be a table/column edge
   * (`reads`/`writes`/`persists-to`, #168) or a routine edge (`executes` =
   * code→routine, `calls` = routine→object, #301). For routine edges the
   * `toSymbolId` is the routine symbol id (`executes`) or the referenced
   * table/column/routine symbol id (`calls`).
   */
  async addEdge(
    fromSymbolId: string,
    kind: SchemaEdgeKind,
    toSymbolId: string,
    source: SchemaSource,
    opts: {
      toQualifiedName?: string;
      filePath?: string;
      line?: number;
      /** Edge-specific metadata, e.g. the Tier-1 coarse-lineage marker (#890). */
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.prisma.codeEdge.create({
      data: {
        codeGraphId: this.codeGraphId,
        projectId: this.projectId,
        kind,
        fromSymbolId,
        toSymbolId,
        toQualifiedName: opts.toQualifiedName ?? null,
        filePath: opts.filePath ?? LIVE_SCHEMA_FILE,
        line: opts.line ?? 0,
        source,
        metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      },
    });
  }
}
