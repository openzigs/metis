/**
 * DatabaseResource registry service — Epic #295 Phase 4 (#307).
 *
 * Find-or-create the workspace-scoped {@link DatabaseResource} that dedupes a
 * physical DB across the projects of a workspace, and link a project-scoped
 * `DatabaseConnection` to it. The same physical DB connected from two projects
 * in a workspace collapses to ONE resource (the dedupe key is the runtime source
 * of truth — see `@metis/shared` `databaseResourceKey`, mirrored by the
 * migration backfill).
 *
 * Linking is BEST-EFFORT and additive:
 *   - a connection in a project with NO workspace is left unlinked;
 *   - a connection lacking the minimum identity (host + databaseName) is left
 *     unlinked (two such connections must never be merged by accident);
 *   - any failure NEVER blocks connection create (the FK is nullable).
 *
 * Authz: a resource is only ever created/linked within the connection's
 * project's workspace, and the caller must be a member of that workspace (the
 * connection-create route already gates project access; this adds the workspace
 * dimension as defence-in-depth).
 */
import type { PrismaClient } from "@prisma/client";
import {
  databaseResourceKey,
  hasResourceIdentity,
  type DatabaseResourceKeyParts,
} from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { audit } from "../audit/audit-service.js";

const log = createChildLogger("database-resource-service");

/** Minimal Prisma surface for the resource registry. */
export type ResourcePrisma = Pick<
  PrismaClient,
  "project" | "databaseResource" | "databaseConnection"
>;

function resolvePrisma(prisma?: ResourcePrisma): ResourcePrisma {
  return prisma ?? (defaultPrisma as unknown as ResourcePrisma);
}

export interface ResolveResourceInput extends DatabaseResourceKeyParts {
  /** The project the connection belongs to (used to resolve the workspace). */
  projectId: string;
}

/**
 * Resolve (find-or-create) the {@link DatabaseResource} for a connection's
 * physical-DB identity within its project's workspace, returning the resource id
 * — or `null` when the connection cannot/should-not be linked (no workspace, or
 * insufficient identity). NEVER throws: a failure logs + returns null so
 * connection create proceeds unlinked.
 *
 * Idempotent: re-resolving the same identity returns the existing resource. A
 * concurrent create that loses the unique-constraint race is retried as a find.
 */
export async function resolveDatabaseResourceId(
  input: ResolveResourceInput,
  prisma?: ResourcePrisma,
): Promise<string | null> {
  const db = resolvePrisma(prisma);
  const keyParts: DatabaseResourceKeyParts = {
    driver: input.driver,
    host: input.host,
    port: input.port,
    databaseName: input.databaseName,
  };
  // Insufficient identity → never collapse two distinct connections by accident.
  if (!hasResourceIdentity(keyParts)) return null;

  try {
    const project = await db.project.findUnique({
      where: { id: input.projectId },
      select: { workspaceId: true },
    });
    // No project or no workspace → leave unlinked (project-scoped only).
    if (!project?.workspaceId) return null;
    const workspaceId = project.workspaceId;

    // Use findFirst with a plain equality filter rather than findUnique on the
    // compound unique: the unique includes NULLABLE columns (host/port/db) and
    // Prisma's generated compound-unique `where` type cannot express a NULL
    // match (a known limitation — same reason schema-usage-override.ts uses
    // findFirst). The DB unique index is the backstop against duplicates.
    const where = {
      workspaceId,
      driver: keyParts.driver,
      host: keyParts.host,
      port: keyParts.port,
      databaseName: keyParts.databaseName,
    };

    const existing = await db.databaseResource.findFirst({
      where,
      select: { id: true },
    });
    if (existing) return existing.id;

    try {
      const created = await db.databaseResource.create({
        data: {
          workspaceId,
          driver: keyParts.driver,
          host: keyParts.host,
          port: keyParts.port,
          databaseName: keyParts.databaseName,
        },
        select: { id: true },
      });
      audit({
        actor: { id: null },
        action: "cross-project.resource.create",
        target: { type: "database_resource", id: created.id },
        metadata: {
          workspaceId,
          driver: keyParts.driver,
          // host/db are non-sensitive endpoint identifiers (no credentials).
          key: databaseResourceKey(workspaceId, keyParts),
        },
      });
      return created.id;
    } catch {
      // Lost a create race (unique violation) — the row now exists, find it.
      const retried = await db.databaseResource.findFirst({ where, select: { id: true } });
      return retried?.id ?? null;
    }
  } catch (err) {
    log.warn("resolveDatabaseResourceId failed; leaving connection unlinked", {
      projectId: input.projectId,
      err: (err as Error).message,
    });
    return null;
  }
}

/**
 * Resolve + link in one step: find-or-create the resource for the connection's
 * identity and set `databaseConnection.databaseResourceId`. Returns the linked
 * resource id, or null when not linkable. NEVER throws — used as a post-create
 * hook so a registry failure cannot break connection creation.
 */
export async function linkConnectionToResource(
  connectionId: string,
  input: ResolveResourceInput,
  prisma?: ResourcePrisma,
): Promise<string | null> {
  const db = resolvePrisma(prisma);
  const resourceId = await resolveDatabaseResourceId(input, db);
  if (!resourceId) return null;
  try {
    await db.databaseConnection.update({
      where: { id: connectionId },
      data: { databaseResourceId: resourceId },
    });
    return resourceId;
  } catch (err) {
    log.warn("linkConnectionToResource update failed", {
      connectionId,
      err: (err as Error).message,
    });
    return null;
  }
}
