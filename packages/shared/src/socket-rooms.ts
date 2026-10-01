/**
 * #672 — Socket.IO room names, defined once for the server and the UI.
 *
 * The server's `subscribe:*` / `presence:join` handlers join these rooms and
 * leave them on the matching `unsubscribe:*` / `presence:leave`. The UI's
 * `keepRoomSubscribed` reference-counts followers per room (#647) and sends the
 * unsubscribe only when the last follower releases, so its count key must be
 * the room the server actually joined. Both sides deriving the name from these
 * factories is what keeps the two from drifting apart.
 *
 * #676 — the server's emitters address these rooms through the same factories,
 * so the room a client joins and the room the server sends to cannot drift
 * either. A hand-written room name of one of these kinds under `server/src` is
 * a lint error (`no-restricted-syntax`, `eslint.config.mjs`).
 */

/**
 * #682 — a project's broadcast room (`subscribe:project`). The UI never leaves
 * it, but names it to match a rate-limited refusal of its join.
 */
export const projectRoom = (projectId: string): string => `project:${projectId}`;

/**
 * #686 — a user's personal room. The server joins every socket to its own
 * user's room on connect, from the verified token only (there is no
 * `subscribe:user`), and sends mentions, review and SLA notifications to it;
 * revocation finds a user's sockets through it.
 */
export const userRoom = (userId: string): string => `user:${userId}`;

/** #682 — the scheduler's status room (`subscribe:scheduler`); one per deployment. */
export const SCHEDULER_STATUS_ROOM = "scheduler:status";

/** A discussion thread's realtime fan-out (`subscribe:thread`). */
export const threadRoom = (threadId: string): string => `thread:${threadId}`;

/**
 * #685 — the one `auth:error` message for a refused thread room, whatever the
 * cause: an unknown or deleted id, no access, or a failed lookup all read the
 * same, so the message never tells a probe which ids exist. The server sends it
 * as `{ message, room: threadRoom(id) }`; shared so the UI's tests assert the
 * value the server actually sends.
 */
export const THREAD_DENIAL = "FORBIDDEN: no access to discussion thread";

/** A chat session's tool-event and approval room (`subscribe:session`). */
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

/** A scheduled task's progress and status room (`subscribe:task`). */
export const taskRoom = (taskId: string): string => `task:${taskId}`;

/** An analysis run's agent / capability / outcome room (`subscribe:analysis`). */
export const analysisRoom = (analysisId: string): string => `analysis:${analysisId}`;

/** A publish batch's live log room (`subscribe:publish`). */
export const publishRoom = (batchId: string): string => `publish:${batchId}`;

/** #676 — a connector's ingest and test progress room (`subscribe:connector`). */
export const connectorRoom = (connectorId: string): string => `connector:${connectorId}`;

/** #676 — a job's `job:lifecycle` / `job:doc-section` room (`subscribe:job`). */
export const jobRoom = (jobId: string): string => `job:${jobId}`;

/** #676 — a background run's step room (`subscribe:bg-run`). */
export const bgRunRoom = (runId: string): string => `run:${runId}`;

/**
 * #676 — the artifact kinds a presence room can name. A closed set with no `:`
 * in any member, so `presence:{type}:{id}` parses one way only: a free-form
 * type such as `a:b` with id `c` would share a room with type `a`, id `b:c`.
 */
export const PRESENCE_ARTIFACT_TYPES = ["discussion", "spec-kit-artifact"] as const;
export type PresenceArtifactType = (typeof PRESENCE_ARTIFACT_TYPES)[number];

/** #676 — narrow a client-supplied artifact type to a {@link PresenceArtifactType}. */
export const isPresenceArtifactType = (value: unknown): value is PresenceArtifactType =>
  (PRESENCE_ARTIFACT_TYPES as readonly unknown[]).includes(value);

/** Who is viewing an artifact (`presence:join`); `presence:update` echoes it as `room`. */
export const presenceRoom = (artifactType: PresenceArtifactType, artifactId: string): string =>
  `presence:${artifactType}:${artifactId}`;
