/**
 * Used-schema orchestration service — Epic #292 (#297).
 *
 * Wires the pure pieces together for one project:
 *   1. introspect the full schema (`driver.introspect()` via the connector),
 *   2. read the existing inbound code→schema edges (NOT re-derived) from the
 *      persisted graph,
 *   3. reconcile full-schema ⨝ edges (#296),
 *   4. classify each object used/unreferenced/uncertain (#297),
 *   5. persist the classification, scoped to the project.
 *
 * Reconciliation (`table-not-found`/`column-not-found`) is computed here against
 * the introspected schema using {@link LiveSchemaIndex} — the same ground-truth
 * index the impact engine uses (#173) — so an edge pointing at a column the live
 * schema lacks is correctly flagged `uncertain` rather than `used`.
 *
 * Security: no DDL is ever executed; introspection is the read-only connector
 * path. All reads/writes are scoped to `projectId`; the caller is responsible
 * for asserting the actor may access that project (see the route in #298).
 */
import type { PrismaClient } from "@prisma/client";
import type {
  ClassifiedObject,
  DbRoutineInfo,
  DbTableInfo,
  SchemaEdgeKind,
  SchemaReconciliation,
  SchemaRoutineKind,
  SchemaSource,
} from "@metis/shared";
import { SCHEMA_OBJECT_EDGE_KINDS, SCHEMA_ROUTINE_EDGE_KINDS } from "@metis/shared";
import { LiveSchemaIndex } from "./live-schema-ingest.js";
import {
  reconcileUsedSchema,
  reconcileUsedRoutines,
  type InboundRoutineEdge,
  type InboundSchemaEdge,
} from "./used-schema-reconciler.js";
import { classifyReconciledObjects, persistUsageClassification } from "./used-schema-classifier.js";

/** Maximum IDs per `IN (...)` clause (mirrors schema-impact's SQLite cap). */
const IN_CHUNK_SIZE = 500;

async function chunkedIn<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    out.push(...(await fn(ids.slice(i, i + IN_CHUNK_SIZE))));
  }
  return out;
}

/** Split a column qualified name (`<tableQn>.<column>`) into its parts. */
function splitColumnQn(qn: string, columnName: string): { tableQn: string; column: string } {
  const suffix = `.${columnName}`;
  const tableQn = qn.endsWith(suffix) ? qn.slice(0, -suffix.length) : qn;
  return { tableQn: tableQn || qn, column: columnName };
}

type EdgeReaderPrisma = Pick<PrismaClient, "codeEdge" | "codeSymbol">;

/**
 * Read the inbound code→schema edges for a project, projecting persisted
 * `CodeEdge`/`CodeSymbol` rows into the {@link InboundSchemaEdge} shape. The
 * existing edges are reused verbatim — never re-derived. Scoped to `projectId`.
 */
