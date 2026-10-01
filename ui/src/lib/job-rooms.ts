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
 *
 * Known window (#510, from socket.io-client 4.8.3 `build/esm/socket.js:262`):
 * after the ping times out but before the client notices, `connected` still
 * reads true, so a join made then is buffered without being recorded in
 * `buffered`. The next connect flushes it AND re-joins the room, so the server
 * sees one duplicate `subscribe:job`. That is harmless — the join is idempotent
 * and the replay (lifecycle plus each section's latest state) is too — and rare.
 *
 * #655 — the server authorizes each join and refuses one it cannot scope with
 * an `auth:error` naming the room. Some jobs have no database row, so after a
 * server restart (or once the job falls out of the server's scope memory) every
 * re-subscribe of a job this socket still follows is refused. A refused room is
 * dropped from the follow set here: it is not re-subscribed on later connects,
 * and its followers' releases become no-ops. The socket client does not show a
 * room-scoped refusal to the user (`socket-client.ts`); a follower that waits
 * for a replay (`useFollowJobs`) forgets the job when none arrives.
 */
import type { Socket } from "socket.io-client";
import type { SocketAuthErrorEvent } from "@metis/shared";

/** The socket surface this module needs; the typed app socket satisfies it. */
type JobRoomSocket = Pick<Socket, "emit" | "on" | "off" | "connected">;

/** One followed room; replaced, not reused, when a room is dropped and re-joined. */
interface Follow {
  count: number;
}

interface SocketRooms {
  /** Followers per job id; a room is present while it has at least one. */
  follows: Map<string, Follow>;
  /** Rooms whose `subscribe:job` sits in the send buffer until the next connect. */
  buffered: Set<string>;
  onConnect: () => void;
  onAuthError: (data: SocketAuthErrorEvent) => void;
}

const JOB_ROOM_PREFIX = "job:";

const rooms = new WeakMap<JobRoomSocket, SocketRooms>();

function detach(socket: JobRoomSocket, state: SocketRooms): void {
  socket.off("connect", state.onConnect);
  socket.off("auth:error", state.onAuthError);
  rooms.delete(socket);
}

function roomsFor(socket: JobRoomSocket): SocketRooms {
  const existing = rooms.get(socket);
  if (existing) return existing;
  const follows = new Map<string, Follow>();
  const buffered = new Set<string>();
  const onConnect = () => {
    for (const jobId of follows.keys()) {
      if (!buffered.has(jobId)) socket.emit("subscribe:job", { jobId });
    }
    buffered.clear();
  };
  const state: SocketRooms = {
    follows,
    buffered,
    onConnect,
    onAuthError: (data) => {
      const room = data?.room;
      if (!room?.startsWith(JOB_ROOM_PREFIX)) return;
      const jobId = room.slice(JOB_ROOM_PREFIX.length);
      if (!follows.delete(jobId)) return;
      if (follows.size === 0) detach(socket, state);
    },
  };
  rooms.set(socket, state);
  socket.on("connect", onConnect);
  socket.on("auth:error", state.onAuthError);
  return state;
}

/**
 * Join `job:{jobId}` on `socket` and return a release function. The release is
 * idempotent; the socket leaves the room when the last follower releases. A
 * room the server refused has already been dropped, so its release does nothing.
 */
export function joinJobRoom(socket: JobRoomSocket, jobId: string): () => void {
  const state = roomsFor(socket);
  const { follows, buffered } = state;
  let follow = follows.get(jobId);
  if (!follow) {
    follow = { count: 0 };
    follows.set(jobId, follow);
  }
  follow.count += 1;
  if (!socket.connected) buffered.add(jobId);
  socket.emit("subscribe:job", { jobId });

  const mine = follow;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Dropped after a refusal (and perhaps followed afresh since): not ours.
    if (follows.get(jobId) !== mine) return;
    mine.count -= 1;
    if (mine.count > 0) return;
    follows.delete(jobId);
    socket.emit("unsubscribe:job", { jobId });
    // Nothing left to re-join; the buffered set only matters for live rooms.
    if (follows.size === 0) detach(socket, state);
  };
}
