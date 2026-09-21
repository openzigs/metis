/**
 * Epic #260 (#80) — authorization helpers for custom-agent authoring.
 *
 * Authoring (create / update / delete / enable) requires a workspace
 * `admin`/`owner` role on the project's workspace. System admins bypass.
 *
 * IDOR hardening: a caller who is not a member of the resolved workspace gets
 * a 404 (not 403) so route probing cannot enumerate project/workspace ids.
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import type { Prisma } from "@prisma/client";

const ROLE_RANK: Record<string, number> = { member: 10, admin: 20, owner: 30 };
const MIN_ADMIN_RANK = ROLE_RANK.admin;

/**
 * Assert that `user` may author custom agents for `projectId`. Resolves the
 * project's workspace and checks the caller's workspace role.
 *
 * @throws AppError 404 — unknown project OR caller is not a workspace member
 * @throws AppError 400 — project has no workspace assigned yet
 * @throws AppError 403 — caller is a member but below admin
 */
export async function assertWorkspaceAdminForProject(
  user: AuthPayload,
  projectId: string,
): Promise<void> {
  // System admins bypass workspace RBAC entirely.
  if (user.role === "admin") return;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true },
  });
  if (!project) {
    throw new AppError(404, "NOT_FOUND", "Project not found");
  }
  if (!project.workspaceId) {
    throw new AppError(400, "WORKSPACE_REQUIRED", "Project is not assigned to a workspace");
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: project.workspaceId, userId: user.userId },
    },
    select: { role: true },
  });
  // Non-members get 404 — do not leak that the project/workspace exists.
  if (!membership) {
    throw new AppError(404, "NOT_FOUND", "Project not found");
  }

  const rank = ROLE_RANK[membership.role] ?? 0;
  if (rank < MIN_ADMIN_RANK) {
    throw new AppError(403, "FORBIDDEN", "Workspace admin role required");
  }
}

/**
 * Assert that `user` may access `projectId` (any workspace role is enough).
 * Used by the invocation playground — "anyone may invoke if the agent is
 * enabled", scoped to a project the caller can actually reach.
 *
 * THIS FUNCTION IS THE RULE, not a copy of one stated elsewhere. It is the
 * canonical object-level project-scope seam (#673): the `requireProjectAccess`
 * middleware (`middleware/require-project-access.ts`) is a thin wrapper that
 * calls it for every `/projects/:projectId/**` route, so changing the predicate
 * here changes route-level enforcement across the API. Non-members get 404,
 * never 403, so route probing cannot enumerate project or workspace ids.
 *
 * The equivalent rule for LIST queries is `accessibleProjectWhere`
 * (`lib/acp/authz.ts`); keep the two in step.
 *
 * @throws AppError 404 — unknown project OR caller has no access
 */
export async function assertProjectAccess(
  user: AuthPayload,
  projectId: string,
  db: Pick<Prisma.TransactionClient, "project"> = prisma,
): Promise<void> {
  if (user.role === "admin") return;

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) {
    throw new AppError(404, "NOT_FOUND", "Project not found");
  }
  // Pre-migration projects with no workspace are open to authenticated users.
  // The reachable list-scoping predicates agree — `accessibleProjectWhere`
  // (lib/acp/authz.ts), `runProjectScope` (lib/async/run-authz.ts) and
  // `listProjects` (lib/projects/project-service.ts) all admit
  // `workspaceId: null` rows — so a legacy project stays visible in a list AND
  // reachable by id until the workspace backfill runs.
  if (!project.workspaceId) return;

  const workspaces = user.workspaces ?? [];
  if (!workspaces.includes(project.workspaceId)) {
    throw new AppError(404, "NOT_FOUND", "Project not found");
  }
}
