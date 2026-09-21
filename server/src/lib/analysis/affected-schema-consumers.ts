/**
 * Affected-schema cross-project consumer enumeration — Epic #820 Phase 1 (#822).
 *
 * Given the affected tables/columns a requirement change produces (the
 * {@link AffectedTableInput}[] from {@link crossToSchema}), enumerate — per
 * affected object — every OTHER project in the analyzed project's workspace that
 * READS or WRITES that object on the same shared physical database. This is the
 * "shared-database blast radius" the epic reports per requirement.
 *
 * This module invents NO new enumeration logic. It composes three existing
 * primitives:
 *   1. {@link resolveProjectDatabaseIdentities} (1a / #821) — the analyzed
 *      project's workspace + the {@link DatabaseResource}(s) its connections are
 *      linked to. Identity is gated on the analyzed project's OWN linkage: an
 *      UNLINKED connection yields `identityResolved: false` even when a sibling
 *      created a resource for the same physical DB (we cannot assert the mapping
 *      the operator never confirmed — see #821's conservative auto-link key).
 *   2. {@link whichProjectsUseObject} (#309) — the workspace-scoped set of
 *      projects that reference a canonical object. Consumer enumeration is NOT
 *      reimplemented here.
 *   3. The per-project usage {@link UsageEvidence} — read to attribute each
 *      consumer as `readBy` vs `writtenBy` (the one dimension #309 rolls away).
 *
 * AUTHZ / TENANCY: the workspace is DERIVED from the analyzed project, never
 * taken as input, so every query is confined to that one workspace — there is no
 * cross-workspace read and no existence oracle. Within that workspace the FULL
 * blast radius is intended (a change may affect sibling projects the requesting
 * user does not own), so the composed {@link whichProjectsUseObject} call runs
 * as a system actor scoped to the derived workspace; the caller-facing route
 * (1e / #825, 2a / #827) is what gates the user's access to the analyzed project.
 *
 * SAFETY: read-only against METIS's OWN Prisma tables. NEVER touches a customer
 * database; produces no DDL.
 */
import type { PrismaClient } from "@prisma/client";
import type { DdlChangeKind, RoleKey, SchemaEdgeKind, UsageObjectKind } from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import type { AffectedTableInput } from "../impact-analysis/schema-impact.js";
import { resolveProjectDatabaseIdentities } from "../cross-project/analysis-database-identity.js";
import {
  whichProjectsUseObject,
  type CrossImpactPrisma,
} from "../cross-project/cross-project-impact.js";
import type { SchedulerActor } from "../scheduler/project-access.js";

/** Prisma surface: the cross-impact reads PLUS the connection read (#821). */
export type ConsumersPrisma = CrossImpactPrisma & Pick<PrismaClient, "databaseConnection">;

function resolvePrisma(prisma?: ConsumersPrisma): ConsumersPrisma {
  return prisma ?? (defaultPrisma as unknown as ConsumersPrisma);
}

/**
 * System actor for the composed {@link whichProjectsUseObject} call. The blast
 * radius must include EVERY sibling project in the derived workspace — not only
 * those the requesting user owns — or the report would silently under-state the
 * impact. The workspace is derived from the analyzed project (the tenant
 * boundary), so this never crosses a workspace.
 */
const SYSTEM_ACTOR: SchedulerActor = { id: "system:analysis-consumers", role: "admin" as RoleKey };

/** Schema-edge kinds that mutate the object (vs `reads`). */
const WRITE_EDGE_KINDS: ReadonlySet<SchemaEdgeKind> = new Set<SchemaEdgeKind>([
  "writes",
  "persists-to",
]);

/** How a sibling project touches the shared object. */
export type ConsumerUsage = "readBy" | "writtenBy";

/** One sibling project that reads or writes an affected object. */
export interface SchemaConsumer {
  projectId: string;
  projectName: string;
  usage: ConsumerUsage;
  /** Schema-qualified identity of the object as this consumer references it. */
  objectQualifiedName: string;
}

/** Cross-project consumers of ONE affected table/column. */
export interface AffectedSchemaConsumers {
  tableName: string;
  columnName: string | null;
  /**
   * Raw DDL change kind carried through from the affected row — the hook point
   * breaking-change classification (3b / #831) consumes alongside the consumers.
   */
  changeKind: DdlChangeKind;
  /**
   * False when the object's cross-project identity could not be resolved (no
   * workspace, insufficient identity, or an unlinked connection). A false value
   * MUST render downstream as "cross-project impact unknown" (`could-not-verify`)
   * — NEVER as "no consumers".
   */
  identityResolved: boolean;
  /** Sibling consumers (analyzed project excluded), stable-sorted. */
  consumers: SchemaConsumer[];
}

