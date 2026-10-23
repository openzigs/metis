/**
 * Issue #1432 — who a requirement may be assigned to.
 *
 * `POST /api/requirements/:requirementId/assignments` authorized the CALLER on
 * the requirement and then wrote whatever `assigneeId` the body named. Any user
 * id was accepted: the response's `assignee` include returned that user's
 * username and display name (a cross-workspace user lookup), and the SLA
 * checker later sent them a notification carrying the requirement's title.
 *
 * An eligible assignee is an ACTIVE, non-deleted user who
 *   - is a live member of the project's workspace, when it has one — a system
 *     admin included: being able to open every project does not put someone in
 *     this workspace, and an assignment is a workspace act (the same line #1431
 *     draws for ChatOps bindings); and
 *   - can open the project by the project-access rule
 *     (`canAccessProjectDiscussions` → `assertProjectAccess`, plus "not
 *     soft-deleted" for non-admins), keyed by the assignee — the predicate
 *     mentions and discussion notifications already use for a third party.
 *
 * A legacy workspace-less project keeps its open rule: every active user can
 * open it, so every active user is eligible.
 *
 * Every refusal is the same `false`; callers answer it like an unknown user.
 */
import { prisma } from "../prisma.js";
import { canAccessProjectDiscussions } from "../discussions/access.js";
import { isActiveWorkspaceMember } from "../workspaces/chatops-identity-scope.js";

/** May `userId` be assigned work in `projectId`? */
export async function isEligibleAssignee(userId: string, projectId: string): Promise<boolean> {
  if (!userId || !projectId) return false;
  const [user, project] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, deletedAt: null, status: "active" },
      select: { id: true },
    }),
    prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } }),
  ]);
  if (!user || !project) return false;
  if (
    project.workspaceId &&
    !(await isActiveWorkspaceMember(prisma, project.workspaceId, userId))
  ) {
    return false;
  }
  const adminRole = await prisma.userRole.findFirst({
    where: { userId, role: { key: "admin" } },
    select: { userId: true },
  });
  // No audit context: an ineligible assignee is not an access attempt by them.
  return canAccessProjectDiscussions(
    { id: userId, role: adminRole ? "admin" : "reader" },
    projectId,
  );
}

/** The subset of `userIds` eligible in `projectId` (each id checked once). */
export async function eligibleAssigneeIds(
  userIds: readonly string[],
  projectId: string,
): Promise<Set<string>> {
  const eligible = new Set<string>();
  for (const id of new Set(userIds)) {
    if (await isEligibleAssignee(id, projectId)) eligible.add(id);
  }
  return eligible;
}
