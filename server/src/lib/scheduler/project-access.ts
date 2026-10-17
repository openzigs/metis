/**
 * Project access guard for the Phase 11 scheduler + tasks routes, and for the
 * other project-scoped surfaces that reuse it (sandbox, requirement links, the
 * traceability roll-up, the Slack/Teams commands).
 *
 * Defence-in-depth at the route + service layers MUST intersect every
 * list/get/cancel/retry against the actor's accessible project set so a
 * `task.read` token can't surface another team's job IDs (review findings
 * H2/H3).
 *
 * #1221 — the rule is the project's own (`GET /projects/:id`):
 * `assertProjectAccess` (`lib/custom-agents/authz.ts`), reached through
 * `canAccessProjectDiscussions` (`lib/discussions/access.ts`). Admins see every
 * project; anyone else sees the projects of the workspaces they are a live
 * member of (read from the database, not a token claim), plus legacy
 * workspace-less projects. Soft-deleted projects stay closed to non-admins. It
 * replaced the creator-only `actorCanAccessProject`, under which a workspace
 * member who did not create a project was refused its schedules, tasks and
 * links while the project itself was open to them.
 *
 * Role permissions are NOT checked here. Every write path that reaches these
 * helpers gates its permission first — `requirePermission("scheduler.manage")`,
 * `"task.cancel"`, `"analysis.run"`, `"project.update"` on the REST routes, and
 * `hasPermission(role, "issue.draft")` in the chat commands — so a reader-role
 * member can read what the workspace shares and mutate nothing.
 *
 * `listAccessibleProjectIds` below is STILL the creator-only predicate. Its
 * remaining callers (products, impact-detail, run access) were not part of
 * #1221; they move in #1232.
 */
import { prisma } from "../prisma.js";
import type { RoleKey } from "@metis/shared";
import { audit } from "../audit/audit-service.js";
import { asAuthPayload, canAccessProjectDiscussions } from "../discussions/access.js";
import { accessibleProjectWhere } from "../acp/authz.js";

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
  Record<string, never> | { OR: Array<{ projectId: null } | { projectId: { in: string[] } }> };

const ADMIN_ROLES: ReadonlySet<RoleKey> = new Set(["admin"]);

export function isAdminActor(actor: SchedulerActor): boolean {
  return ADMIN_ROLES.has(actor.role);
}

/**
 * Build a Prisma `where` fragment over a row's `projectId` matching every row
 * the actor may LIST: `{}` (everything) for admins, otherwise system rows
 * (`projectId IS NULL`) plus rows of the projects
 * {@link listMemberAccessibleProjectIds} returns.
 */
export async function buildProjectAccessWhere(actor: SchedulerActor): Promise<AccessWhere> {
  if (isAdminActor(actor)) return {};
  const ids = await listMemberAccessibleProjectIds(actor);
  return {
    OR: [{ projectId: null }, { projectId: { in: ids } }],
  };
}

/**
 * #1221 — the LIST twin of {@link actorHasProjectAccess}: every live project
 * the actor may open, by `accessibleProjectWhere` (`lib/acp/authz.ts`, the
 * list form of `assertProjectAccess`), with the actor's workspaces read live
 * from the database.
 */
export async function listMemberAccessibleProjectIds(actor: SchedulerActor): Promise<string[]> {
  // An admin's workspaces do not enter the rule, so skip the read.
  const payload = await asAuthPayload(isAdminActor(actor) ? { ...actor, workspaces: [] } : actor);
  const rows = await prisma.project.findMany({
    where: accessibleProjectWhere(payload),
    select: { id: true },
  });
  return rows.map((p) => p.id);
}

/**
 * CREATOR-ONLY project ids (admins: every live project). Not used by any
 * #1221 surface; kept for its remaining callers until they move too.
 */
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
 * - All other rows: the project-access rule (`canAccessProjectDiscussions` →
 *   `assertProjectAccess`; see the module comment).
 *
 * On denial we return `false` AND emit an audit row so the security team can
 * trace probing attempts (review finding L2).
 */
export async function actorHasProjectAccess(
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
  return canAccessProjectDiscussions(actor, projectId, context);
}
