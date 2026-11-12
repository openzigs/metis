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
 */
import { projectRoom, userRoom, type ReviewChangedEvent } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";

const log = createChildLogger("reviews:events");

/**
 * Emit `review:changed` to the review's project room and to each of
 * `reviewerIds`' own rooms, as ONE broadcast over the union of rooms, so a
 * socket in several of them is sent it once. Post-commit and
 * fire-and-forget: a socket failure is logged and never reaches the request,
 * whose state change has already committed.
 */
export function emitReviewChanged(
  projectId: string,
  reviewId: string,
  reviewerIds: readonly string[] = [],
): void {
  try {
    const io = getSocketServer();
    if (!io) return;
    const event: ReviewChangedEvent = { projectId, reviewId, ts: Date.now() };
    io.to([projectRoom(projectId), ...reviewerIds.map(userRoom)]).emit("review:changed", event);
  } catch (err) {
    log.warn("Failed to emit review:changed", { reviewId, error: (err as Error).message });
  }
}
