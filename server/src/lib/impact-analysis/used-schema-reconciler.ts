/**
 * Full-schema vs code-edge reconciler — Epic #292 (#296).
 *
 * Joins the introspected **full schema** (`driver.introspect(): DbTableInfo[]`)
 * with the existing **code→schema graph edges** (`reads`/`writes`/`persists-to`,
 * already produced by the MyBatis/ORM/DDL/live extractors — see
 * `code-graph/schema-graph.ts` and `impact-analysis/schema-impact.ts`). It emits
 * one {@link ReconciledObject} per table AND column with an inbound-edge
 * evidence list.
 *
 * This module is a **PURE function** — it performs NO DB writes and NO network
 * I/O (that is the job of #297's classifier/persistence). Callers feed it the
 * already-read schema and the already-derived edges; it does NOT re-derive
 * edges. Unmatched edges (`table-not-found`/`column-not-found`) are preserved as
 * synthetic "phantom" objects so the downstream classifier can flag them
 * `uncertain` rather than silently dropping the evidence.
 *
 * Identity is keyed on the schema-qualified table name + bare column name, using
 * the same {@link normalizeIdentifier} normalization as the schema-graph writer
 * so case/quoting differences between the live schema and inferred mappers line
 * up. A schema-less edge table name falls back to matching any same-named live
 * table.
 */
import type { DbRoutineInfo, DbTableInfo, ReconciledObject, UsageEvidence } from "@metis/shared";
import type {
  SchemaEdgeKind,
  SchemaReconciliation,
  SchemaRoutineKind,
  SchemaSource,
} from "@metis/shared";
import {
  columnQualifiedName,
  normalizeIdentifier,
  routineQualifiedName,
  tableQualifiedName,
} from "../code-graph/schema-graph.js";

/**
 * One inbound code→schema edge, pre-resolved to its target table/column. This
 * is the shape the reconciler consumes; callers project it from persisted
 * `CodeEdge`/`CodeSymbol` rows (the classifier in #297 supplies a Prisma-backed
 * reader). `tableQualifiedName` may be schema-qualified (`public.users`) or bare
 * (`users`); `columnName` is null for table-level edges.
 */
export interface InboundSchemaEdge {
  kind: SchemaEdgeKind;
  source: SchemaSource;
  fromQualifiedName: string | null;
  tableQualifiedName: string;
  columnName: string | null;
  reconciliation: SchemaReconciliation | null;
}

/** Build the normalized join key for a table object. */
function tableKey(tableQn: string): string {
  return tableQn.toLowerCase();
}

/** Build the normalized join key for a column object. */
function columnKey(tableQn: string, column: string): string {
  return `${tableQn.toLowerCase()}\u0000${normalizeIdentifier(column)}`;
}

/** Strip a schema qualifier, returning the bare table name (normalized). */
function bareTable(tableQn: string): string {
  const i = tableQn.lastIndexOf(".");
  return (i === -1 ? tableQn : tableQn.slice(i + 1)).toLowerCase();
}

/**
 * Reconcile the introspected full schema against the inbound schema-graph edges.
 *
 * Returns one {@link ReconciledObject} per live table and column, plus a
 * synthetic phantom object for every edge that targets a table/column absent
 * from the live schema (so its evidence is preserved for `uncertain`
 * classification). Output is deterministically sorted by table then column.
 */
export function reconcileUsedSchema(
  schema: DbTableInfo[],
  edges: InboundSchemaEdge[],
): ReconciledObject[] {
  const byKey = new Map<string, ReconciledObject>();
  // Map a bare (schema-less) table name → its schema-qualified live key, so an
  // edge that omits the schema can still find the live table.
  const bareToQualified = new Map<string, string>();

  // 1. Seed every live table + column object from the full introspected schema.
  for (const t of schema) {
    const tableQn = tableQualifiedName(t.schema, t.name);
    const tKey = tableKey(tableQn);
    byKey.set(tKey, {
      kind: "table",
      tableName: tableQn,
      columnName: null,
      columnType: null,
      existsInSchema: true,
      evidence: [],
    });
    const bare = bareTable(tableQn);
    if (!bareToQualified.has(bare)) bareToQualified.set(bare, tableQn);

    for (const c of t.columns) {
      const colQn = columnQualifiedName(t.schema, t.name, c.name);
      void colQn; // identity is (tableQn, column); colQn kept for clarity/debug.
      byKey.set(columnKey(tableQn, c.name), {
        kind: "column",
        tableName: tableQn,
        columnName: normalizeIdentifier(c.name),
        columnType: c.dataType,
        existsInSchema: true,
        evidence: [],
      });
    }
  }

  // 2. Attach each inbound edge as evidence to its target object, resolving the
  //    edge's (possibly schema-less / differently-cased) table name to a live
  //    object. When the target is absent, create a phantom object so the edge's
  //    reconciliation evidence is not lost.
  for (const edge of edges) {
    const ev: UsageEvidence = {
      edgeKind: edge.kind,
      source: edge.source,
      fromQualifiedName: edge.fromQualifiedName,
      reconciliation: edge.reconciliation,
    };

    const rawQn = edge.tableQualifiedName;
    // Resolve to a live qualified name: exact match, else bare-name fallback.
    let resolvedQn = rawQn;
    if (!byKey.has(tableKey(rawQn))) {
      const fallback = bareToQualified.get(bareTable(rawQn));
      if (fallback) resolvedQn = fallback;
    }

    if (edge.columnName) {
      const cKey = columnKey(resolvedQn, edge.columnName);
      let obj = byKey.get(cKey);
      if (!obj) {
        // Phantom column — the edge references a column the live schema lacks.
        obj = {
          kind: "column",
          tableName: resolvedQn,
          columnName: normalizeIdentifier(edge.columnName),
          columnType: null,
          existsInSchema: false,
          evidence: [],
        };
        byKey.set(cKey, obj);
      }
      obj.evidence.push(ev);
    } else {
      const tKey = tableKey(resolvedQn);
      let obj = byKey.get(tKey);
      if (!obj) {
        // Phantom table — the edge references a table the live schema lacks.
        obj = {
          kind: "table",
          tableName: resolvedQn,
          columnName: null,
          columnType: null,
          existsInSchema: false,
          evidence: [],
        };
        byKey.set(tKey, obj);
      }
      obj.evidence.push(ev);
    }
  }

  // 3. Deterministic ordering: table, then table-before-its-columns, then column.
  return [...byKey.values()].sort((a, b) => {
    if (a.tableName !== b.tableName) return a.tableName.localeCompare(b.tableName);
    if (a.kind !== b.kind) return a.kind === "table" ? -1 : 1;
    return (a.columnName ?? "").localeCompare(b.columnName ?? "");
  });
}

