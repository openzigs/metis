/**
 * #1574 — tell every open discussions list in a project that a thread was
 * created or its settings changed, so a teammate's new thread appears without
 * a reload.
 *
 * The event goes to the `project:{id}` room, as `comment:changed` does (#997):
 * that room's join rule (`canJoinProjectRoom`) is `canAccessProjectDiscussions`,
 * the very rule the thread list and create routes enforce, and the room is
 * already re-judged whenever that rule can change its answer (#1212). The
 * payload is identifiers only; the list re-reads the threads over REST.
 */
import { projectRoom, type DiscussionChangedEvent } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";

const log = createChildLogger("discussions:thread-events");

/**
 * Emit `discussion:changed` to the thread's project room. Fire-and-forget: a
 * socket failure is logged and never reaches the request that wrote the
 * thread, which has already succeeded.
 */
export function emitDiscussionChanged(projectId: string, threadId: string): void {
  try {
    const io = getSocketServer();
    if (!io) return;
    const event: DiscussionChangedEvent = { projectId, threadId, ts: Date.now() };
    io.to(projectRoom(projectId)).emit("discussion:changed", event);
  } catch (err) {
    log.warn("Failed to emit discussion:changed", { threadId, error: (err as Error).message });
  }
}
