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
 *
 * #486 — a reconnect (network blip, or the #414 token-refresh disconnect+connect)
 * drops the socket's rooms on the server. This module owns the one `connect`
 * listener per socket that re-joins them: each room that still has followers is
 * re-joined exactly once, however many hooks follow it, and the server replays
 * its last transition. A join emitted while the socket was down is buffered by
 * socket.io-client and flushed on the next connect, so that room is not joined
 * a second time — which is also why the first connect sends nothing extra.
 */
import type { Socket } from "socket.io-client";

/** The socket surface this module needs; the typed app socket satisfies it. */
type JobRoomSocket = Pick<Socket, "emit" | "on" | "off" | "connected">;

interface SocketRooms {
  /** Followers per job id; a room is present while it has at least one. */
  counts: Map<string, number>;
  /** Rooms whose `subscribe:job` sits in the send buffer until the next connect. */
  buffered: Set<string>;
  onConnect: () => void;
}

const rooms = new WeakMap<JobRoomSocket, SocketRooms>();

function roomsFor(socket: JobRoomSocket): SocketRooms {
  let state = rooms.get(socket);
  if (state) return state;
  const counts = new Map<string, number>();
  const buffered = new Set<string>();
  const onConnect = () => {
    for (const jobId of counts.keys()) {
      if (!buffered.has(jobId)) socket.emit("subscribe:job", { jobId });
    }
    buffered.clear();
  };
  state = { counts, buffered, onConnect };
  rooms.set(socket, state);
  socket.on("connect", onConnect);
  return state;
}

/**
 * Join `job:{jobId}` on `socket` and return a release function. The release is
 * idempotent; the socket leaves the room when the last follower releases.
 */
export function joinJobRoom(socket: JobRoomSocket, jobId: string): () => void {
  const state = roomsFor(socket);
  const { counts, buffered } = state;
  counts.set(jobId, (counts.get(jobId) ?? 0) + 1);
  if (!socket.connected) buffered.add(jobId);
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
    if (counts.size === 0) {
      // Nothing left to re-join; the buffered set only matters for live rooms.
      socket.off("connect", state.onConnect);
      rooms.delete(socket);
    }
  };
}
