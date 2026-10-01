/**
 * #672 — Socket.IO room names, defined once for the server and the UI.
 *
 * The server's `subscribe:*` / `presence:join` handlers join these rooms and
 * leave them on the matching `unsubscribe:*` / `presence:leave`. The UI's
 * `keepRoomSubscribed` reference-counts followers per room (#647) and sends the
 * unsubscribe only when the last follower releases, so its count key must be
 * the room the server actually joined. Both sides deriving the name from these
 * factories is what keeps the two from drifting apart.
 */

/** A discussion thread's realtime fan-out (`subscribe:thread`). */
export const threadRoom = (threadId: string): string => `thread:${threadId}`;

/** A chat session's tool-event and approval room (`subscribe:session`). */
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

/** A scheduled task's progress and status room (`subscribe:task`). */
export const taskRoom = (taskId: string): string => `task:${taskId}`;

/** An analysis run's agent / capability / outcome room (`subscribe:analysis`). */
export const analysisRoom = (analysisId: string): string => `analysis:${analysisId}`;

/** A publish batch's live log room (`subscribe:publish`). */
export const publishRoom = (batchId: string): string => `publish:${batchId}`;

/** Who is viewing an artifact (`presence:join`); `presence:update` echoes it as `room`. */
export const presenceRoom = (artifactType: string, artifactId: string): string =>
  `presence:${artifactType}:${artifactId}`;
