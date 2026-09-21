/**
 * Canonical SchemaObjectIdentity service — Epic #295 Phase 4 (#308).
 *
 * A {@link SchemaObjectIdentity} is the cross-project identity of a schema object
 * (table/column/procedure/function) within a shared {@link DatabaseResource}. The
 * SAME object seen from multiple projects reconciles to ONE identity, which is
 * what lets impact reason across projects (#309).
 *
 * Responsibilities:
 *   1. find-or-create an identity per (resource, schemaName, objectName,
 *      objectType) — idempotent, dedupes across projects (`reconcileIdentity`).
 *   2. roll up `usageClass` across the projects linked to the resource
 *      (`rollupUsageClass` from @metis/shared): used if ANY project uses it.
 *   3. lineage-adjacency traversal via a recursive CTE that is valid on BOTH
 *      sqlite (`WITH RECURSIVE`) and postgres — see {@link buildLineageCteSql}.
 *      The PURE traversal core ({@link traverseLineage}) is fully unit-tested
 *      against an injected adjacency map (no DB); the raw SQL is a thin adapter.
 *
 * Safety: read-only. NEVER executes DDL. Identity reconciliation only writes the
 * `schema_object_identities` registry + the nullable FK on affected rows.
 */
import type { PrismaClient } from "@prisma/client";
import { rollupUsageClass, type UsageClass, type UsageObjectKind } from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("schema-object-identity");

/** Minimal Prisma surface for identity reconciliation + rollup. */
export type IdentityPrisma = Pick<
  PrismaClient,
  "schemaObjectIdentity" | "schemaUsageClassification" | "impactAffectedTable"
>;

/**
 * Prisma surface for reconciling a WHOLE project's schema graph into canonical
 * identities: the identity/rollup surface PLUS the project's connections (to
 * resolve the linked {@link DatabaseResource}) and its `table`/routine
 * {@link CodeSymbol} rows (the objects to reconcile).
 */
export type ReconcileProjectPrisma = IdentityPrisma &
  Pick<PrismaClient, "databaseConnection" | "codeSymbol">;

function resolvePrisma(prisma?: IdentityPrisma): IdentityPrisma {
  return prisma ?? (defaultPrisma as unknown as IdentityPrisma);
}

function resolveProjectPrisma(prisma?: ReconcileProjectPrisma): ReconcileProjectPrisma {
  return prisma ?? (defaultPrisma as unknown as ReconcileProjectPrisma);
}

/** The canonical key parts that identify an object within a resource. */
export interface SchemaObjectKey {
  schemaName: string | null;
  objectName: string;
  objectType: UsageObjectKind;
}

/** Normalize a key so a missing schema is a single bucket (null, not ""). */
function normalizeKey(key: SchemaObjectKey): SchemaObjectKey {
  return {
    schemaName: key.schemaName && key.schemaName.length > 0 ? key.schemaName : null,
    objectName: key.objectName,
    objectType: key.objectType,
  };
}

/**
 * Find-or-create the canonical identity for an object within a resource.
 * Idempotent: the SAME object reconciled from two projects returns the SAME
 * identity id (deduped by the compound unique). A create that loses the unique
 * race is retried as a find. Returns the identity id.
 */
export async function reconcileIdentity(
  databaseResourceId: string,
  rawKey: SchemaObjectKey,
  prisma?: IdentityPrisma,
): Promise<string> {
  const db = resolvePrisma(prisma);
  const key = normalizeKey(rawKey);
  // findFirst with a plain equality filter: the compound unique includes the
  // NULLABLE schemaName, which Prisma's generated unique `where` cannot match as
  // NULL (same limitation as schema-usage-override.ts). The DB unique index
  // remains the backstop against duplicate identities.
  const where = {
    databaseResourceId,
    schemaName: key.schemaName,
    objectName: key.objectName,
    objectType: key.objectType,
  };
  const existing = await db.schemaObjectIdentity.findFirst({ where, select: { id: true } });
  if (existing) return existing.id;
  try {
    const created = await db.schemaObjectIdentity.create({
      data: {
        databaseResourceId,
        schemaName: key.schemaName,
        objectName: key.objectName,
        objectType: key.objectType,
      },
      select: { id: true },
    });
    return created.id;
  } catch {
    const retried = await db.schemaObjectIdentity.findFirst({ where, select: { id: true } });
    if (retried) return retried.id;
    throw new Error("failed to reconcile schema object identity");
  }
}

/**
 * Recompute the `usageClass` rollup for an identity across the per-project
 * {@link SchemaUsageClassification} rows for the SAME object in any of the given
 * projects (the projects linked to the identity's resource). `used` wins if any
 * project uses it; else uncertain beats unreferenced. Persists + returns the
 * rolled-up class (null when no project has classified the object yet).
 *
 * Read-only against classification rows; only the identity's rollup field is
 * written. NEVER any DDL.
 */
