/**
 * Cross-project shared-table CONSUMER resolution for impact analysis — Epic
 * #954 (#956).
 *
 * When N applications share one physical database, an impact run against project
 * A must report "these OTHER applications also read/write the affected tables".
 * This module resolves that consumer set per affected table using TWO graceful
 * tiers, and an identity resolver the engine threads into {@link crossToSchema}
 * so persisted affected rows carry their canonical cross-project identity FK.
 *
 *   Tier 1 — IDENTITY (high confidence). Reuses {@link enumerateSchemaConsumers}
 *   (#822): when the analyzed project's DB connection is linked to a shared
 *   {@link DatabaseResource} AND the object exists in the canonical identity
 *   registry (#955 populates it), the consumer set is AUTHORITATIVE. An empty
 *   list is a verified "no other project uses this table".
 *
 *   Tier 2 — STRING-MATCH (lower confidence). When identity is absent, match
 *   sibling projects by bare `SchemaUsageClassification.tableName` within the
 *   analyzed project's workspace. Two projects may name unrelated physical
 *   tables identically, so this is a heuristic — always LABELLED lower-confidence
 *   by the persisted `consumerResolution = "string-match"`.
 *
 *   could-not-verify. When identity is absent AND string-match finds NO positive
 *   evidence, the result is `unverifiable` — cross-project impact is UNKNOWN,
 *   rendered as "could not verify" and NEVER as "no consumers" (preserving
 *   #822's semantics). Zero-consumers (identity/string-match with an empty list)
 *   and could-not-verify are DISTINCT states.
 *
 * A project with NO workspace produces NO consumer rows at all — a single-project
 * run renders exactly as before this feature.
 *
 * SAFETY: read-only against METIS's OWN Prisma tables. NEVER touches a customer
 * database and produces no DDL. Deterministic + stable-sorted.
 */
import { createChildLogger } from "../logger.js";
import type { ImpactConsumerResolution, ImpactConsumerUsage, UsageObjectKind } from "@metis/shared";
import {
  enumerateSchemaConsumers,
  accessFromEvidence,
  mergeAccess,
  type ConsumersPrisma,
} from "../analysis/affected-schema-consumers.js";
import { resolveProjectDatabaseIdentities } from "../cross-project/analysis-database-identity.js";
import type { AffectedTableInput, CrossProjectIdentityResolver } from "./schema-impact.js";

const log = createChildLogger("impact-consumers");

/** One sibling project that reads/writes an affected shared table. */
export interface ResolvedTableConsumer {
  projectId: string;
  projectName: string;
  usage: ImpactConsumerUsage;
  objectQualifiedName: string;
}

/** The resolved cross-project consumer set for ONE physical affected table. */
export interface AffectedTableConsumers {
  /** Physical (schema-qualified) table name as the analyzed project references it. */
  tableName: string;
  /** How the set was resolved — see {@link ImpactConsumerResolution}. */
  resolution: ImpactConsumerResolution;
  /** Sibling consumers (analyzed project excluded), stable-sorted. Empty ⇒ none. */
  consumers: ResolvedTableConsumer[];
}

/** Stable identity key for a canonical object within a resource set. */
function identityKey(schemaName: string | null, objectName: string, objectType: string): string {
  return `${schemaName ?? ""}\u0000${objectName}\u0000${objectType}`;
}

/** Split a schema-qualified name (`schema.table` or bare `table`) into parts. */
function splitQualified(qn: string): { schemaName: string | null; objectName: string } {
  const i = qn.indexOf(".");
  if (i === -1) return { schemaName: null, objectName: qn };
  return { schemaName: qn.slice(0, i), objectName: qn.slice(i + 1) };
}

/**
 * Build the {@link CrossProjectIdentityResolver} the impact engine threads into
 * {@link crossToSchema} (#956, scope item 1). It resolves each affected object to
 * its canonical {@link SchemaObjectIdentity} id within the analyzed project's OWN
 * linked resources, so persisted `ImpactAffectedTable.schemaObjectIdentityId` is
 * populated whenever a shared {@link DatabaseResource} is known.
 *
 * Returns `null` when the project has no linked resource (no identity context) so
 * the engine passes `null` and behaviour is byte-identical to before. Preloads
 * the resource's identities ONCE into a Map, so the per-row resolver is O(1) and
 * issues no per-object query. Read-only.
 */
