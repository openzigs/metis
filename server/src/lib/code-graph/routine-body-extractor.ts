/**
 * Routine-body extractor — Epic #294 (#316), part B: `calls` edges.
 *
 * Parses stored-routine BODIES (procedures & functions) via the `metis-sql-lineage`
 * sidecar and emits `calls` edges (routine → table/column/routine) into the schema
 * graph with `source = "sqlglot"`. This is the routine-body counterpart of the
 * embedded-SQL extractor: where #305 attributes embedded SQL to a code method,
 * this attributes a routine's body-derived references to the ROUTINE symbol.
 *
 * SECURITY / SAFETY CONTRACT (non-negotiable, mirrors Phase 2's read-only posture):
 *   - The routine body is fetched by a READ-ONLY, parameterized driver query
 *     ({@link RoutineBodyFetcher}) and is ONLY PARSED by the sidecar — it is NEVER
 *     executed, and no DDL is ever run.
 *   - Feature-gated identically to the rest of the SQL-lineage path: when the
 *     sidecar is disabled ({@link extractUsageSafe} returns null) the extractor
 *     emits nothing. A body that cannot be fetched, or that the parser cannot
 *     resolve, is recorded as `uncertain` with the reserved
 *     `routine-body-unanalyzed` reason — NEVER dropped, NEVER auto-recommended for
 *     removal.
 *   - Never throws on a sidecar/fetch problem (graceful degradation): ingest must
 *     proceed and the routine simply stays `uncertain`.
 *
 * PL/SQL SEAM (Epic #881, #892/#893): the whole-body-to-sidecar call above works
 * for a plain single-statement function body, but sqlglot is a SQL parser, NOT a
 * PL/SQL compiler — it cannot parse a real Oracle package member's `DECLARE`/
 * `BEGIN`/`IF`/`LOOP`/exception-handler scaffolding (upstream sqlglot #1356,
 * closed "not planned"). `plsql-preprocessor.ts`'s `preprocessPlsqlBody` is a
 * pure, text-only pre-processing stage that strips that scaffolding and isolates
 * each standalone DML statement (tagged with its enclosing member), ready to be
 * handed to {@link extractUsageSafe} ONE STATEMENT AT A TIME instead of the raw
 * body. Wiring that per-statement loop (plus the resulting multi-statement
 * `persistCalls` + Tier-1 cross-validation) for Oracle package bodies is #893's
 * job — `preprocessPlsqlBody` is the seam it consumes; nothing in this file calls
 * it yet.
 */
import type { DbRoutineInfo, SchemaRoutineKind } from "@metis/shared";
import type { SchemaGraphWriter } from "./schema-graph.js";
import {
  extractUsageSafe,
  type IntrospectedSchema,
  type SqlLineageAccess,
  type SqlLineageClient,
} from "./sql-lineage-client.js";

/**
 * Reads a single routine's body text, READ-ONLY. Returns the DDL/source text, or
 * `null` when it is unavailable (driver does not support it, the principal lacks
 * catalog grants, or the routine vanished). Implemented per driver via the
 * dialect's metadata catalog (Oracle `ALL_SOURCE`/`DBMS_METADATA`, Postgres
 * `pg_get_functiondef`, MySQL `SHOW CREATE`/`information_schema.routines`, SQL
 * Server `OBJECT_DEFINITION`/`sys.sql_modules`). NEVER executes the body.
 */
export type RoutineBodyFetcher = (routine: DbRoutineInfo) => Promise<string | null>;

export interface RoutineBodyOptions {
  /** Override the dialect hint sent to the sidecar (e.g. "oracle"|"tsql"|…). */
  dialect?: string;
  /** Introspected schema for SELECT* expansion / column qualification (#317). */
  schema?: IntrospectedSchema | null;
  /** Inject a client (tests); production uses the env-configured singleton. */
  client?: SqlLineageClient;
  /** Epic #882 (#894) — resolved per-project SQL-lineage override. */
  sqlLineageOverride?: boolean | null;
}

export interface RoutineBodyResult {
  /** Number of `calls` edges written (routine → table/column). */
  edges: number;
  /** Number of routines whose body was fetched and parsed. */
  analyzed: number;
  /** Number of routines whose body was unavailable or unresolved (→ uncertain). */
  unanalyzed: number;
  /**
   * Uncertain refs (the reserved `routine-body-unanalyzed` reason, plus any the
   * sidecar reports). Never dropped — the caller persists them upstream.
   */
  uncertain: { routine: string; reason: string; detail: string }[];
}

/** Pseudo file path for a routine body (no repo file — it lives in the DB). */
function routineBodyPath(routine: DbRoutineInfo): string {
  const qn = routine.schema ? `${routine.schema}.${routine.name}` : routine.name;
  return `<routine-body>::${qn}`;
}