export async function rollupIdentityUsage(
  identityId: string,
  key: SchemaObjectKey,
  projectIds: string[],
  prisma?: IdentityPrisma,
): Promise<UsageClass | null> {
  const db = resolvePrisma(prisma);
  const norm = normalizeKey(key);
  if (projectIds.length === 0) return null;
  // Match the per-project classification rows for this object. Column-level
  // objects carry a non-null columnName; the canonical objectName is the
  // table (for table/routine) or the column identity differs per Phase-2 shape.
  const rows = (await db.schemaUsageClassification.findMany({
    where: {
      projectId: { in: projectIds },
      tableName: norm.schemaName ? `${norm.schemaName}.${norm.objectName}` : norm.objectName,
    },
    select: { usageClass: true },
  })) as { usageClass: string }[];
  if (rows.length === 0) return null;
  const classes = rows.map((r) => r.usageClass as UsageClass);
  const rolled = rollupUsageClass(classes);
  await db.schemaObjectIdentity.update({
    where: { id: identityId },
    data: { usageClass: rolled },
  });
  return rolled;
}

/**
 * Associate an `ImpactAffectedTable` row with a canonical identity. ADDITIVE:
 * only the nullable FK is set; the affected row is otherwise untouched. Used by
 * the impact pipeline when a resource is known for the item's project.
 */
export async function linkAffectedTableToIdentity(
  affectedTableId: string,
  identityId: string,
  prisma?: IdentityPrisma,
): Promise<void> {
  const db = resolvePrisma(prisma);
  await db.impactAffectedTable.update({
    where: { id: affectedTableId },
    data: { schemaObjectIdentityId: identityId },
  });
}

/**
 * The schema-graph {@link CodeSymbol} kinds that carry a cross-project identity.
 * `column` is deliberately EXCLUDED: cross-project identity + usage is tracked at
 * TABLE granularity (see affected-schema-consumers.ts `lookupFor`), so a column's
 * blast radius IS its parent table's. Routines keep their own object type.
 */
const SCHEMA_OBJECT_SYMBOL_KINDS = ["table", "procedure", "function"] as const;

/**
 * Synthetic dynamic-placeholder prefix (mirrors schema-graph.ts
 * `DYNAMIC_PLACEHOLDER_PREFIX`). Duplicated locally to avoid importing the whole
 * schema-graph module (and its tree-sitter deps) into the cross-project layer.
 */
const DYNAMIC_PLACEHOLDER_PREFIX_GUARD = "?dynamic:";

/** Map a schema-graph symbol `kind` to the identity {@link UsageObjectKind}. */
function symbolKindToObjectType(kind: string): UsageObjectKind | null {
  if (kind === "table") return "table";
  if (kind === "procedure") return "procedure";
  if (kind === "function") return "function";
  return null;
}

/**
 * Split a schema-qualified symbol name (`schema.object` or bare `object`) into
 * its parts — the inverse of {@link tableQualifiedName}. Splits on the FIRST dot
 * so a bare object with no schema keeps a null schema (matching the reconcile key
 * normalization and the cross-project lookup split used everywhere else).
 */
function splitQualifiedName(qn: string): { schemaName: string | null; objectName: string } {
  const i = qn.indexOf(".");
  if (i === -1) return { schemaName: null, objectName: qn };
  return { schemaName: qn.slice(0, i), objectName: qn.slice(i + 1) };
}

/** Outcome of a whole-project reconciliation pass. */
export interface ReconcileProjectResult {
  /** The single linked resource identities were reconciled under, or null. */
  databaseResourceId: string | null;
  /** How many canonical identities were reconciled (find-or-created + rolled up). */
  identitiesReconciled: number;
  /**
   * Why NO reconciliation happened (absent on success). `no-linked-resource`: the
   * project has no connection linked to a DatabaseResource yet.
   * `ambiguous-resources`: the project's connections span >1 distinct resource, so
   * a table symbol cannot be safely attributed to one physical DB (never guess).
   */
  skippedReason?: "no-linked-resource" | "ambiguous-resources";
}

