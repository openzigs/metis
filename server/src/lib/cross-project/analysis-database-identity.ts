/**
 * Analysis-facing database identity resolution — Epic #820 Phase 1 (#821).
 *
 * Bridges the workspace-scoped {@link DatabaseResource} registry (Epic #295,
 * #307/#308) to the Requirements Analysis pipeline, and gives operators explicit
 * link/unlink control. This module adds NO new identity table — it reuses the
 * existing registry and its find-or-create key logic
 * (`database-resource-service.ts` + `@metis/shared` `hasResourceIdentity`).
 *
 * Two capabilities:
 *   1. {@link resolveProjectDatabaseIdentities} — read-only view a project's
 *      connections, their linked resource (or null), whether they carry the
 *      minimum identity to be linkable, and the SIBLING projects in the same
 *      workspace that share each linked resource. Consumed by 1b (#822) /
 *      1c (#823) and the operator UI (2b (#828)).
 *   2. Explicit operator control — {@link linkConnectionToResourceExplicit},
 *      {@link unlinkConnectionFromResource}, {@link reresolveConnectionResource}.
 *      The conservative auto-link key `(driver, host, port, databaseName)` cannot
 *      detect the same physical DB behind two different hostnames; the explicit
 *      link lets an operator assert that equivalence. Every mutation is audited.
 *
 * Authz: the caller-facing routes gate on access to the CONNECTION's project
 * (the connectors subtree runs `requireProjectAccess`), and linking is confined
 * to a resource in the SAME workspace as that project — cross-workspace linking
 * is rejected here as defence-in-depth.
 *
 * SAFETY: touches only METIS's own Prisma tables. No customer DB access, no DDL.
 */
import type { PrismaClient } from "@prisma/client";
import { hasResourceIdentity } from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { AppError } from "../../middleware/error-handler.js";
import { resolveDatabaseResourceId } from "./database-resource-service.js";
import {
  reconcileProjectSchemaIdentities,
  type ReconcileProjectPrisma,
} from "./schema-object-identity-service.js";

/** Minimal Prisma surface needed for identity resolution + link/unlink. */
export type IdentityPrisma = Pick<
  PrismaClient,
  "project" | "databaseConnection" | "databaseResource"
>;

function resolvePrisma(prisma?: IdentityPrisma): IdentityPrisma {
  return prisma ?? (defaultPrisma as unknown as IdentityPrisma);
}

/** A sibling project (same workspace) that also connects to a shared resource. */
export interface SharingProject {
  projectId: string;
  name: string;
}

/**
 * The identity resolution for ONE of a project's database connections.
 * `databaseResourceId` is null when the connection is unlinked;
 * `insufficientIdentity` is true when it lacks the minimum host+databaseName to
 * ever be auto-linked (a null-host connection is NEVER given a guessed link).
 */
export interface ProjectDatabaseIdentity {
  connectionId: string;
  databaseResourceId: string | null;
  insufficientIdentity: boolean;
  /** OTHER projects in the workspace linked to the SAME resource. */
  sharingProjects: SharingProject[];
}

/** Result of an explicit link / unlink / re-resolve mutation. */
export interface ConnectionLinkResult {
  connectionId: string;
  databaseResourceId: string | null;
  /** Whether the mutation changed the stored link (false ⇒ idempotent no-op). */
  changed: boolean;
}

interface MutationInput {
  projectId: string;
  connectionId: string;
  actorId: string | null;
}

interface LinkInput extends MutationInput {
  databaseResourceId: string;
}

/**
 * Reconcile the project's schema graph into canonical cross-project identities
 * (#955) after a connection is linked/re-resolved to a resource. This is the
 * second natural write point (besides schema ingest): an operator who links a
 * connection AFTER ingest has already run must get identities without re-ingesting.
 * Best-effort — a reconcile failure must NEVER fail the operator's link mutation
 * (mirrors the resource-link functions' own never-break contract). Idempotent, so
 * running it here AND at ingest is safe.
 */
async function reconcileAfterLink(projectId: string, db: IdentityPrisma): Promise<void> {
  try {
    await reconcileProjectSchemaIdentities(projectId, db as unknown as ReconcileProjectPrisma);
  } catch {
    // Swallow: identity reconciliation is additive and non-critical to linking.
  }
}

/**
 * Resolve the database identities for every (non-deleted) connection in a
 * project: its linked {@link DatabaseResource} (or null), whether it carries the
 * minimum identity to be linkable, and the sibling projects sharing each linked
 * resource. Read-only — never mutates and never throws for a missing/no-workspace
 * project (returns identities with empty `sharingProjects`).
 */
