/**
 * Cross-project usage + impact queries — Epic #295 Phase 4 (#309).
 *
 * Two read-only queries built on the canonical {@link SchemaObjectIdentity}
 * (#308) and the per-project usage classifications (#292):
 *
 *   1. {@link whichProjectsUseObject} — "which projects use object X": given a
 *      canonical object within an authorized workspace, return the projects
 *      whose code references it, each with its usage class + evidence count.
 *   2. {@link crossProjectImpact} — a requirement change in project A surfaces
 *      affected canonical objects AND the OTHER projects in the SAME workspace
 *      that use those objects, aggregated per project.
 *
 * AUTHZ (hard requirement): EVERY read enforces workspace membership AND project
 * access. The caller only ever sees resources/objects/projects within workspaces
 * they belong to (see cross-project-access.ts — non-members get 404, never a
 * leak). Project results are intersected with the caller's accessible-project
 * set even within a shared workspace.
 *
 * SAFETY: read-only, text-only. NEVER executes DDL. The engine stays
 * graph/BM25 — no LLM/RAG.
 */
import type { PrismaClient } from "@prisma/client";
import {
  rollupUsageClass,
  type CrossProjectAffectedObject,
  type CrossProjectImpactResult,
  type CrossProjectObjectUsage,
  type ProjectObjectUsage,
  type SchemaObjectIdentityView,
  type UsageClass,
  type UsageObjectKind,
} from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  assertWorkspaceAccessible,
  listAccessibleProjectsInWorkspace,
  type AccessPrisma,
} from "./cross-project-access.js";
import type { SchedulerActor } from "../scheduler/project-access.js";

/** Prisma surface for the cross-project queries (read-only). */
export type CrossImpactPrisma = AccessPrisma &
  Pick<
    PrismaClient,
    "schemaObjectIdentity" | "schemaUsageClassification" | "project" | "databaseResource"
  >;

function resolvePrisma(prisma?: CrossImpactPrisma): CrossImpactPrisma {
  return prisma ?? (defaultPrisma as unknown as CrossImpactPrisma);
}

/** The qualified table identity a per-project classification keys on. */
function qualifiedName(schemaName: string | null, objectName: string): string {
  return schemaName ? `${schemaName}.${objectName}` : objectName;
}

function toIdentityView(row: {
  id: string;
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: string;
  usageClass: string | null;
}): SchemaObjectIdentityView {
  return {
    id: row.id,
    databaseResourceId: row.databaseResourceId,
    schemaName: row.schemaName,
    objectName: row.objectName,
    objectType: row.objectType as UsageObjectKind,
    usageClass: (row.usageClass as UsageClass | null) ?? null,
  };
}

/**
 * Resolve the projects (within the actor's authorized set) that reference the
 * object identified by `tableName` and their per-project usage. SHARED helper
 * used by both queries. `accessibleProjectIds` MUST already be intersected with
 * the actor's access — callers pass the result of
 * {@link listAccessibleProjectsInWorkspace}. Projects with no classification row
 * for the object are omitted (they don't "use" it).
 */
async function projectsUsingObject(
  db: CrossImpactPrisma,
  accessibleProjectIds: string[],
  tableName: string,
): Promise<ProjectObjectUsage[]> {
  if (accessibleProjectIds.length === 0) return [];
  const [rows, projects] = await Promise.all([
    db.schemaUsageClassification.findMany({
      where: { projectId: { in: accessibleProjectIds }, tableName },
      select: { projectId: true, usageClass: true, evidence: true },
    }) as Promise<{ projectId: string; usageClass: string; evidence: string }[]>,
    db.project.findMany({
      where: { id: { in: accessibleProjectIds } },
      select: { id: true, name: true },
    }),
  ]);
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  return rows
    .map((r) => ({
      projectId: r.projectId,
      projectName: nameById.get(r.projectId) ?? r.projectId,
      usageClass: r.usageClass as UsageClass,
      evidenceCount: evidenceCountOf(r.evidence),
    }))
    .sort(byEvidenceThenId);
}

