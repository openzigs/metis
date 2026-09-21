/**
 * Workspace-membership access guard for cross-project reads — Epic #295 Phase 4
 * (#307/#309).
 *
 * Phases 1–3 gated impact reads purely by PROJECT access (`createdById`, see
 * `scheduler/project-access.ts`). Phase 4 introduces a NEW tenancy dimension:
 * `DatabaseResource` and `SchemaObjectIdentity` are WORKSPACE-scoped, and a
 * cross-project query can surface OTHER projects that share a resource. A user
 * must therefore only ever see resources / canonical objects / other-projects
 * within workspaces they are a MEMBER of (`WorkspaceMember` for their userId).
 *
 * This module adds the workspace dimension and INTERSECTS it with the existing
 * project access (defence-in-depth): a project is cross-project-visible only if
 * the actor can access the project AND belongs to its workspace. Denials emit an
 * audit row, mirroring `actorCanAccessProject` (review finding L2).
 *
 * Authz model (matches custom-agents/authz.ts IDOR hardening):
 *   - system admin (`role === "admin"`): sees every workspace/project.
 *   - everyone else: only workspaces where a WorkspaceMember row exists for them.
 *   - a non-member probing a workspace gets 404 (never 403) so existence is not
 *     leaked; an authenticated caller asking about a workspace that genuinely
 *     does not exist also gets 404.
 */
import { prisma as defaultPrisma } from "../prisma.js";
import type { PrismaClient } from "@prisma/client";
import type { RoleKey } from "@metis/shared";
import { audit } from "../audit/audit-service.js";
import { AppError } from "../../middleware/error-handler.js";
import { isAdminActor, type SchedulerActor } from "../scheduler/project-access.js";

/** Minimal Prisma surface needed for workspace + project access checks. */
export type AccessPrisma = Pick<PrismaClient, "workspaceMember" | "project">;

function resolvePrisma(prisma?: AccessPrisma): AccessPrisma {
  return prisma ?? (defaultPrisma as unknown as AccessPrisma);
}

/**
 * Workspace ids the actor may see. Admins see every (non-deleted) workspace via
 * a distinct scan of projects' workspaceIds plus direct memberships; non-admins
 * see only the workspaces they are a `WorkspaceMember` of.
 */
export async function listAccessibleWorkspaceIds(
  actor: SchedulerActor,
  prisma?: AccessPrisma,
): Promise<string[]> {
  const db = resolvePrisma(prisma);
  if (isAdminActor(actor)) {
    // Admin: every workspace that owns at least one non-deleted project, unioned
    // with any workspace the admin is explicitly a member of. (A brand-new empty
    // workspace with no projects is irrelevant to cross-project reads.)
    const [projects, memberships] = await Promise.all([
      db.project.findMany({
        where: { deletedAt: null, workspaceId: { not: null } },
        select: { workspaceId: true },
        distinct: ["workspaceId"],
      }),
      db.workspaceMember.findMany({ where: { userId: actor.id }, select: { workspaceId: true } }),
    ]);
    const ids = new Set<string>();
    for (const p of projects) if (p.workspaceId) ids.add(p.workspaceId);
    for (const m of memberships) ids.add(m.workspaceId);
    return [...ids];
  }
  const memberships = await db.workspaceMember.findMany({
    where: { userId: actor.id },
    select: { workspaceId: true },
  });
  return [...new Set(memberships.map((m) => m.workspaceId))];
}

/** True iff the actor is a member of (or admin over) the given workspace. */
export async function actorIsWorkspaceMember(
  actor: SchedulerActor,
  workspaceId: string,
  prisma?: AccessPrisma,
): Promise<boolean> {
  if (isAdminActor(actor)) return true;
  const db = resolvePrisma(prisma);
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.id } },
    select: { id: true },
  });
  return membership != null;
}

/**
 * Assert the actor may read within `workspaceId`. Non-members (and unknown
 * workspaces) get 404 — NEVER 403 — so route probing cannot enumerate workspace
 * ids. Emits an audit row on denial. Admins always pass.
 */
export async function assertWorkspaceAccessible(
  actor: SchedulerActor,
  workspaceId: string,
  prisma?: AccessPrisma,
): Promise<void> {
  if (await actorIsWorkspaceMember(actor, workspaceId, prisma)) return;
  audit({
    actor: { id: actor.id },
    action: "cross-project.workspace.access.denied",
    target: { type: "workspace", id: workspaceId },
    metadata: { reason: "workspace-membership-missing" },
  });
  // 404 (not 403) — do not leak that the workspace exists.
  throw new AppError(404, "NOT_FOUND", "Workspace not found");
}

/**
 * Resolve the set of project ids inside `workspaceId` that the actor may see:
 * the INTERSECTION of (a) the workspace's projects and (b) the actor's
 * accessible-project set. For admins this is simply every non-deleted project in
 * the workspace. Used by the cross-project queries so a caller never sees a
 * sibling project they lack access to even within a shared workspace.
 *
 * Asserts workspace membership first (throws 404 for non-members).
 */
export async function listAccessibleProjectsInWorkspace(
  actor: SchedulerActor,
  workspaceId: string,
  prisma?: AccessPrisma,
): Promise<string[]> {
  await assertWorkspaceAccessible(actor, workspaceId, prisma);
  const db = resolvePrisma(prisma);
  const projects = await db.project.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, createdById: true },
  });
  if (isAdminActor(actor)) return projects.map((p) => p.id);
  // Non-admins: intersect the workspace's projects with the actor's accessible
  // set. Today project access is ownership-based (`createdById`, mirroring
  // scheduler/project-access.ts); we apply that filter against the SAME db so a
  // caller never sees a sibling project they cannot access even within a shared
  // workspace. When a real per-project membership table lands, swap this filter.
  return projects.filter((p) => p.createdById === actor.id).map((p) => p.id);
}

export type { SchedulerActor, RoleKey };