export async function resolveProjectDatabaseIdentities(
  projectId: string,
  prisma?: IdentityPrisma,
): Promise<ProjectDatabaseIdentity[]> {
  const db = resolvePrisma(prisma);

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  const workspaceId = project?.workspaceId ?? null;

  const connections = await db.databaseConnection.findMany({
    where: { projectId, deletedAt: null },
    select: {
      id: true,
      driver: true,
      host: true,
      port: true,
      databaseName: true,
      databaseResourceId: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const linkedResourceIds = [
    ...new Set(
      connections.map((c) => c.databaseResourceId).filter((id): id is string => id != null),
    ),
  ];

  const sharingByResource =
    workspaceId && linkedResourceIds.length > 0
      ? await loadSharingProjects(db, workspaceId, projectId, linkedResourceIds)
      : new Map<string, SharingProject[]>();

  return connections.map((c) => ({
    connectionId: c.id,
    databaseResourceId: c.databaseResourceId ?? null,
    insufficientIdentity: !hasResourceIdentity({
      driver: c.driver,
      host: c.host,
      port: c.port,
      databaseName: c.databaseName,
    }),
    sharingProjects: c.databaseResourceId
      ? (sharingByResource.get(c.databaseResourceId) ?? [])
      : [],
  }));
}

/**
 * For each linked resource, list the OTHER projects in `workspaceId` (excluding
 * `selfProjectId`) that have a non-deleted connection to it. Intersected with
 * the workspace so a resource never surfaces a project outside the tenant.
 */
async function loadSharingProjects(
  db: IdentityPrisma,
  workspaceId: string,
  selfProjectId: string,
  resourceIds: string[],
): Promise<Map<string, SharingProject[]>> {
  const siblings = await db.databaseConnection.findMany({
    where: {
      databaseResourceId: { in: resourceIds },
      deletedAt: null,
      projectId: { not: selfProjectId },
      project: { workspaceId, deletedAt: null },
    },
    select: {
      databaseResourceId: true,
      projectId: true,
      project: { select: { name: true } },
    },
  });

  // resourceId -> projectId -> name (dedupe multiple connections per project).
  const byResource = new Map<string, Map<string, string>>();
  for (const s of siblings) {
    if (!s.databaseResourceId) continue;
    let inner = byResource.get(s.databaseResourceId);
    if (!inner) {
      inner = new Map<string, string>();
      byResource.set(s.databaseResourceId, inner);
    }
    inner.set(s.projectId, s.project?.name ?? "");
  }

  const out = new Map<string, SharingProject[]>();
  for (const [resourceId, inner] of byResource) {
    out.set(
      resourceId,
      [...inner.entries()].map(([projectId, name]) => ({ projectId, name })),
    );
  }
  return out;
}

/**
 * Load a connection by id scoped to its project (non-deleted) or throw 404. The
 * project scope is a defence-in-depth check on top of the route's project-access
 * guard so a connection id from another project can never be mutated here.
 */
async function requireConnection(
  db: IdentityPrisma,
  projectId: string,
  connectionId: string,
): Promise<{
  id: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  databaseResourceId: string | null;
  workspaceId: string | null;
}> {
  const conn = await db.databaseConnection.findFirst({
    where: { id: connectionId, projectId, deletedAt: null },
    select: {
      id: true,
      driver: true,
      host: true,
      port: true,
      databaseName: true,
      databaseResourceId: true,
      project: { select: { workspaceId: true } },
    },
  });
  if (!conn) {
    throw new AppError(404, "DB_CONNECTOR_NOT_FOUND", "database connection not found");
  }
  return {
    id: conn.id,
    driver: conn.driver,
    host: conn.host,
    port: conn.port,
    databaseName: conn.databaseName,
    databaseResourceId: conn.databaseResourceId ?? null,
    workspaceId: conn.project?.workspaceId ?? null,
  };
}

/**
 * Explicitly link a connection to an EXISTING {@link DatabaseResource} — the
 * escape hatch for the same physical DB behind different hostnames the
 * conservative key cannot auto-detect. The target resource MUST live in the
 * connection's project's workspace; a missing resource or one in another
 * workspace is rejected with 404 (no cross-workspace existence oracle).
 * Idempotent: re-linking to the already-linked resource is a no-op. Audited.
 */
export async function linkConnectionToResourceExplicit(
  input: LinkInput,
  prisma?: IdentityPrisma,
): Promise<ConnectionLinkResult> {
  const db = resolvePrisma(prisma);
  const conn = await requireConnection(db, input.projectId, input.connectionId);

  if (!conn.workspaceId) {
    throw new AppError(
      400,
      "PROJECT_NO_WORKSPACE",
      "connection's project has no workspace; cannot link to a shared resource",
    );
  }

  const resource = await db.databaseResource.findUnique({
    where: { id: input.databaseResourceId },
    select: { id: true, workspaceId: true },
  });
  // 404 (not 403) for a missing OR cross-workspace resource — never leak that a
  // resource exists in a workspace the caller's project does not belong to.
  if (!resource || resource.workspaceId !== conn.workspaceId) {
    throw new AppError(404, "DB_RESOURCE_NOT_FOUND", "database resource not found");
  }

  if (conn.databaseResourceId === input.databaseResourceId) {
    return { connectionId: conn.id, databaseResourceId: conn.databaseResourceId, changed: false };
  }

  await db.databaseConnection.update({
    where: { id: conn.id },
    data: { databaseResourceId: input.databaseResourceId },
  });
  audit({
    actor: { id: input.actorId },
    action: "cross-project.connection.link",
    target: { type: "db_connector", id: conn.id },
    metadata: {
      projectId: input.projectId,
      workspaceId: conn.workspaceId,
      databaseResourceId: input.databaseResourceId,
      previousDatabaseResourceId: conn.databaseResourceId,
      mode: "explicit",
    },
  });
  // #955 — now that this connection is linked, reconcile the project's schema
  // objects into canonical identities under the shared resource.
  await reconcileAfterLink(input.projectId, db);
  return { connectionId: conn.id, databaseResourceId: input.databaseResourceId, changed: true };
}

/**
 * Unlink a connection from its {@link DatabaseResource}. Idempotent: an already
 * unlinked connection is a no-op. Audited when a link is actually removed.
 */
export async function unlinkConnectionFromResource(
  input: MutationInput,
  prisma?: IdentityPrisma,
): Promise<ConnectionLinkResult> {
  const db = resolvePrisma(prisma);
  const conn = await requireConnection(db, input.projectId, input.connectionId);

  if (conn.databaseResourceId == null) {
    return { connectionId: conn.id, databaseResourceId: null, changed: false };
  }

  await db.databaseConnection.update({
    where: { id: conn.id },
    data: { databaseResourceId: null },
  });
  audit({
    actor: { id: input.actorId },
    action: "cross-project.connection.unlink",
    target: { type: "db_connector", id: conn.id },
    metadata: {
      projectId: input.projectId,
      previousDatabaseResourceId: conn.databaseResourceId,
    },
  });
  return { connectionId: conn.id, databaseResourceId: null, changed: true };
}

/**
 * Safe re-resolve for a pre-existing UNLINKED connection: find-or-create its
 * resource by the conservative identity key and link it. Opt-in and idempotent —
 * a connection that is ALREADY linked is a no-op, so re-resolve never clobbers an
 * operator's explicit link, and a second call after linking does nothing. A
 * connection with insufficient identity (or a project with no workspace) resolves
 * to null and is left unlinked — never a guessed collapse of two distinct keys.
 */
export async function reresolveConnectionResource(
  input: MutationInput,
  prisma?: IdentityPrisma,
): Promise<ConnectionLinkResult> {
  const db = resolvePrisma(prisma);
  const conn = await requireConnection(db, input.projectId, input.connectionId);

  // Already linked → no-op (explicit links and prior resolves are preserved).
  if (conn.databaseResourceId != null) {
    return { connectionId: conn.id, databaseResourceId: conn.databaseResourceId, changed: false };
  }

  const resourceId = await resolveDatabaseResourceId(
    {
      projectId: input.projectId,
      driver: conn.driver,
      host: conn.host,
      port: conn.port,
      databaseName: conn.databaseName,
    },
    db,
  );
  // Insufficient identity or no workspace → leave unlinked (never a guess).
  if (!resourceId) {
    return { connectionId: conn.id, databaseResourceId: null, changed: false };
  }

  await db.databaseConnection.update({
    where: { id: conn.id },
    data: { databaseResourceId: resourceId },
  });
  audit({
    actor: { id: input.actorId },
    action: "cross-project.connection.link",
    target: { type: "db_connector", id: conn.id },
    metadata: {
      projectId: input.projectId,
      workspaceId: conn.workspaceId,
      databaseResourceId: resourceId,
      mode: "reresolve",
    },
  });
  // #955 — reconcile the project's schema objects into canonical identities under
  // the resource this connection just resolved to.
  await reconcileAfterLink(input.projectId, db);
  return { connectionId: conn.id, databaseResourceId: resourceId, changed: true };
}
