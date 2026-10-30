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
 */
import { projectRoom, type ReviewChangedEvent } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";

const log = createChildLogger("reviews:events");

/**
 * Emit `review:changed` to the review's project room. Post-commit and
 * fire-and-forget: a socket failure is logged and never reaches the request,
 * whose state change has already committed.
 */
export function emitReviewChanged(projectId: string, reviewId: string): void {
  try {
    const io = getSocketServer();
    if (!io) return;
    const event: ReviewChangedEvent = { projectId, reviewId, ts: Date.now() };
    io.to(projectRoom(projectId)).emit("review:changed", event);
  } catch (err) {
    log.warn("Failed to emit review:changed", { reviewId, error: (err as Error).message });
  }
}