export async function buildImpactIdentityResolver(
  projectId: string,
  prisma: ConsumersPrisma,
): Promise<CrossProjectIdentityResolver | null> {
  const identities = await resolveProjectDatabaseIdentities(projectId, prisma);
  const linkedResourceIds = [
    ...new Set(
      identities.map((i) => i.databaseResourceId).filter((id): id is string => id != null),
    ),
  ];
  if (linkedResourceIds.length === 0) return null;

  const rows = (await prisma.schemaObjectIdentity.findMany({
    where: { databaseResourceId: { in: linkedResourceIds } },
    select: { id: true, schemaName: true, objectName: true, objectType: true },
  })) as { id: string; schemaName: string | null; objectName: string; objectType: string }[];
  if (rows.length === 0) return null;

  const idByKey = new Map<string, string>();
  for (const r of rows) idByKey.set(identityKey(r.schemaName, r.objectName, r.objectType), r.id);

  return async (object: {
    objectKind: UsageObjectKind;
    tableName: string;
    columnName: string | null;
  }) => {
    // Identity is table-level: a column's identity is its parent table's.
    const objectType: UsageObjectKind =
      object.objectKind === "column" ? "table" : object.objectKind;
    const { schemaName, objectName } = splitQualified(object.tableName);
    return idByKey.get(identityKey(schemaName, objectName, objectType)) ?? null;
  };
}

/** Input to {@link resolveAffectedTableConsumers}. */
export interface ResolveConsumersInput {
  /** The analyzed project whose requirement change produced `affected`. */
  projectId: string;
  /** Affected objects from {@link crossToSchema}. */
  affected: AffectedTableInput[];
}

/**
 * String-match tier (#956, scope item 1.2): sibling projects in `workspaceId`
 * (excluding the analyzed project) whose `SchemaUsageClassification.tableName`
 * equals one of `tableNames`, with read/write attribution from the stored
 * evidence. Returns a map keyed by the qualified table name. Lower confidence:
 * the match is on the bare physical name, not a verified shared identity.
 */
async function stringMatchConsumers(
  db: ConsumersPrisma,
  projectId: string,
  workspaceId: string,
  tableNames: string[],
): Promise<Map<string, ResolvedTableConsumer[]>> {
  const out = new Map<string, ResolvedTableConsumer[]>();
  if (tableNames.length === 0) return out;

  const siblings = await db.project.findMany({
    where: { workspaceId, id: { not: projectId }, deletedAt: null },
    select: { id: true, name: true },
  });
  if (siblings.length === 0) return out;
  const nameById = new Map(siblings.map((p) => [p.id, p.name]));

  const rows = (await db.schemaUsageClassification.findMany({
    where: { projectId: { in: siblings.map((s) => s.id) }, tableName: { in: tableNames } },
    select: { projectId: true, tableName: true, evidence: true },
  })) as { projectId: string; tableName: string; evidence: string }[];

  // A project may have both a table-level and column-level row for one object —
  // collapse to ONE consumer per (project, table), merging read/write.
  const accessByKey = new Map<string, ImpactConsumerUsage | null>();
  for (const r of rows) {
    const key = `${r.projectId}\u0000${r.tableName}`;
    accessByKey.set(key, mergeAccess(accessByKey.get(key) ?? null, accessFromEvidence(r.evidence)));
  }

  for (const [key, usage] of accessByKey) {
    if (usage == null) continue; // neither read nor written → not a consumer
    const sep = key.indexOf("\u0000");
    const pid = key.slice(0, sep);
    const tableName = key.slice(sep + 1);
    const list = out.get(tableName) ?? [];
    list.push({
      projectId: pid,
      projectName: nameById.get(pid) ?? pid,
      usage,
      objectQualifiedName: tableName,
    });
    out.set(tableName, list);
  }
  for (const list of out.values()) list.sort(byNameThenId);
  return out;
}

/** Stable consumer order: project name, then project id (names can collide). */
function byNameThenId(a: ResolvedTableConsumer, b: ResolvedTableConsumer): number {
  return a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId);
}

