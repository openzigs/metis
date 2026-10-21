/**
 * #997 — tell every open comment panel on a requirement or Spec Kit artifact
 * that its threads changed, so a second user's reply appears without a reload.
 *
 * The event goes to the `project:{id}` room, not to a new per-thread room: that
 * room's join rule (`canJoinProjectRoom`) is `canAccessProjectDiscussions`, the
 * very rule the comment routes enforce (`assertCommentProjectAccess`), and the
 * room is already re-judged whenever that rule can change its answer (member
 * removal, workspace and project deletes, a legacy project's workspace
 * assignment, and the re-validation pass — `project-room-eviction.ts`, #1212).
 * A new room would have needed its own join rule and its own place in that
 * re-judgement for no gain.
 *
 * The payload is identifiers only; the panel re-reads the threads over the
 * permission-checked REST route, so no comment body ever rides the socket.
 */
import { projectRoom, type CommentChangedEvent } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";

const log = createChildLogger("collaboration:comment-events");

/** Where a comment thread lives — the columns the comment routes already read. */
export interface CommentThreadLocation {
  id: string;
  requirementId: string | null;
  /** The requirement's project, when the thread is on a requirement. */
  requirement?: { projectId: string } | null;
  specKitProjectId: string | null;
  specKitArtifactName: string | null;
}

/**
 * The `comment:changed` payload for a thread, or null for a thread that
 * resolves to no project (only an admin can reach one — nothing to tell).
 */
export function commentChangedEvent(
  thread: CommentThreadLocation,
  now: number = Date.now(),
): CommentChangedEvent | null {
  if (thread.requirementId && thread.requirement?.projectId) {
    return {
      projectId: thread.requirement.projectId,
      threadId: thread.id,
      requirementId: thread.requirementId,
      artifactName: null,
      ts: now,
    };
  }
  if (thread.specKitProjectId && thread.specKitArtifactName) {
    return {
      projectId: thread.specKitProjectId,
      threadId: thread.id,
      requirementId: null,
      artifactName: thread.specKitArtifactName,
      ts: now,
    };
  }
  return null;
}

/**
 * Emit `comment:changed` for `thread` to its project room. Fire-and-forget: a
 * socket failure is logged and never reaches the request that wrote the
 * comment, which has already succeeded.
 */
export function emitCommentChanged(thread: CommentThreadLocation): void {
  try {
    const event = commentChangedEvent(thread);
    if (!event) return;
    const io = getSocketServer();
    if (!io) return;
    io.to(projectRoom(event.projectId)).emit("comment:changed", event);
  } catch (err) {
    log.warn("Failed to emit comment:changed", {
      threadId: thread.id,
      error: (err as Error).message,
    });
  }
}