export async function readInboundSchemaEdges(
  prisma: EdgeReaderPrisma,
  projectId: string,
): Promise<InboundSchemaEdge[]> {
  const edgeRows = await prisma.codeEdge.findMany({
    where: {
      projectId,
      kind: { in: [...SCHEMA_OBJECT_EDGE_KINDS] },
      toSymbolId: { not: null },
    },
    select: { fromSymbolId: true, toSymbolId: true, kind: true, source: true },
  });
  if (edgeRows.length === 0) return [];

  const symbolIds = [
    ...new Set(
      edgeRows
        .flatMap((e) => [e.toSymbolId, e.fromSymbolId])
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const symbolRows = await chunkedIn(symbolIds, (chunk) =>
    prisma.codeSymbol.findMany({
      where: { id: { in: chunk }, projectId },
      select: { id: true, kind: true, name: true, qualifiedName: true, source: true },
    }),
  );
  const byId = new Map(symbolRows.map((s) => [s.id, s]));

  const edges: InboundSchemaEdge[] = [];
  for (const e of edgeRows) {
    const target = e.toSymbolId ? byId.get(e.toSymbolId) : undefined;
    if (!target || (target.kind !== "table" && target.kind !== "column")) continue;
    const from = byId.get(e.fromSymbolId);

    let tableQn: string;
    let columnName: string | null;
    if (target.kind === "column") {
      const { tableQn: t, column } = splitColumnQn(target.qualifiedName, target.name);
      tableQn = t;
      columnName = column;
    } else {
      tableQn = target.qualifiedName;
      columnName = null;
    }

    edges.push({
      kind: e.kind as SchemaEdgeKind,
      source:
        (target.source as SchemaSource | null) ?? (e.source as SchemaSource | null) ?? "mybatis",
      fromQualifiedName: from?.qualifiedName ?? null,
      tableQualifiedName: tableQn,
      columnName,
      // Reconciliation is computed by the service against the live schema below.
      reconciliation: null,
    });
  }
  return edges;
}

/**
 * Read the inbound `executes` edges (code → routine) for a project, projecting
 * persisted rows into the {@link InboundRoutineEdge} shape — Epic #293 Phase 2
 * (#302). A routine is `used` when at least one code symbol executes it. Only
 * edges whose target symbol kind is `procedure`/`function` are returned; scoped
 * to `projectId`. The `calls` edge kind (routine → object) is Phase 3 (#294) and
 * is deliberately NOT consumed here.
 */
export async function readInboundRoutineEdges(
  prisma: EdgeReaderPrisma,
  projectId: string,
): Promise<InboundRoutineEdge[]> {
  const edgeRows = await prisma.codeEdge.findMany({
    where: {
      projectId,
      kind: { in: [...SCHEMA_ROUTINE_EDGE_KINDS] },
      toSymbolId: { not: null },
    },
    select: { fromSymbolId: true, toSymbolId: true, kind: true, source: true },
  });
  if (edgeRows.length === 0) return [];

  const symbolIds = [
    ...new Set(
      edgeRows
        .flatMap((e) => [e.toSymbolId, e.fromSymbolId])
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const symbolRows = await chunkedIn(symbolIds, (chunk) =>
    prisma.codeSymbol.findMany({
      where: { id: { in: chunk }, projectId },
      select: { id: true, kind: true, name: true, qualifiedName: true, source: true },
    }),
  );
  const byId = new Map(symbolRows.map((s) => [s.id, s]));

  const edges: InboundRoutineEdge[] = [];
  for (const e of edgeRows) {
    const target = e.toSymbolId ? byId.get(e.toSymbolId) : undefined;
    // Only `executes` edges whose target is a routine count toward routine usage.
    // (`calls` edges originate FROM a routine — Phase 3 — and are skipped here.)
    if (!target || (target.kind !== "procedure" && target.kind !== "function")) continue;
    if (e.kind !== "executes") continue;
    const from = byId.get(e.fromSymbolId);
    edges.push({
      kind: "executes",
      source:
        (target.source as SchemaSource | null) ?? (e.source as SchemaSource | null) ?? "live-db",
      fromQualifiedName: from?.qualifiedName ?? null,
      routineQualifiedName: target.qualifiedName,
      routineKind: target.kind as SchemaRoutineKind,
      reconciliation: null,
    });
  }
  return edges;
}

/** Split a schema-qualified table name into `{ schema, table }`. */
function splitTableQn(qn: string): { schema?: string; table: string } {
  const i = qn.indexOf(".");
  return i === -1 ? { table: qn } : { schema: qn.slice(0, i), table: qn.slice(i + 1) };
}

/**
 * Annotate each inbound edge with its reconciliation against the introspected
 * schema (`matched` / `table-not-found` / `column-not-found`). This is what lets
 * the classifier flag a stale mapper reference `uncertain`.
 */
function reconcileEdges(edges: InboundSchemaEdge[], live: LiveSchemaIndex): InboundSchemaEdge[] {
  return edges.map((e) => {
    const { schema, table } = splitTableQn(e.tableQualifiedName);
    const reconciliation: SchemaReconciliation = live.reconcile({
      table,
      schema,
      column: e.columnName,
    });
    return { ...e, reconciliation };
  });
}

/** A pluggable introspection function (project → full schema). Injectable for tests. */
export type ProjectSchemaIntrospector = (projectId: string) => Promise<DbTableInfo[]>;

/**
 * A pluggable routines (procedures & functions) introspection function — Epic
 * #293 Phase 2 (#302). Injectable for tests; OPTIONAL on the compute path so a
 * caller that has no routine source (or a project on a driver without routine
 * introspection) simply classifies tables/columns as before. READ-ONLY: returns
 * routine identity + signature only — never the routine body.
 */
export type ProjectRoutinesIntrospector = (projectId: string) => Promise<DbRoutineInfo[]>;

export interface UsageClassificationResult {
  classified: ClassifiedObject[];
  persisted: number;
}

type ComputePrisma = EdgeReaderPrisma &
  Pick<PrismaClient, "$transaction"> & {
    schemaUsageClassification: PrismaClient["schemaUsageClassification"];
  };

/**
 * Compute and persist the used/unreferenced/uncertain classification for a
 * project. Pure pieces (reconciler/classifier) are composed here; the only I/O
 * is the injected introspector + the project-scoped Prisma reads/writes.
 */
export async function computeUsageClassification(
  prisma: ComputePrisma,
  projectId: string,
  introspect: ProjectSchemaIntrospector,
  routinesIntrospect?: ProjectRoutinesIntrospector,
): Promise<UsageClassificationResult> {
  const tables = await introspect(projectId);
  const live = new LiveSchemaIndex(
    tables.map((t) => ({
      schema: t.schema,
      name: t.name,
      columns: new Map(
        t.columns.map((c) => [
          c.name.toLowerCase(),
          {
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
            isPrimaryKey: c.isPrimaryKey,
          },
        ]),
      ),
    })),
  );

  const rawEdges = await readInboundSchemaEdges(prisma, projectId);
  const edges = reconcileEdges(rawEdges, live);

  const reconciled = reconcileUsedSchema(tables, edges);

  // Epic #293 Phase 2 (#302) — reconcile routines (procedures & functions) on the
  // same pipeline when a routines introspector is supplied. A routine is `used`
  // when some code `executes` it; routines present but never executed are
  // `unreferenced` (review candidate only); an `executes` edge to a routine that
  // vanished from the live introspection is `uncertain`. Routine BODIES are not
  // analyzed in Phase 2 (Phase 3 / #294), so any object reached only through a
  // routine body remains `uncertain` and is NEVER auto-recommended for drop.
  let reconciledRoutines: typeof reconciled = [];
  if (routinesIntrospect) {
    const routines = await routinesIntrospect(projectId);
    const routineEdges = await readInboundRoutineEdges(prisma, projectId);
    reconciledRoutines = reconcileUsedRoutines(routines, routineEdges);
  }

  const classified = classifyReconciledObjects([...reconciled, ...reconciledRoutines]);
  const persisted = await persistUsageClassification(prisma, projectId, classified);
  return { classified, persisted };
}