/** Input to {@link enumerateSchemaConsumers}. */
export interface EnumerateSchemaConsumersInput {
  /** The analyzed project whose requirement change produced `affected`. */
  projectId: string;
  /** Affected objects from {@link crossToSchema} (may be unlinked to identities). */
  affected: AffectedTableInput[];
}

/** Split a schema-qualified name (`schema.table` or bare `table`) into parts. */
function splitQualified(qn: string): { schemaName: string | null; objectName: string } {
  const i = qn.indexOf(".");
  if (i === -1) return { schemaName: null, objectName: qn };
  return { schemaName: qn.slice(0, i), objectName: qn.slice(i + 1) };
}

/**
 * The canonical-object lookup for an affected row. Consumer usage is stored at
 * TABLE granularity (`SchemaUsageClassification.tableName`), which is also what
 * {@link whichProjectsUseObject} matches — so a `column` affected object is
 * enumerated against its PARENT table (its blast radius IS the table's
 * consumers). Routines (`procedure`/`function`) keep their own object type.
 */
function lookupFor(affected: AffectedTableInput): {
  schemaName: string | null;
  objectName: string;
  objectType: UsageObjectKind;
  qualifiedName: string;
} {
  const { schemaName, objectName } = splitQualified(affected.tableName);
  const objectType: UsageObjectKind =
    affected.objectKind === "column" ? "table" : affected.objectKind;
  return { schemaName, objectName, objectType, qualifiedName: affected.tableName };
}

/** Stable identity-key for an object within the resolved resource set. */
function identityKey(schemaName: string | null, objectName: string, objectType: string): string {
  return `${schemaName ?? ""}\u0000${objectName}\u0000${objectType}`;
}

/**
 * Parse a stored `UsageEvidence[]` JSON blob into the access kind it implies:
 * `writtenBy` if ANY edge mutates the object, else `readBy` if ANY edge is
 * present, else `null` (no read/write evidence → the project does not actually
 * consume the object, e.g. an `unreferenced` classification with empty evidence).
 */
export function accessFromEvidence(evidenceJson: string): ConsumerUsage | null {
  let edges: { edgeKind?: unknown }[];
  try {
    const parsed = JSON.parse(evidenceJson) as unknown;
    edges = Array.isArray(parsed) ? (parsed as { edgeKind?: unknown }[]) : [];
  } catch {
    edges = [];
  }
  let sawRead = false;
  for (const e of edges) {
    const kind = e?.edgeKind;
    if (typeof kind !== "string") continue;
    if (WRITE_EDGE_KINDS.has(kind as SchemaEdgeKind)) return "writtenBy";
    sawRead = true;
  }
  return sawRead ? "readBy" : null;
}

/** Merge two access kinds — a write anywhere wins over a read. */
export function mergeAccess(
  a: ConsumerUsage | null,
  b: ConsumerUsage | null,
): ConsumerUsage | null {
  if (a === "writtenBy" || b === "writtenBy") return "writtenBy";
  if (a === "readBy" || b === "readBy") return "readBy";
  return null;
}

/**
 * Enumerate the cross-project (shared-database) consumers of each affected
 * table/column produced by a requirement's schema impact. Read-only.
 *
 * For every affected object it returns the object's identity-resolution status
 * and the sibling projects that read/write it, so analysis can report shared-DB
 * blast radius per requirement. Deterministic and stable-sorted (object name,
 * then — within each object — consumer project name): the same input always
 * yields the same output.
 */