/**
 * Reconcile a project's ENTIRE schema graph into canonical
 * {@link SchemaObjectIdentity} rows — the production write path (#955) that was
 * missing, leaving the whole identity service dead (zero callers) and every
 * identity-gated cross-project query permanently unresolved.
 *
 * For a project whose connections resolve to exactly ONE shared
 * {@link DatabaseResource}, this find-or-creates an identity per `table`/routine
 * symbol in the project's schema graph and rolls up its cross-project usage. The
 * SAME physical object reconciled from a sibling project dedupes onto the SAME
 * identity (that is what lets impact reason across projects), and re-runs are
 * idempotent (the compound unique is the backstop).
 *
 * CONSERVATIVE + read-only against the customer DB (touches only METIS's own
 * Prisma tables, never DDL):
 *   - a project with NO linked resource is skipped (`no-linked-resource`);
 *   - a project whose connections span MORE THAN ONE distinct resource is skipped
 *     (`ambiguous-resources`) — a table symbol cannot be attributed to one DB;
 *   - synthetic dynamic-placeholder symbols (`?dynamic:…`) are never reconciled.
 *
 * Wired at the natural write points: after schema ingest/introspection
 * (ingestCodeGraph) and when a connection is linked/re-resolved to a resource
 * (analysis-database-identity.ts). Returns a summary for logging/observability.
 */
