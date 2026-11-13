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
 * Nor are disabled or SCIM-soft-deleted reviewers sent it, as no other
 * audience (mention delivery, the picker) reaches them either.
 *
 * The project room is sent the event first, before any lookup, so a slow or
 * hung access query never delays the open review page; the lookup is bounded
 * by {@link REVIEWER_LOOKUP_TIMEOUT_MS} and fails closed.
 */
import { projectRoom, userRoom, type ReviewChangedEvent } from "@metis/shared";
import { projectAudienceWhere, SYSTEM_ADMIN_USER } from "../auth/project-audience.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { getSocketServer } from "../socket/registry.js";

const log = createChildLogger("reviews:events");

/**
 * How long the reviewer access lookup may take before the personal rooms are
 * skipped (the fail-closed path). Two indexed reads; far longer means the
 * database is struggling, and a late sidebar refresh is no loss.
 */
export const REVIEWER_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * #2394 — the subset of `reviewerIds` who can open `projectId` now, in their
 * given order: the project-access rule ({@link projectAudienceWhere}) keyed by
 * the reviewer, with roles and memberships read live from the database, and
 * only active, non-deleted users. An unknown project is open to system admins
 * only. At most two queries, whatever the number of reviewers.
 */
export async function reviewersWhoCanOpen(
  projectId: string,
  reviewerIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(reviewerIds)];
  if (ids.length === 0) return [];
  const audience = (await projectAudienceWhere(projectId))?.where ?? SYSTEM_ADMIN_USER;
  const rows = await prisma.user.findMany({
    where: { id: { in: ids }, status: "active", deletedAt: null, AND: [audience] },
    select: { id: true },
  });
  const allowed = new Set(rows.map((r) => r.id));
  return ids.filter((id) => allowed.has(id));
}

/**
 * Emit `review:changed` to the review's project room, then to the own rooms
 * of those `reviewerIds` who can still open the project. The project room is
 * sent it synchronously, before any lookup; the personal-room broadcast
 * excepts the project room, so a socket in both is sent it once.
 * Post-commit and fire-and-forget: it never rejects. A socket failure is
 * logged and never reaches the request, whose state change has already
 * committed; a failed or timed-out access lookup is logged and skips the
 * personal rooms (fail closed; the project room's join was already judged).
 */
export async function emitReviewChanged(
  projectId: string,
  reviewId: string,
  reviewerIds: readonly string[] = [],
): Promise<void> {
  const io = getSocketServer();
  if (!io) return;
  const room = projectRoom(projectId);
  const event: ReviewChangedEvent = { projectId, reviewId, ts: Date.now() };
  try {
    io.to(room).emit("review:changed", event);
  } catch (err) {
    log.warn("Failed to emit review:changed", { reviewId, error: (err as Error).message });
  }
  if (reviewerIds.length === 0) return;
  const reviewers = await reviewersWhoCanOpenOrNone(projectId, reviewerIds, {
    event: "review:changed",
    reviewId,
  });
  if (reviewers.length === 0) return;
  try {
    io.to(reviewers.map(userRoom)).except(room).emit("review:changed", event);
  } catch (err) {
    log.warn("Failed to emit review:changed", { reviewId, error: (err as Error).message });
  }
}

/**
 * {@link reviewersWhoCanOpen}, bounded by {@link REVIEWER_LOOKUP_TIMEOUT_MS} and
 * failing closed: a failed or timed-out lookup is logged and answers `[]`, so
 * nobody is sent anything rather than someone who cannot open the project.
 * Never rejects. Shared by `review:changed` and the review notifications
 * (`notify.ts`: `review_requested`, `review_item_changed`).
 */
export async function reviewersWhoCanOpenOrNone(
  projectId: string,
  reviewerIds: readonly string[],
  context: { event: string; reviewId: string },
): Promise<string[]> {
  if (reviewerIds.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${REVIEWER_LOOKUP_TIMEOUT_MS}ms`)),
      REVIEWER_LOOKUP_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([reviewersWhoCanOpen(projectId, reviewerIds), timeout]);
  } catch (err) {
    log.warn(`${context.event} reviewer access lookup failed; no reviewer is sent it`, {
      reviewId: context.reviewId,
      error: (err as Error).message,
    });
    return [];
  } finally {
    clearTimeout(timer);
  }
}