export async function enumerateSchemaConsumers(
  opts: EnumerateSchemaConsumersInput,
  prisma?: ConsumersPrisma,
): Promise<AffectedSchemaConsumers[]> {
  const db = resolvePrisma(prisma);
  const { projectId } = opts;

  // De-dupe affected rows by (tableName, columnName); the highest-confidence row
  // wins so we mirror crossToSchema's own dedupe and never emit an object twice.
  const distinct = new Map<string, AffectedTableInput>();
  for (const a of opts.affected) {
    const key = `${a.tableName}\u0000${a.columnName ?? ""}`;
    const existing = distinct.get(key);
    if (!existing || a.confidence > existing.confidence) distinct.set(key, a);
  }
  const affected = [...distinct.values()];
  if (affected.length === 0) return [];

  // 1. The analyzed project's workspace + the resources its OWN connections are
  //    linked to. resolveProjectDatabaseIdentities (#821) is the sole source of
  //    truth for "is this project linked to a shared physical DB".
  const [project, identities] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } }),
    resolveProjectDatabaseIdentities(projectId, db),
  ]);
  const workspaceId = project?.workspaceId ?? null;
  const linkedResourceIds = [
    ...new Set(
      identities.map((i) => i.databaseResourceId).filter((id): id is string => id != null),
    ),
  ];

  // Without a workspace OR any linked resource, no object can have a resolved
  // cross-project identity — every object is `identityResolved: false`.
  const canResolve = workspaceId != null && linkedResourceIds.length > 0;

  // 2. Which affected objects have a canonical identity in the project's OWN
  //    linked resources? One batched lookup keyed by the resolved resource set.
  const resolvedKeys = new Set<string>();
  if (canResolve) {
    const idRows = (await db.schemaObjectIdentity.findMany({
      where: { databaseResourceId: { in: linkedResourceIds } },
      select: { schemaName: true, objectName: true, objectType: true },
    })) as { schemaName: string | null; objectName: string; objectType: string }[];
    for (const r of idRows) resolvedKeys.add(identityKey(r.schemaName, r.objectName, r.objectType));
  }

  // 3. For each resolved object, enumerate its workspace-scoped consumer
  //    candidates via whichProjectsUseObject (consumer queries reused, not
  //    reimplemented), excluding the analyzed project itself.
  interface Pending {
    result: AffectedSchemaConsumers;
    qualifiedName: string;
    /** Candidate consumer projects (analyzed project already excluded). */
    candidates: { projectId: string; projectName: string }[];
  }
  const pending: Pending[] = [];

  for (const a of affected) {
    const lk = lookupFor(a);
    const resolved =
      canResolve && resolvedKeys.has(identityKey(lk.schemaName, lk.objectName, lk.objectType));
    const result: AffectedSchemaConsumers = {
      tableName: a.tableName,
      columnName: a.columnName,
      changeKind: a.changeKind,
      identityResolved: resolved,
      consumers: [],
    };
    if (!resolved) {
      pending.push({ result, qualifiedName: lk.qualifiedName, candidates: [] });
      continue;
    }
    // workspaceId is non-null here (canResolve). The identity exists in the
    // project's resource (⊆ the workspace's resources), so this never 404s.
    const usage = await whichProjectsUseObject(
      SYSTEM_ACTOR,
      workspaceId as string,
      { schemaName: lk.schemaName, objectName: lk.objectName, objectType: lk.objectType },
      db,
    );
    // whichProjectsUseObject returns one entry PER classification row, so a
    // project with both a table-level and column-level row for the object
    // appears more than once — collapse to one candidate per project.
    const byProject = new Map<string, { projectId: string; projectName: string }>();
    for (const p of usage.projects) {
      if (p.projectId === projectId) continue; // exclude the analyzed project
      if (!byProject.has(p.projectId)) {
        byProject.set(p.projectId, { projectId: p.projectId, projectName: p.projectName });
      }
    }
    pending.push({ result, qualifiedName: lk.qualifiedName, candidates: [...byProject.values()] });
  }

  // 4. Attribute readBy/writtenBy for every candidate in ONE batched evidence
  //    read (the one dimension whichProjectsUseObject rolls away). A candidate
  //    with no read/write evidence (an `unreferenced` row) is dropped — the
  //    report is of projects that READ or WRITE the object.
  const candidateProjectIds = new Set<string>();
  const candidateTableNames = new Set<string>();
  for (const p of pending) {
    for (const c of p.candidates) candidateProjectIds.add(c.projectId);
    if (p.candidates.length > 0) candidateTableNames.add(p.qualifiedName);
  }

  const accessByProjectTable = new Map<string, ConsumerUsage | null>();
  if (candidateProjectIds.size > 0 && candidateTableNames.size > 0) {
    const rows = (await db.schemaUsageClassification.findMany({
      where: {
        projectId: { in: [...candidateProjectIds] },
        tableName: { in: [...candidateTableNames] },
      },
      select: { projectId: true, tableName: true, evidence: true },
    })) as { projectId: string; tableName: string; evidence: string }[];
    for (const r of rows) {
      const key = `${r.projectId}\u0000${r.tableName}`;
      const prev = accessByProjectTable.get(key) ?? null;
      accessByProjectTable.set(key, mergeAccess(prev, accessFromEvidence(r.evidence)));
    }
  }

  // 5. Build + stable-sort the consumer lists (project name, then project id as a
  //    deterministic tiebreak since names can collide).
  for (const p of pending) {
    const consumers: SchemaConsumer[] = [];
    for (const c of p.candidates) {
      const usage = accessByProjectTable.get(`${c.projectId}\u0000${p.qualifiedName}`) ?? null;
      if (usage == null) continue; // neither read nor written → not a consumer
      consumers.push({
        projectId: c.projectId,
        projectName: c.projectName,
        usage,
        objectQualifiedName: p.qualifiedName,
      });
    }
    consumers.sort(
      (x, y) =>
        x.projectName.localeCompare(y.projectName) || x.projectId.localeCompare(y.projectId),
    );
    p.result.consumers = consumers;
  }

  // Deterministic outer order: object name (tableName, then columnName).
  return pending
    .map((p) => p.result)
    .sort(
      (x, y) =>
        x.tableName.localeCompare(y.tableName) ||
        (x.columnName ?? "").localeCompare(y.columnName ?? ""),
    );
}
