/**
 * Issue #1432 — who a requirement may be assigned to.
 *
 * `POST /api/requirements/:requirementId/assignments` authorized the CALLER on
 * the requirement and then wrote whatever `assigneeId` the body named. Any user
 * id was accepted: the response's `assignee` include returned that user's
 * username and display name (a cross-workspace user lookup), and the SLA
 * checker later sent them a notification carrying the requirement's title.
 *
 * An eligible assignee is an ACTIVE, non-deleted user who can open the
 * requirement's project by the project-access rule, keyed by the assignee
 * (`canAccessProjectDiscussions` → `assertProjectAccess`, plus "not
 * soft-deleted" for non-admins). That rule reads the assignee's LIVE workspace
 * memberships from the database (`readLiveWorkspaceIds`), so for a workspace
 * project it means a live member of that workspace. It is the same audience the
 * assignee picker offers (`GET /api/users?projectId=`, `mentionAudienceWhere`)
 * and the one mentions and discussion notifications are delivered to:
 *
 *   - system admins are eligible everywhere — they open every project, and the
 *     user search already lists them to every caller, so neither the reply nor
 *     an SLA notification tells anyone something they could not already see;
 *   - a soft-deleted project offers system admins only;
 *   - a legacy workspace-less project is open, so every active user qualifies.
 *
 * Every refusal is the same `false`; callers answer it like an unknown user.
 */
import { prisma } from "../prisma.js";
import { canAccessProjectDiscussions } from "../discussions/access.js";

/** May `userId` be assigned work in `projectId`? */
export async function isEligibleAssignee(userId: string, projectId: string): Promise<boolean> {
  if (!userId || !projectId) return false;
  const [user, adminRole] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, deletedAt: null, status: "active" },
      select: { id: true },
    }),
    prisma.userRole.findFirst({
      where: { userId, role: { key: "admin" } },
      select: { userId: true },
    }),
  ]);
  if (!user) return false;
  // No audit context: an ineligible assignee is not an access attempt by them.
  return canAccessProjectDiscussions(
    { id: userId, role: adminRole ? "admin" : "reader" },
    projectId,
  );
}

/** The subset of `userIds` eligible in `projectId` (each distinct id checked once, in parallel). */
export async function eligibleAssigneeIds(
  userIds: readonly string[],
  projectId: string,
): Promise<Set<string>> {
  const distinct = [...new Set(userIds)];
  const verdicts = await Promise.all(distinct.map((id) => isEligibleAssignee(id, projectId)));
  return new Set(distinct.filter((_, i) => verdicts[i]));
}
