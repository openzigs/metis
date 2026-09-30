/**
 * #430 — reference-counted `job:{id}` room membership for the shared socket.
 *
 * Socket.IO rooms are not reference-counted: one `unsubscribe:job` removes the
 * whole socket from the room, cutting off every other hook on the page that
 * follows the same job. Every client-side follower joins through `joinJobRoom`
 * instead of emitting directly, so the socket leaves a room only when its last
 * follower releases it.
 *
 * Each join still emits `subscribe:job`, even when the socket is already in the
 * room: the server replays the job's last transition on every subscribe, and a
 * follower that arrives later needs that replay as much as the first did.
 */
import type { Socket } from "socket.io-client";

/** The two emits this module needs; the typed app socket satisfies it. */
type JobRoomSocket = Pick<Socket, "emit">;

const followers = new WeakMap<JobRoomSocket, Map<string, number>>();

/**
 * Join `job:{jobId}` on `socket` and return a release function. The release is
 * idempotent; the socket leaves the room when the last follower releases.
 */
export function joinJobRoom(socket: JobRoomSocket, jobId: string): () => void {
  let counts = followers.get(socket);
  if (!counts) {
    counts = new Map();
    followers.set(socket, counts);
  }
  counts.set(jobId, (counts.get(jobId) ?? 0) + 1);
  socket.emit("subscribe:job", { jobId });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (counts.get(jobId) ?? 1) - 1;
    if (remaining > 0) {
      counts.set(jobId, remaining);
      return;
    }
    counts.delete(jobId);
    socket.emit("unsubscribe:job", { jobId });
  };
}
