/**
 * SQL-lineage unresolved/dynamic coverage — Issue #895 (Epic #882 Phase 3).
 *
 * Turns the "how much of this project's schema surface could we resolve
 * precisely, and how much needs a human to confirm" question into an
 * actionable metric on the gap report. It consumes the unresolved-edge markers
 * the extractors already emit — nothing new is written at ingest time:
 *
 *   - DYNAMIC references — MyBatis `${}` raw substitution (#886), PL/SQL
 *     `EXECUTE IMMEDIATE` / unrecoverable `MERGE` (#892/#893), Java
 *     concatenated/`StringBuilder` SQL with a non-constant operand (#889) —
 *     persisted as an ordinary `reads`/`writes`/`persists-to`/`calls` edge
 *     carrying the shared {@link UnresolvedRefMetadata} marker
 *     (`metadata.unresolved === true`) in `CodeEdge.metadata`.
 *   - COARSE Tier-1 catalog dependencies (#890) — object-level-only,
 *     direction-unknown `calls` edges with `source === "catalog-deps"`.
 *
 * Both are edges the lineage pipeline could not resolve PRECISELY and that a
 * human may need to confirm; everything else (`live-db`/`sqlglot`/`mybatis`/
 * `orm`/`ddl-file`/`manual`) is treated as resolved. `coveragePercent` is the
 * resolved fraction; the report surfaces its inverse ("N% of table edges are
 * dynamically resolved / need manual confirmation") in the UI.
 *
 * PURE + read-only: this module only READS METIS's own `code_edges` rows via an
 * injected Prisma-shaped client and does arithmetic — it never writes, never
 * touches a customer database, never executes SQL. Total: a malformed
 * `metadata` JSON blob on one edge degrades that edge to "resolved" (fail
 * closed toward NOT over-reporting unresolved) rather than throwing.
 */
import {
  SQL_LINEAGE_COVERAGE_MAX_REFS,
  type SqlLineageCoverage,
  type SqlLineageUnresolvedRef,
} from "@metis/shared";

/**
 * The schema-relevant `CodeEdge.kind` values this metric counts. An unresolved
 * dynamic ref is persisted as one of the first three (chosen the normal way
 * from the statement); a coarse Tier-1 dependency is always `calls`. Ordinary
 * code edges (`imports`/`defines`/`references`) are NOT schema lineage and are
 * excluded so the denominator is "table/object edges", matching the metric's
 * framing ("N% of table edges …").
 */
const SCHEMA_LINEAGE_EDGE_KINDS = ["reads", "writes", "persists-to", "calls"] as const;

/** The provenance that marks a coarse, Tier-1-only (object-level) dependency edge (#890). */
const COARSE_CATALOG_SOURCE = "catalog-deps";

/** Minimal shape of a `CodeEdge` row this metric reads. */
export interface CoverageEdgeRow {
  id: string;
  kind: string;
  source: string | null;
  metadata: string | null;
  toQualifiedName: string | null;
  filePath: string;
}

/** Minimal Prisma-shaped surface {@link computeSqlLineageCoverage} needs (read-only). */
export interface SqlLineageCoveragePrismaClient {
  codeEdge: {
    findMany(args: {
      where: { projectId: string; kind: { in: readonly string[] } };
      select: {
        id: true;
        kind: true;
        source: true;
        metadata: true;
        toQualifiedName: true;
        filePath: true;
      };
    }): Promise<CoverageEdgeRow[]>;
  };
}

interface Classification {
  unresolved: boolean;
  reason: "dynamic" | "coarse-catalog" | null;
  placeholder: string | null;
  statementId: string | null;
  mapper: string | null;
}

/**
 * Classify ONE edge row as resolved or unresolved/dynamic. Pure; never throws —
 * an unparseable `metadata` blob degrades the edge to "resolved" (we never
 * fabricate an unresolved marker from a corrupt value). Exported for unit tests.
 */