export async function reconcileProjectSchemaIdentities(
  projectId: string,
  prisma?: ReconcileProjectPrisma,
): Promise<ReconcileProjectResult> {
  const db = resolveProjectPrisma(prisma);

  // 1. The distinct DatabaseResource(s) this project's live connections link to.
  const linkedConnections = await db.databaseConnection.findMany({
    where: { projectId, deletedAt: null, databaseResourceId: { not: null } },
    select: { databaseResourceId: true },
  });
  const resourceIds = [
    ...new Set(
      linkedConnections.map((c) => c.databaseResourceId).filter((id): id is string => id != null),
    ),
  ];
  if (resourceIds.length === 0) {
    return {
      databaseResourceId: null,
      identitiesReconciled: 0,
      skippedReason: "no-linked-resource",
    };
  }
  if (resourceIds.length > 1) {
    // Ambiguous: a table symbol cannot be attributed to one physical DB — never
    // collapse two distinct resources by guessing.
    return {
      databaseResourceId: null,
      identitiesReconciled: 0,
      skippedReason: "ambiguous-resources",
    };
  }
  const databaseResourceId = resourceIds[0];

  // 2. Every project sharing this resource — the rollup population for usage
  //    evidence (a table used by ANY sharing project is "used" on the identity).
  const sharingConnections = await db.databaseConnection.findMany({
    where: { databaseResourceId, deletedAt: null },
    select: { projectId: true },
  });
  const projectIds = [...new Set(sharingConnections.map((c) => c.projectId))];

  // 3. The project's schema-object symbols (tables + routines; columns excluded).
  const symbols = (await db.codeSymbol.findMany({
    where: { projectId, kind: { in: [...SCHEMA_OBJECT_SYMBOL_KINDS] } },
    select: { kind: true, qualifiedName: true },
  })) as { kind: string; qualifiedName: string }[];

  // De-dupe by canonical key so multiple symbol rows for one object (e.g. seeded
  // + freshly ensured) reconcile once.
  const seen = new Set<string>();
  let identitiesReconciled = 0;
  for (const sym of symbols) {
    const objectType = symbolKindToObjectType(sym.kind);
    if (!objectType) continue;
    if (!sym.qualifiedName || sym.qualifiedName.startsWith(DYNAMIC_PLACEHOLDER_PREFIX_GUARD))
      continue;
    const { schemaName, objectName } = splitQualifiedName(sym.qualifiedName);
    if (!objectName) continue;
    const dedupeKey = `${schemaName ?? ""}\u0000${objectName}\u0000${objectType}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const key: SchemaObjectKey = { schemaName, objectName, objectType };
    const identityId = await reconcileIdentity(databaseResourceId, key, db);
    // Roll up cross-project usage evidence (best-effort: returns null when no
    // project has classified the object yet — additive, never blocks reconcile).
    await rollupIdentityUsage(identityId, key, projectIds, db);
    identitiesReconciled += 1;
  }

  log.debug("reconciled project schema identities", {
    projectId,
    databaseResourceId,
    identitiesReconciled,
  });
  return { databaseResourceId, identitiesReconciled };
}

// ---- Lineage adjacency traversal (recursive CTE) ---------------------------

/** One directed lineage edge (adjacency) — `from` depends-on / touches `to`. */
export interface LineageEdge {
  fromSymbolId: string;
  toSymbolId: string;
}

/**
 * PURE, cycle-safe, depth-bounded forward traversal over a lineage adjacency
 * map. Returns the set of symbol ids reachable from `seedIds` (excluding the
 * seeds themselves), mirroring the semantics of the recursive CTE. Unit-tested
 * exhaustively so the traversal logic never depends on a live DB.
 *
 * `maxDepth` guards against pathological/cyclic graphs (default 32 — deep enough
 * for any real lineage chain, bounded enough to never run away).
 */
export function traverseLineage(seedIds: string[], edges: LineageEdge[], maxDepth = 32): string[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.fromSymbolId);
    if (list) list.push(e.toSymbolId);
    else adjacency.set(e.fromSymbolId, [e.toSymbolId]);
  }
  const visited = new Set<string>(seedIds);
  const reached = new Set<string>();
  let frontier = [...new Set(seedIds)];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of adjacency.get(id) ?? []) {
        if (!visited.has(to)) {
          visited.add(to);
          reached.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return [...reached];
}

/**
 * The SQL engine the bound query will run against. `$queryRawUnsafe` binds
 * positional parameters using engine-native placeholder syntax: sqlite (and
 * mysql) use `?`, postgres uses `$1`, `$2`, … . The CTE body itself is ANSI on
 * both engines — only the placeholder style differs.
 */
export type LineageSqlEngine = "sqlite" | "postgres";

/**
 * Detect the lineage SQL engine from `DATABASE_URL`. The runtime uses the
 * better-sqlite3 adapter today, so we default to sqlite; a `postgres(ql)://`
 * (or `prisma+postgres://`) URL switches to `$n` placeholders. Pure + exported
 * so the placeholder choice is unit-testable without a live connection.
 */
export function detectLineageSqlEngine(
  databaseUrl = process.env.DATABASE_URL ?? "",
): LineageSqlEngine {
  return /^(prisma\+)?postgres(ql)?:\/\//i.test(databaseUrl) ? "postgres" : "sqlite";
}

/** Positional placeholder for parameter index `i` (0-based) on `engine`. */
function placeholderAt(engine: LineageSqlEngine, i: number): string {
  return engine === "postgres" ? `$${i + 1}` : "?";
}

/**
 * Build the recursive-CTE SQL that traverses the `code_edges` lineage adjacency
 * for a project from a set of seed symbol ids. The CTE body is valid on BOTH
 * sqlite (`WITH RECURSIVE`) and postgres: only ANSI features + a depth guard (no
 * dialect-specific functions). The seed ids and edge kinds are bound as
 * POSITIONAL parameters by the caller (NEVER interpolated). Because sqlite binds
 * with `?` and postgres binds with `$1`,`$2`,…, the placeholder style is chosen
 * per `engine` — seeds occupy positions 1..seedCount, kinds the next kindCount.
 *
 * Exposed (and unit-tested for shape per engine) so the raw-SQL adapter stays
 * auditable; the deterministic traversal core is {@link traverseLineage}.
 */
export function buildLineageCteSql(
  seedCount: number,
  kindCount: number,
  engine: LineageSqlEngine = "sqlite",
): string {
  let pos = 0;
  const seedPlaceholders = Array.from({ length: seedCount }, () =>
    placeholderAt(engine, pos++),
  ).join(", ");
  const kindPlaceholders = Array.from({ length: kindCount }, () =>
    placeholderAt(engine, pos++),
  ).join(", ");
  // Depth column bounds the recursion identically on both engines.
  return `WITH RECURSIVE reachable(symbol_id, depth) AS (
  SELECT "fromSymbolId" AS symbol_id, 0 AS depth
  FROM "code_edges"
  WHERE "fromSymbolId" IN (${seedPlaceholders})
  UNION
  SELECT e."toSymbolId", r.depth + 1
  FROM "code_edges" e
  JOIN reachable r ON e."fromSymbolId" = r.symbol_id
  WHERE e."toSymbolId" IS NOT NULL
    AND e."kind" IN (${kindPlaceholders})
    AND r.depth < 32
)
SELECT DISTINCT symbol_id FROM reachable WHERE symbol_id IS NOT NULL`;
}

/**
 * Prisma-backed lineage traversal: run the recursive CTE against `code_edges`
 * for a project. Read-only. Returns the reachable symbol ids. The SQL is built
 * by {@link buildLineageCteSql} for the active engine (so postgres gets `$n` and
 * sqlite gets `?` placeholders) and all values are bound (no interpolation). The
 * engine is overridable for tests; otherwise it is detected from `DATABASE_URL`.
 */
export async function traverseLineageDb(
  prismaRaw: Pick<PrismaClient, "$queryRawUnsafe">,
  seedIds: string[],
  edgeKinds: string[],
  engine: LineageSqlEngine = detectLineageSqlEngine(),
): Promise<string[]> {
  if (seedIds.length === 0) return [];
  const sql = buildLineageCteSql(seedIds.length, edgeKinds.length, engine);
  const rows = (await prismaRaw.$queryRawUnsafe(sql, ...seedIds, ...edgeKinds)) as {
    symbol_id: string;
  }[];
  return rows.map((r) => r.symbol_id);
}
