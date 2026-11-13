/**
 * #1574 — tell every open review page in a project that a review changed
 * state (submitted, decided, withdrawn, closed), so the requester watching it
 * sees the decision without a reload.
 *
 * The event goes to the `project:{id}` room, as `comment:changed` does (#997):
 * that room's join rule (`canJoinProjectRoom` → `canAccessProjectDiscussions`)
 * is the project-access half of the review routes' own check
 * (`assertReviewAccess` → `assertLiveProjectAccess`), and the room is already
 * re-judged whenever that rule can change its answer (#1212). The payload is
 * identifiers only; the page re-reads the review over the REST route, which
 * also checks `review.read`, so nothing a member could not read rides the
 * socket.
 *
 * #2370 — it also goes to each assigned reviewer's own `user:{id}` room, so a
 * reviewer's sidebar count hears a withdraw, close or another reviewer's
 * settling decision while they are on no page of that project (and so in no
 * project room). Those ids are the review's own assignees; the payload is the
 * same identifiers, of a review they were assigned to.
 *
 * #2394 — but only the assignees who can still open the project
 * ({@link reviewersWhoCanOpen}). An assignment outlives the reviewer's access:
 * they can be removed from the workspace, or the project or its workspace
 * soft-deleted, and a personal room is never re-judged as a project room is.
 */
import { projectRoom, userRoom, type ReviewChangedEvent } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma, type Prisma } from "../prisma.js";
import { getSocketServer } from "../socket/registry.js";

const log = createChildLogger("reviews:events");

/** System admins open every project, deleted ones included (`assertProjectAccess`'s bypass). */
const SYSTEM_ADMIN: Prisma.UserWhereInput = { roles: { some: { role: { key: "admin" } } } };

/**
 * #2394 — the subset of `reviewerIds` who can open `projectId` now, in their
 * given order: the project-access rule (`assertLiveProjectAccess`) keyed by the
 * reviewer, with roles and memberships read live from the database. System
 * admins always; for a live project in a live workspace, that workspace's
 * members; for a live legacy project with no workspace, everyone; for a
 * soft-deleted project, one in a soft-deleted workspace, or an unknown one,
 * system admins only. At most two queries, whatever the number of reviewers.
 */
export async function reviewersWhoCanOpen(
  projectId: string,
  reviewerIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(reviewerIds)];
  if (ids.length === 0) return [];
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, deletedAt: true, workspace: { select: { deletedAt: true } } },
  });
  let audience: Prisma.UserWhereInput;
  if (!project || project.deletedAt || project.workspace?.deletedAt) {
    audience = SYSTEM_ADMIN;
  } else if (!project.workspaceId) {
    return ids;
  } else {
    audience = {
      OR: [{ workspaceMemberships: { some: { workspaceId: project.workspaceId } } }, SYSTEM_ADMIN],
    };
  }
  const rows = await prisma.user.findMany({
    where: { id: { in: ids }, ...audience },
    select: { id: true },
  });
  const allowed = new Set(rows.map((r) => r.id));
  return ids.filter((id) => allowed.has(id));
}

/**
 * Emit `review:changed` to the review's project room and to the own rooms of
 * those `reviewerIds` who can still open the project, as ONE broadcast over
 * the union of rooms, so a socket in several of them is sent it once.
 * Post-commit and fire-and-forget: it never rejects. A socket failure is
 * logged and never reaches the request, whose state change has already
 * committed; a failed access lookup is logged and sends to the project room
 * alone (fail closed for the personal rooms; the project room's join was
 * already judged).
 */
export async function emitReviewChanged(
  projectId: string,
  reviewId: string,
  reviewerIds: readonly string[] = [],
): Promise<void> {
  try {
    const io = getSocketServer();
    if (!io) return;
    const reviewers = await reachableReviewers(projectId, reviewId, reviewerIds);
    const event: ReviewChangedEvent = { projectId, reviewId, ts: Date.now() };
    io.to([projectRoom(projectId), ...reviewers.map(userRoom)]).emit("review:changed", event);
  } catch (err) {
    log.warn("Failed to emit review:changed", { reviewId, error: (err as Error).message });
  }
}

async function reachableReviewers(
  projectId: string,
  reviewId: string,
  reviewerIds: readonly string[],
): Promise<string[]> {
  try {
    return await reviewersWhoCanOpen(projectId, reviewerIds);
  } catch (err) {
    log.warn("review:changed reviewer access lookup failed; sending to the project room only", {
      reviewId,
      error: (err as Error).message,
    });
    return [];
  }
}