/**
 * One inbound code→routine edge (`executes`), pre-resolved to its target routine
 * — Epic #293 Phase 2 (#302). The classifier projects these from persisted
 * `executes` `CodeEdge`/`CodeSymbol` rows whose target symbol kind is
 * `procedure`/`function`.
 */
export interface InboundRoutineEdge {
  kind: SchemaEdgeKind;
  source: SchemaSource;
  fromQualifiedName: string | null;
  /** Schema-qualified routine identity (`<schema>.<name>` or bare `<name>`). */
  routineQualifiedName: string;
  routineKind: SchemaRoutineKind;
  reconciliation: SchemaReconciliation | null;
}

/** Join key for a routine object (kind-qualified so a proc/func can't collide). */
function routineKey(kind: SchemaRoutineKind, routineQn: string): string {
  return `${kind} ${routineQn.toLowerCase()}`;
}

/**
 * Reconcile the introspected routines (procedures & functions) against inbound
 * `executes` edges — Epic #293 Phase 2 (#302). Mirrors {@link reconcileUsedSchema}
 * for the routine dimension:
 *   - one {@link ReconciledObject} (`kind: procedure|function`) per live routine,
 *   - inbound `executes` edges attached as evidence,
 *   - a synthetic phantom for an edge targeting a routine absent from the live
 *     introspection (so its evidence is preserved for `uncertain` classification).
 *
 * The routine's qualified identity is stored in `tableName` (with `columnName`
 * null), reusing the {@link ReconciledObject} shape so the same kind-agnostic
 * {@link classifyObject} classifies routines and tables/columns alike.
 *
 * Phase 3 seam (#294): body-derived `calls` edges (routine → table/column) are
 * NOT consumed here — they are not produced in Phase 2. When Phase 3 adds them,
 * an object reached only via a routine `calls` edge can be folded into the
 * table/column reconciler's evidence the same way.
 */
export function reconcileUsedRoutines(
  routines: DbRoutineInfo[],
  edges: InboundRoutineEdge[],
): ReconciledObject[] {
  const byKey = new Map<string, ReconciledObject>();
  const bareToQualified = new Map<string, string>();

  for (const r of routines) {
    const qn = routineQualifiedName(r.schema, r.name);
    byKey.set(routineKey(r.type, qn), {
      kind: r.type,
      tableName: qn,
      columnName: null,
      columnType: null,
      existsInSchema: true,
      evidence: [],
    });
    const bare = bareTable(qn);
    if (!bareToQualified.has(`${r.type} ${bare}`)) {
      bareToQualified.set(`${r.type} ${bare}`, qn);
    }
  }

  for (const edge of edges) {
    const ev: UsageEvidence = {
      edgeKind: edge.kind,
      source: edge.source,
      fromQualifiedName: edge.fromQualifiedName,
      reconciliation: edge.reconciliation,
    };
    const rawQn = edge.routineQualifiedName;
    let resolvedQn = rawQn;
    if (!byKey.has(routineKey(edge.routineKind, rawQn))) {
      const fallback = bareToQualified.get(`${edge.routineKind} ${bareTable(rawQn)}`);
      if (fallback) resolvedQn = fallback;
    }
    const key = routineKey(edge.routineKind, resolvedQn);
    let obj = byKey.get(key);
    if (!obj) {
      obj = {
        kind: edge.routineKind,
        tableName: resolvedQn,
        columnName: null,
        columnType: null,
        existsInSchema: false,
        evidence: [],
      };
      byKey.set(key, obj);
    }
    obj.evidence.push(ev);
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.tableName.localeCompare(b.tableName);
  });
}
