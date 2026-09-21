/**
 * Project access guard for the Phase 11 scheduler + tasks routes.
 *
 * Background: Metis does not yet ship a per-project membership table. Until
 * one lands, defence-in-depth at the route + service layers MUST still
 * intersect every list/get/cancel/retry against the actor's accessible
 * project set so a `task.read` token can't surface another team's job IDs
 * (review findings H2/H3).
 *
 * Current rules:
 *   - admin role: every project is in scope
 *   - any other role: jobs/tasks with `projectId == null` (system jobs) OR
 *     where the actor created the project itself
 *
 * When project memberships ship, swap the `accessibleProjectIds` query for a
 * membership lookup and the rest of the wiring stays put.
 */
import { prisma } from "../prisma.js";
import type { RoleKey } from "@metis/shared";
import { audit } from "../audit/audit-service.js";

export interface SchedulerActor {
  id: string;
  role: RoleKey;
}

export interface AccessScope {
  /** True when the actor can see every project (admin). */
  all: boolean;
  /** Project ids the actor can see. Empty when `all` is true. */
  projectIds: string[];
}

/** Prisma-compatible `where` fragment that intersects rows by accessible projects. */
export type AccessWhere =
  | Record<string, never>
  | { OR: Array<{ projectId: null } | { projectId: { in: string[] } }> };

const ADMIN_ROLES: ReadonlySet<RoleKey> = new Set(["admin"]);

export function isAdminActor(actor: SchedulerActor): boolean {
  return ADMIN_ROLES.has(actor.role);
}

/**
 * Build a Prisma `where` fragment matching all projects the actor can see.
 * Returns `{}` (matches everything) for admin actors and a positive
 * `OR` filter (`projectId IS NULL` ∪ `projectId IN owned`) otherwise.
 */
export async function buildProjectAccessWhere(actor: SchedulerActor): Promise<AccessWhere> {
  if (isAdminActor(actor)) return {};
  const ownedIds = await listAccessibleProjectIds(actor);
  return {
    OR: [{ projectId: null }, { projectId: { in: ownedIds } }],
  };
}

export async function listAccessibleProjectIds(actor: SchedulerActor): Promise<string[]> {
  if (isAdminActor(actor)) {
    const all = await prisma.project.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return all.map((p) => p.id);
  }
  const owned = await prisma.project.findMany({
    where: { deletedAt: null, createdById: actor.id },
    select: { id: true },
  });
  return owned.map((p) => p.id);
}

/**
 * Decide whether `actor` may touch a row with the given `projectId`.
 *
 * - `null` / system-wide rows: only admins.
 * - All other rows: must be on the actor's accessible-project list.
 *
 * On denial we return `false` AND emit an audit row so the security team can
 * trace probing attempts (review finding L2).
 */
export async function actorCanAccessProject(
  actor: SchedulerActor,
  projectId: string | null,
  context: { resource: string; resourceId: string; action: string },
): Promise<boolean> {
  if (isAdminActor(actor)) return true;
  if (projectId == null) {
    // Non-admins cannot mutate or read system-wide rows; emit an audit and
    // deny. This guards the "no projectId" leakage path.
    audit({
      actor: { id: actor.id },
      action: `${context.action}.denied`,
      target: { type: context.resource, id: context.resourceId },
      metadata: { reason: "system-row-denied", projectId: null },
    });
    return false;
  }
  const allowed = await listAccessibleProjectIds(actor);
  if (allowed.includes(projectId)) return true;
  audit({
    actor: { id: actor.id },
    action: `${context.action}.denied`,
    target: { type: context.resource, id: context.resourceId },
    metadata: { reason: "project-membership-missing", projectId },
  });
  return false;
}
