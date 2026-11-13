/**
 * #2394 — the users who can open one project, as a `User` filter.
 *
 * This is the project-access rule (`assertLiveProjectAccess`,
 * `lib/custom-agents/authz.ts`) turned around: instead of "may this user open
 * this project", "which users may open it". Two audiences need it, and they
 * used to carry their own copies:
 *
 *   • the @mention and assignee picker (`GET /api/users?projectId=`, #734)
 *   • the reviewers sent `review:changed` in their own room (#2394)
 *
 * The rule, read live from the database: system admins always; for a live
 * project in a live workspace, that workspace's members; for a live legacy
 * project with no workspace, everyone. A soft-deleted project, or one in a
 * soft-deleted workspace, is open to system admins only.
 *
 * The filter does NOT exclude disabled or SCIM-soft-deleted users; each caller
 * adds `status: "active", deletedAt: null` beside it, as both do.
 */
import { prisma, type Prisma } from "../prisma.js";

/** System admins open every project, deleted ones included (`assertProjectAccess`'s bypass). */
export const SYSTEM_ADMIN_USER: Prisma.UserWhereInput = {
  roles: { some: { role: { key: "admin" } } },
};

export interface ProjectAudience {
  /** False for a soft-deleted project or one in a soft-deleted workspace. */
  live: boolean;
  /** The users who can open the project. `{}` (everyone) for a live legacy project. */
  where: Prisma.UserWhereInput;
}

/**
 * The audience of `projectId`, or `null` when no such project exists. One
 * query. Callers decide what an unknown project means to them: the picker
 * answers 404, the event sends to system admins only.
 */
export async function projectAudienceWhere(projectId: string): Promise<ProjectAudience | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, deletedAt: true, workspace: { select: { deletedAt: true } } },
  });
  if (!project) return null;
  if (project.deletedAt || project.workspace?.deletedAt) {
    return { live: false, where: SYSTEM_ADMIN_USER };
  }
  if (!project.workspaceId) return { live: true, where: {} };
  return {
    live: true,
    where: {
      OR: [
        { workspaceMemberships: { some: { workspaceId: project.workspaceId } } },
        SYSTEM_ADMIN_USER,
      ],
    },
  };
}