/** Parse a stored evidence JSON blob into a defensive count (0 on malformed). */
function evidenceCountOf(evidence: string): number {
  try {
    const parsed = JSON.parse(evidence) as unknown[];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Highest-evidence first, then stable by projectId. */
function byEvidenceThenId(a: ProjectObjectUsage, b: ProjectObjectUsage): number {
  return b.evidenceCount - a.evidenceCount || a.projectId.localeCompare(b.projectId);
}

/**
 * Batched variant of {@link projectsUsingObject} — resolve sibling usage for
 * MANY canonical objects in ONE classifications query + ONE project-name query
 * (instead of two queries per object). Returns a map keyed by `tableName`;
 * objects no sibling references are simply absent from the map. Used by
 * {@link crossProjectImpact} to avoid an N+1 across the source's affected
 * objects. The per-object ordering matches the single-object query exactly.
 */
async function projectsUsingObjectsBatch(
  db: CrossImpactPrisma,
  accessibleProjectIds: string[],
  tableNames: string[],
): Promise<Map<string, ProjectObjectUsage[]>> {
  const out = new Map<string, ProjectObjectUsage[]>();
  if (accessibleProjectIds.length === 0 || tableNames.length === 0) return out;
  const [rows, projects] = await Promise.all([
    db.schemaUsageClassification.findMany({
      where: { projectId: { in: accessibleProjectIds }, tableName: { in: tableNames } },
      select: { projectId: true, tableName: true, usageClass: true, evidence: true },
    }) as Promise<{ projectId: string; tableName: string; usageClass: string; evidence: string }[]>,
    db.project.findMany({
      where: { id: { in: accessibleProjectIds } },
      select: { id: true, name: true },
    }),
  ]);
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  for (const r of rows) {
    const list = out.get(r.tableName) ?? [];
    list.push({
      projectId: r.projectId,
      projectName: nameById.get(r.projectId) ?? r.projectId,
      usageClass: r.usageClass as UsageClass,
      evidenceCount: evidenceCountOf(r.evidence),
    });
    out.set(r.tableName, list);
  }
  for (const list of out.values()) list.sort(byEvidenceThenId);
  return out;
}

export interface ObjectLookup {
  schemaName?: string | null;
  objectName: string;
  objectType?: UsageObjectKind;
}

/**
 * "Which projects use object X" — Epic #295 Phase 4 (#309).
 *
 * Resolves the canonical identity within `workspaceId` (the caller MUST be a
 * member — otherwise 404, no leak), then lists the projects (within the caller's
 * accessible set) that reference it, with per-project usage class + evidence
 * count and a cross-project rollup. Throws 404 when the object has no identity in
 * the workspace's resources (existence is not leaked across workspaces).
 */
export async function whichProjectsUseObject(
  actor: SchedulerActor,
  workspaceId: string,
  lookup: ObjectLookup,
  prisma?: CrossImpactPrisma,
): Promise<CrossProjectObjectUsage> {
  const db = resolvePrisma(prisma);
  // AUTHZ: membership + the accessible-project intersection inside the workspace.
  const accessibleProjectIds = await listAccessibleProjectsInWorkspace(actor, workspaceId, db);

  const schemaName = lookup.schemaName && lookup.schemaName.length > 0 ? lookup.schemaName : null;
  const objectType = lookup.objectType ?? "table";

  // The identity must belong to a resource IN this workspace. Scoping the lookup
  // through the workspace's resources is what blocks cross-workspace reads.
  const resources = await db.databaseResource.findMany({
    where: { workspaceId },
    select: { id: true },
  });
  const resourceIds = resources.map((r) => r.id);
  const identityRow =
    resourceIds.length === 0
      ? null
      : await db.schemaObjectIdentity.findFirst({
          where: {
            databaseResourceId: { in: resourceIds },
            schemaName,
            objectName: lookup.objectName,
            objectType,
          },
        });
  if (!identityRow) {
    throw new AppError(404, "NOT_FOUND", "Object identity not found in this workspace");
  }

  const projects = await projectsUsingObject(
    db,
    accessibleProjectIds,
    qualifiedName(schemaName, lookup.objectName),
  );
  return {
    identity: toIdentityView(identityRow),
    projects,
    rollupUsageClass: rollupUsageClass(projects.map((p) => p.usageClass)),
  };
}

/**
 * Cross-project impact — Epic #295 Phase 4 (#309). For a requirement change in
 * `sourceProjectId`, surface the affected canonical objects AND the OTHER
 * projects in the SAME workspace that also use those objects.
 *
 * The "affected objects" are the source project's classified objects (the impact
 * pipeline's per-project output). For each, we find the sibling projects (within
 * the caller's accessible set, excluding the source) that use the same canonical
 * object. AUTHZ: the caller must access the source project AND be a member of its
 * workspace; sibling projects are intersected with the accessible set.
 *
 * Returns an empty result (no affected objects) when the source project has no
 * workspace — cross-project impact is meaningless without a shared resource.
 */
export async function crossProjectImpact(
  actor: SchedulerActor,
  sourceProjectId: string,
  prisma?: CrossImpactPrisma,
): Promise<CrossProjectImpactResult> {
  const db = resolvePrisma(prisma);

  const source = await db.project.findUnique({
    where: { id: sourceProjectId },
    select: { workspaceId: true },
  });
  // Unknown project, or project with no workspace → 404 (no leak) / empty.
  if (!source) throw new AppError(404, "NOT_FOUND", "Project not found");
  if (!source.workspaceId) {
    // No workspace: nothing to aggregate across. Still assert the caller can see
    // the project so we never confirm existence of an inaccessible one.
    await assertSourceAccessible(db, actor, sourceProjectId);
    return { sourceProjectId, workspaceId: "", affectedObjects: [] };
  }
  const workspaceId = source.workspaceId;

  // AUTHZ: membership + accessible projects inside the workspace.
  const accessibleProjectIds = await listAccessibleProjectsInWorkspace(actor, workspaceId, db);
  if (!accessibleProjectIds.includes(sourceProjectId)) {
    // The caller belongs to the workspace but cannot access the source project.
    throw new AppError(404, "NOT_FOUND", "Project not found");
  }
  const siblingIds = accessibleProjectIds.filter((id) => id !== sourceProjectId);

  // The source project's classified objects = the impact surface.
  const sourceObjects = (await db.schemaUsageClassification.findMany({
    where: { projectId: sourceProjectId },
    select: { kind: true, tableName: true, columnName: true },
  })) as { kind: string; tableName: string; columnName: string | null }[];

  // De-dupe the source's affected table names (a table + its columns share one
  // `tableName`) so the batched sibling lookup queries each object once.
  const tableNames = [...new Set(sourceObjects.map((o) => o.tableName))];
  // Single batched lookup of sibling usage for ALL affected objects (was N+1: a
  // classifications query AND a project-name query PER affected object).
  const usageByTable = await projectsUsingObjectsBatch(db, siblingIds, tableNames);

  const affectedObjects: CrossProjectAffectedObject[] = [];
  for (const obj of sourceObjects) {
    const alsoUsedByProjects = usageByTable.get(obj.tableName) ?? [];
    if (alsoUsedByProjects.length === 0) continue; // only surface shared objects
    const { schemaName, objectName } = splitQualified(obj.tableName);
    affectedObjects.push({
      objectName,
      schemaName,
      objectType: obj.kind as UsageObjectKind,
      alsoUsedByProjects,
    });
  }
  affectedObjects.sort(
    (a, b) =>
      (a.schemaName ?? "").localeCompare(b.schemaName ?? "") ||
      a.objectName.localeCompare(b.objectName),
  );

  return { sourceProjectId, workspaceId, affectedObjects };
}

/** Split a `schema.table` (or bare `table`) into its parts. */
function splitQualified(qn: string): { schemaName: string | null; objectName: string } {
  const i = qn.indexOf(".");
  if (i === -1) return { schemaName: null, objectName: qn };
  return { schemaName: qn.slice(0, i), objectName: qn.slice(i + 1) };
}

/**
 * Assert the actor can access a project with no workspace (pre-migration / not
 * yet assigned). Mirrors the ownership-based project access used elsewhere;
 * admins always pass. Non-access → 404 (no leak).
 */
async function assertSourceAccessible(
  db: CrossImpactPrisma,
  actor: SchedulerActor,
  projectId: string,
): Promise<void> {
  if (actor.role === "admin") return;
  const owned = await db.project.findFirst({
    where: { id: projectId, createdById: actor.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) throw new AppError(404, "NOT_FOUND", "Project not found");
}

export { assertWorkspaceAccessible };