/**
 * Resolve the cross-project consumer set for each affected PHYSICAL table using
 * the identity → string-match → could-not-verify cascade (#956). Read-only,
 * deterministic, stable-sorted. Returns `[]` (nothing computed) when the analyzed
 * project has no workspace — a single-project run is unchanged.
 *
 * Column and routine affected rows are collapsed to their physical table: a
 * column's blast radius IS its table's consumers; routines carry no table
 * identity here, so only `table`/`column` objects are resolved.
 */
export async function resolveAffectedTableConsumers(
  input: ResolveConsumersInput,
  prisma: ConsumersPrisma,
): Promise<AffectedTableConsumers[]> {
  const { projectId, affected } = input;

  // Distinct physical tables among the affected relational objects, in a stable
  // order. Routines (procedure/function) are not shared-table consumers here.
  const tableNames = [
    ...new Set(
      affected
        .filter((a) => a.objectKind === "table" || a.objectKind === "column")
        .map((a) => a.tableName),
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (tableNames.length === 0) return [];

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  const workspaceId = project?.workspaceId ?? null;
  // No workspace ⇒ no cross-project context. Compute nothing so the run renders
  // exactly as before (never a spurious "could not verify" on single-project).
  if (!workspaceId) return [];

  // Tier 1 — identity. enumerateSchemaConsumers (#822) resolves per (tableName,
  // columnName); aggregate to per physical table.
  interface IdentityAgg {
    resolved: boolean;
    consumers: ResolvedTableConsumer[];
  }
  const identityByTable = new Map<string, IdentityAgg>();
  try {
    const rows = await enumerateSchemaConsumers({ projectId, affected }, prisma);
    for (const r of rows) {
      const agg = identityByTable.get(r.tableName) ?? { resolved: false, consumers: [] };
      agg.resolved = agg.resolved || r.identityResolved;
      for (const c of r.consumers) {
        agg.consumers.push({
          projectId: c.projectId,
          projectName: c.projectName,
          usage: c.usage,
          objectQualifiedName: c.objectQualifiedName,
        });
      }
      identityByTable.set(r.tableName, agg);
    }
  } catch (err) {
    // A consumer-enumeration fault must never sink the impact result.
    log.warn("identity consumer enumeration failed; falling back to string-match", {
      projectId,
      error: String(err),
    });
  }

  // Tier 2 — string-match, only for tables the identity tier did not resolve.
  const unresolved = tableNames.filter((t) => !(identityByTable.get(t)?.resolved ?? false));
  let stringMatch = new Map<string, ResolvedTableConsumer[]>();
  if (unresolved.length > 0) {
    try {
      stringMatch = await stringMatchConsumers(prisma, projectId, workspaceId, unresolved);
    } catch (err) {
      log.warn("string-match consumer enumeration failed; marking unverifiable", {
        projectId,
        error: String(err),
      });
    }
  }

  const result: AffectedTableConsumers[] = [];
  for (const tableName of tableNames) {
    const identity = identityByTable.get(tableName);
    if (identity?.resolved) {
      result.push({
        tableName,
        resolution: "identity",
        consumers: dedupeConsumers(identity.consumers),
      });
      continue;
    }
    const matched = stringMatch.get(tableName) ?? [];
    if (matched.length > 0) {
      result.push({ tableName, resolution: "string-match", consumers: dedupeConsumers(matched) });
    } else {
      // Identity absent AND no positive string-match evidence ⇒ UNKNOWN, never
      // a claimed "no consumers".
      result.push({ tableName, resolution: "unverifiable", consumers: [] });
    }
  }
  return result;
}

/** Collapse duplicate consumers (same project) — a write wins — and stable-sort. */
function dedupeConsumers(consumers: ResolvedTableConsumer[]): ResolvedTableConsumer[] {
  const byProject = new Map<string, ResolvedTableConsumer>();
  for (const c of consumers) {
    const existing = byProject.get(c.projectId);
    if (!existing) {
      byProject.set(c.projectId, { ...c });
    } else {
      existing.usage = mergeAccess(existing.usage, c.usage) ?? existing.usage;
    }
  }
  return [...byProject.values()].sort(byNameThenId);
}
