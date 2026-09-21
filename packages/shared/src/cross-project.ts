/**
 * Cross-project impact — Epic #295 Phase 4 (#307/#308/#309/#310).
 *
 * Shared types + pure helpers for the workspace-scoped DatabaseResource registry,
 * canonical SchemaObjectIdentity, and the cross-project usage/impact queries.
 *
 * The data model that backs these lives in `server/prisma/schema.prisma`
 * (`database_resources`, `schema_object_identities`, plus the nullable FKs on
 * `database_connections` + `impact_affected_tables`). These types are the API
 * boundary consumed by the UI (#310). No `Json` columns — everything is plain
 * scalars, matching the sqlite/postgres twin portability contract.
 */
import type { UsageClass, UsageObjectKind } from "./schema-impact.js";

// ---- Dedupe key (the canonical cross-project identity primitive) ------------

/**
 * The minimum physical-DB identity used to dedupe a {@link DatabaseResource}
 * across projects of a workspace. The same physical database connected from two
 * projects produces the SAME key and therefore ONE resource.
 */
export interface DatabaseResourceKeyParts {
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
}

/**
 * Whether a connection carries the MINIMUM identity to be deduped into a shared
 * resource: a non-null host AND databaseName. Connections below this bar (e.g. a
 * file-based sqlite DB with no host) are intentionally NOT collapsed — two
 * different connections both missing a host must stay distinct, never merged by
 * accident (the unique index treats NULLs as distinct anyway). This is the
 * runtime source of truth that the migration backfill SQL mirrors.
 */
export function hasResourceIdentity(parts: DatabaseResourceKeyParts): boolean {
  return (
    parts.host != null &&
    parts.host.length > 0 &&
    parts.databaseName != null &&
    parts.databaseName.length > 0
  );
}

/**
 * Deterministic dedupe key for a physical DB within a workspace. Normalizes a
 * NULL/absent port to an empty bucket so a connection that omits the port maps
 * to the same resource as one that omits it too (but NOT one with an explicit
 * port — those are genuinely different endpoints). Driver/host/db are matched
 * case-sensitively, matching how they are stored.
 *
 * Returns `null` when the parts lack the minimum identity (see
 * {@link hasResourceIdentity}) — callers must treat a null key as "do not link".
 *
 * The string shape (`dbres:<ws>:<driver>:<host>:<port>:<db>`) is identical to
 * the id the migration backfill builds, so a runtime find-or-create and the
 * historical backfill converge on the same resource id.
 */
export function databaseResourceKey(
  workspaceId: string,
  parts: DatabaseResourceKeyParts,
): string | null {
  if (!hasResourceIdentity(parts)) return null;
  const port = parts.port == null ? "" : String(parts.port);
  // NOTE: the `:` delimiter is intentionally NOT escaped here. This string is a
  // best-effort, deterministic id used to converge runtime find-or-create with
  // the migration backfill — it is NOT the uniqueness guarantee. The DB unique
  // index on `(workspaceId, driver, host, port, databaseName)` is the true
  // source of truth and rejects genuine collisions; a host/db that happens to
  // contain a `:` can at worst collide its *generated id* with another (rare,
  // and the index still keeps the underlying rows distinct). If this key is ever
  // promoted to a correctness boundary, escape the components first.
  return `dbres:${workspaceId}:${parts.driver}:${parts.host}:${port}:${parts.databaseName}`;
}

// ---- API views -------------------------------------------------------------

/** API view of a {@link DatabaseResource} (workspace-scoped physical DB). */
export interface DatabaseResourceView {
  id: string;
  workspaceId: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  /** Number of project-scoped connections linked to this resource. */
  connectionCount: number;
  createdAt: string;
}

/** API view of a canonical {@link SchemaObjectIdentity}. */
export interface SchemaObjectIdentityView {
  id: string;
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: UsageObjectKind;
  /** Rollup usage across the linked projects, or null when not yet computed. */
  usageClass: UsageClass | null;
}

/**
 * One project that references a canonical object — Epic #295 Phase 4 (#309).
 * `usageClass` is that project's own classification for the object;
 * `evidenceCount` is the number of inbound code references cited.
 */
export interface ProjectObjectUsage {
  projectId: string;
  projectName: string;
  usageClass: UsageClass;
  /** Count of inbound code-edge evidence rows in this project. */
  evidenceCount: number;
}

/**
 * Result of "which projects use object X" — Epic #295 Phase 4 (#309). Lists the
 * projects (within the caller's authorized workspace) whose code references the
 * canonical object, each with its per-project usage class + evidence count.
 */
export interface CrossProjectObjectUsage {
  identity: SchemaObjectIdentityView;
  /** Projects that reference the object, highest-evidence first. */
  projects: ProjectObjectUsage[];
  /** Rollup across projects: `used` if any project uses it, else uncertain/unreferenced. */
  rollupUsageClass: UsageClass;
}

/** A single affected canonical object within the cross-project impact result. */
export interface CrossProjectAffectedObject {
  objectName: string;
  schemaName: string | null;
  objectType: UsageObjectKind;
  /** Projects (other than the source) in the same workspace that use this object. */
  alsoUsedByProjects: ProjectObjectUsage[];
}

/**
 * Aggregated cross-project impact — Epic #295 Phase 4 (#309). A requirement
 * change in `sourceProjectId` surfaces affected canonical objects AND the OTHER
 * projects in the same workspace that also use those objects. Read-only,
 * text-only: NEVER any executable DDL.
 */
export interface CrossProjectImpactResult {
  sourceProjectId: string;
  workspaceId: string;
  affectedObjects: CrossProjectAffectedObject[];
}

/**
 * Roll a set of per-project usage classes up into a single class for a canonical
 * object — Epic #295 Phase 4 (#308). `used` wins if ANY project uses it;
 * otherwise `uncertain` beats `unreferenced` (never claim an object is safe when
 * a single project could not classify it). Empty input → `unreferenced`.
 */
export function rollupUsageClass(classes: readonly UsageClass[]): UsageClass {
  if (classes.some((c) => c === "used")) return "used";
  if (classes.some((c) => c === "uncertain")) return "uncertain";
  return "unreferenced";
}