export function classifyCoverageEdge(row: CoverageEdgeRow): Classification {
  const resolved: Classification = {
    unresolved: false,
    reason: null,
    placeholder: null,
    statementId: null,
    mapper: null,
  };

  // A dynamic/unresolved marker in metadata takes precedence — it is the more
  // specific signal (a catalog-deps edge never carries `unresolved: true`).
  if (row.metadata) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metadata);
    } catch {
      parsed = null;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { unresolved?: unknown }).unresolved === true
    ) {
      const m = parsed as Record<string, unknown>;
      return {
        unresolved: true,
        reason: "dynamic",
        placeholder: typeof m.placeholder === "string" ? m.placeholder : null,
        statementId: typeof m.statementId === "string" ? m.statementId : null,
        mapper: typeof m.mapper === "string" ? m.mapper : null,
      };
    }
  }

  // Coarse Tier-1 catalog dependency: object-level only, direction unknown (#890).
  if (row.source === COARSE_CATALOG_SOURCE) {
    return {
      unresolved: true,
      reason: "coarse-catalog",
      placeholder: null,
      statementId: null,
      mapper: null,
    };
  }

  return resolved;
}

/**
 * Compute {@link SqlLineageCoverage} for one project from its persisted schema
 * lineage edges. Returns `null` when the project has NO schema lineage edges at
 * all (nothing to divide — the report omits the section rather than showing
 * "0 of 0"). `unresolvedRefs` is capped at {@link SQL_LINEAGE_COVERAGE_MAX_REFS}
 * for payload size (deterministic: input row order, which the caller orders by
 * id); `unresolvedEdges` is ALWAYS the full count.
 */
export async function computeSqlLineageCoverage(
  projectId: string,
  prisma: SqlLineageCoveragePrismaClient,
): Promise<SqlLineageCoverage | null> {
  const rows = await prisma.codeEdge.findMany({
    where: { projectId, kind: { in: SCHEMA_LINEAGE_EDGE_KINDS } },
    select: {
      id: true,
      kind: true,
      source: true,
      metadata: true,
      toQualifiedName: true,
      filePath: true,
    },
  });

  return buildSqlLineageCoverage(rows);
}

/**
 * Pure builder over already-loaded edge rows — the arithmetic half of
 * {@link computeSqlLineageCoverage}, exported so tests (and any future
 * in-memory caller) can drive it without a Prisma fake. Returns `null` for an
 * empty input.
 */
export function buildSqlLineageCoverage(rows: CoverageEdgeRow[]): SqlLineageCoverage | null {
  if (rows.length === 0) return null;

  let resolvedEdges = 0;
  let unresolvedEdges = 0;
  const bySource: Record<string, { total: number; unresolved: number }> = {};
  const unresolvedRefs: SqlLineageUnresolvedRef[] = [];

  for (const row of rows) {
    const sourceKey = row.source ?? "unknown";
    const bucket = (bySource[sourceKey] ??= { total: 0, unresolved: 0 });
    bucket.total += 1;

    const c = classifyCoverageEdge(row);
    if (c.unresolved) {
      unresolvedEdges += 1;
      bucket.unresolved += 1;
      if (unresolvedRefs.length < SQL_LINEAGE_COVERAGE_MAX_REFS) {
        unresolvedRefs.push({
          edgeId: row.id,
          kind: row.kind as SqlLineageUnresolvedRef["kind"],
          source: sourceKey as SqlLineageUnresolvedRef["source"],
          reason: c.reason ?? "dynamic",
          filePath: row.filePath,
          toQualifiedName: row.toQualifiedName,
          placeholder: c.placeholder,
          statementId: c.statementId,
          mapper: c.mapper,
        });
      }
    } else {
      resolvedEdges += 1;
    }
  }

  const totalEdges = rows.length;
  // One-decimal resolved percentage; null only when there is nothing to divide
  // (unreachable here since rows.length > 0, but kept explicit for the type).
  const coveragePercent =
    totalEdges > 0 ? Math.round((resolvedEdges / totalEdges) * 1000) / 10 : null;

  return { totalEdges, resolvedEdges, unresolvedEdges, coveragePercent, bySource, unresolvedRefs };
}
