/**
 * Used/unreferenced/uncertain classifier + persistence — Epic #292 (#297).
 *
 * Consumes the #296 reconciler's {@link ReconciledObject}s and derives a
 * {@link UsageClass} per object, then persists the classification per project so
 * the impact UI (#298) and schema docs (#299) can query it.
 *
 * Classification rules (see {@link UsageClass}):
 *   - `used`         — at least one inbound code edge that resolves cleanly
 *                      (no `table-not-found`/`column-not-found`, and the object
 *                      exists in the live schema OR the edge reconciled
 *                      `matched`).
 *   - `unreferenced` — present in the live introspection with NO inbound edge.
 *                      A *candidate for human review* (`safeToReview = true`) —
 *                      METIS NEVER auto-recommends dropping it.
 *   - `uncertain`    — a `table-not-found`/`column-not-found` reconciliation, or
 *                      a statically-unresolved/dynamic reference. ALWAYS carries
 *                      a {@link UsageUncertainReason} and is NEVER safe-to-drop /
 *                      safe-to-review.
 *
 * Security / safety: this module performs NO DDL and NO live queries. It only
 * reads the already-derived graph and writes classification rows scoped to a
 * single `projectId` (tenant isolation enforced by the caller's authz + the
 * project-scoped delete/insert here). The manual-override seam
 * (`overriddenClass`) is reserved for Phase 3 (#304) and always persisted null.
 */
import type {
  ClassifiedObject,
  ReconciledObject,
  SchemaUsageClassificationView,
  UsageClass,
  UsageEvidence,
  UsageObjectKind,
  UsageUncertainReason,
} from "@metis/shared";

/**
 * Minimal Prisma surface for persisting/reading classifications (injectable for
 * tests). The method args/returns are intentionally loose (`args: any`) so BOTH
 * the generated `PrismaClient` delegate (whose `findMany`/`createMany` carry a
 * very specific generated arg type) and lightweight test doubles satisfy these
 * structural interfaces. Concrete arg/row shapes are enforced at the call sites
 * and in the {@link PersistRow}/{@link PersistedRow} types below.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface UsageClassificationDelegate {
  deleteMany(args: any): Promise<{ count: number }>;
  createMany(args: any): Promise<{ count: number }>;
  findMany(args: any): Promise<any[]>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface PersistTxn {
  schemaUsageClassification: Pick<UsageClassificationDelegate, "deleteMany" | "createMany">;
}

interface PersistPrisma {
  $transaction<T>(fn: (tx: PersistTxn) => Promise<T>): Promise<T>;
}

interface ReadPrisma {
  schemaUsageClassification: Pick<UsageClassificationDelegate, "findMany">;
}

/** Row shape written to `schema_usage_classifications`. */
interface PersistRow {
  projectId: string;
  kind: UsageObjectKind;
  tableName: string;
  columnName: string | null;
  columnType: string | null;
  usageClass: UsageClass;
  uncertainReason: UsageUncertainReason | null;
  /** JSON-serialized {@link UsageEvidence}[]. */
  evidence: string;
  overriddenClass: UsageClass | null;
}

/** Row shape read back from the table. */
interface PersistedRow extends PersistRow {
  id: string;
  computedAt: Date;
}

function isNotFound(reconciliation: string | null): boolean {
  return reconciliation === "table-not-found" || reconciliation === "column-not-found";
}

/**
 * Derive the {@link UsageClass} (+ reason + review flag) for a single
 * reconciled object. Pure and deterministic.
 */
export function classifyObject(o: ReconciledObject): ClassifiedObject {
  // 1. A clean inbound edge → used. "Clean" means the edge is not a not-found
  //    mismatch AND the target is real (exists in schema, or the edge itself
  //    reconciled `matched`). The good edge always wins over stray bad ones.
  const hasCleanEdge = o.evidence.some(
    (e) => !isNotFound(e.reconciliation) && (o.existsInSchema || e.reconciliation === "matched"),
  );
  if (hasCleanEdge) {
    return { ...o, usageClass: "used", uncertainReason: null, safeToReview: false };
  }

  // 2. No edges at all on a live object → unreferenced (review candidate only).
  if (o.evidence.length === 0) {
    if (o.existsInSchema) {
      return { ...o, usageClass: "unreferenced", uncertainReason: null, safeToReview: true };
    }
    // A phantom object with no evidence shouldn't occur, but treat defensively
    // as uncertain rather than recommending anything.
    return {
      ...o,
      usageClass: "uncertain",
      uncertainReason: "dynamic-reference",
      safeToReview: false,
    };
  }

  // 3. Remaining objects carry only not-found / unresolved edges → uncertain.
  //    Prefer the most specific reason: column-not-found > table-not-found >
  //    dynamic-reference. Never safe-to-review.
  let reason: UsageUncertainReason = "dynamic-reference";
  for (const e of o.evidence) {
    if (e.reconciliation === "table-not-found" && reason === "dynamic-reference") {
      reason = "table-not-found";
    }
    if (e.reconciliation === "column-not-found") {
      reason = "column-not-found";
    }
  }
  return { ...o, usageClass: "uncertain", uncertainReason: reason, safeToReview: false };
}

/** Classify a batch of reconciled objects, preserving input order. */
export function classifyReconciledObjects(objects: ReconciledObject[]): ClassifiedObject[] {
  return objects.map(classifyObject);
}

/**
 * Persist the classification for one project: replace any prior rows and bulk
 * insert the new set inside a single transaction (idempotent re-classification).
 * Returns the number of rows written. Tenant isolation: both the delete and the
 * insert are scoped to `projectId`.
 */
export async function persistUsageClassification(
  prisma: PersistPrisma,
  projectId: string,
  classified: ClassifiedObject[],
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.schemaUsageClassification.deleteMany({ where: { projectId } });
    if (classified.length === 0) return 0;
    const data: PersistRow[] = classified.map((c) => ({
      projectId,
      kind: c.kind,
      tableName: c.tableName,
      columnName: c.columnName,
      columnType: c.columnType,
      usageClass: c.usageClass,
      uncertainReason: c.uncertainReason,
      evidence: JSON.stringify(c.evidence),
      // Manual-override seam — Phase 3 (#304). Always null on (re)classification.
      overriddenClass: null,
    }));
    const res = await tx.schemaUsageClassification.createMany({ data });
    return res.count;
  });
}

function parseEvidence(raw: string): UsageEvidence[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UsageEvidence[]) : [];
  } catch {
    return [];
  }
}

/**
 * Read the persisted classification for one project as API views, scoped to the
 * project (callers must already have asserted the actor can access it). Evidence
 * JSON is parsed defensively — a corrupt blob yields an empty evidence list
 * rather than throwing.
 */
export async function readUsageClassification(
  prisma: ReadPrisma,
  projectId: string,
): Promise<SchemaUsageClassificationView[]> {
  const rows = (await prisma.schemaUsageClassification.findMany({
    where: { projectId },
    orderBy: [{ tableName: "asc" }, { kind: "asc" }, { columnName: "asc" }],
  })) as PersistedRow[];
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    tableName: r.tableName,
    columnName: r.columnName,
    columnType: r.columnType,
    usageClass: r.usageClass,
    uncertainReason: r.uncertainReason,
    evidence: parseEvidence(r.evidence),
    overriddenClass: r.overriddenClass,
    computedAt: r.computedAt.toISOString(),
  }));
}