/**
 * Parse the bodies of the supplied routines and persist `calls` edges from each
 * routine symbol to the tables/columns its body touches. The routine symbols are
 * the same `<schema>.<name>` identities the live-db introspection materializes
 * (#301), so a `calls` edge folds into the routine's existing classification.
 *
 * Returns counts + uncertain refs. NEVER throws (graceful degradation). When the
 * sidecar is disabled every routine is reported `routine-body-unanalyzed`.
 */
export async function extractRoutineBodies(
  writer: SchemaGraphWriter,
  routines: DbRoutineInfo[],
  fetchBody: RoutineBodyFetcher,
  opts: RoutineBodyOptions = {},
): Promise<RoutineBodyResult> {
  const result: RoutineBodyResult = { edges: 0, analyzed: 0, unanalyzed: 0, uncertain: [] };
  if (routines.length === 0) return result;

  for (const routine of routines) {
    const qn = routine.schema ? `${routine.schema}.${routine.name}` : routine.name;

    // Fetch the body, read-only. A fetch failure must NOT abort the rest.
    let body: string | null = null;
    try {
      body = await fetchBody(routine);
    } catch {
      body = null;
    }
    if (!body || !body.trim()) {
      result.unanalyzed += 1;
      result.uncertain.push({
        routine: qn,
        reason: "routine-body-unanalyzed",
        detail: "routine body unavailable",
      });
      continue;
    }

    const extraction = await extractUsageSafe(
      { sql: body, dialect: opts.dialect ?? "", schema: opts.schema ?? null },
      opts.client,
      opts.sqlLineageOverride,
    );
    if (!extraction) {
      // Sidecar disabled/unreachable — degrade. The routine stays uncertain so it
      // is never silently treated as having no dependencies.
      result.unanalyzed += 1;
      result.uncertain.push({
        routine: qn,
        reason: "routine-body-unanalyzed",
        detail: "sidecar unavailable; routine body unparsed",
      });
      continue;
    }

    result.analyzed += 1;
    result.edges += await persistCalls(writer, routine, extraction);

    // Surface every uncertain ref the sidecar returned (the routine-body caveat is
    // always present for a parsed body). Never dropped.
    for (const u of extraction.uncertain) {
      result.uncertain.push({ routine: qn, reason: u.reason, detail: u.detail });
    }
    if (extraction.uncertain.length === 0) {
      // A fully-resolved body still gets the body caveat so reviewers know a
      // dynamic fragment could have been missed — never droppable.
      result.uncertain.push({
        routine: qn,
        reason: "routine-body-unanalyzed",
        detail: "routine body parsed; dynamic calls may be incomplete",
      });
    }
  }

  return result;
}

/** Persist one routine's body references as `calls` edges (source sqlglot). */
async function persistCalls(
  writer: SchemaGraphWriter,
  routine: DbRoutineInfo,
  extraction: Awaited<ReturnType<typeof extractUsageSafe>>,
): Promise<number> {
  if (!extraction || extraction.tables.length === 0) return 0;
  const filePath = routineBodyPath(routine);
  const kind: SchemaRoutineKind = routine.type;
  // The `from` side is the routine symbol itself (`<schema>.<name>`), matching the
  // live-db routine identity so the edge attaches to the existing routine object.
  const fromId = await writer.ensureRoutine(routine.name, kind, "sqlglot", {
    schema: routine.schema || undefined,
    filePath,
  });

  const colsByTable = new Map<string, { column: string; access: SqlLineageAccess }[]>();
  for (const c of extraction.columns) {
    const list = colsByTable.get(c.table) ?? [];
    list.push({ column: c.column, access: c.access });
    colsByTable.set(c.table, list);
  }

  let edges = 0;
  for (const table of extraction.tables) {
    const tableId = await writer.ensureTable(table.name, "sqlglot", {
      schema: table.schema || undefined,
      filePath,
    });
    // `calls` = routine → object (the routine's body touches this table/column).
    await writer.addEdge(fromId, "calls", tableId, "sqlglot", {
      toQualifiedName: table.qualifiedName,
      filePath,
    });
    edges += 1;
    for (const col of colsByTable.get(table.qualifiedName) ?? []) {
      const colId = await writer.ensureColumn(table.name, col.column, "sqlglot", {
        schema: table.schema || undefined,
        filePath,
      });
      await writer.addEdge(fromId, "calls", colId, "sqlglot", {
        toQualifiedName: `${table.qualifiedName}.${col.column}`,
        filePath,
      });
      edges += 1;
    }
  }

  // Routine-to-routine `calls`: a body that invokes another routine.
  for (const ref of extraction.routines) {
    const calleeId = await writer.ensureRoutine(ref.name, "procedure", "sqlglot", {
      schema: ref.schema || undefined,
      filePath,
    });
    await writer.addEdge(fromId, "calls", calleeId, "sqlglot", {
      toQualifiedName: ref.qualifiedName,
      filePath,
    });
    edges += 1;
  }

  return edges;
}
