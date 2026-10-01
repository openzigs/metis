/**
 * Epic #475 (Phase 2, #482) — per-thread presence + typing indicators.
 *
 * Ephemeral (in-memory, no DB persistence; each replica holds its own sockets'
 * entries, and with the cluster adapter every list is merged from every replica,
 * #651 — `cluster-presence.ts`), modelled on the artifact-presence
 * pattern in `../collaboration/presence.ts` but **authz-gated**: a client may
 * only appear in (or observe) a thread's presence if `canAccessThread` passes,
 * so you cannot watch who is in a thread you have no access to (the AC for
 * #482). Presence and typing both scope to the thread's realtime room
 * `thread:{id}` (the same room #480 joins), addressed via `threadRoom(id)`.
 *
 * Client events (see `ClientToServerEvents`):
 *   `presence:thread:join`  { threadId } → authz-check, join room, add to the
 *     presence set, broadcast `presence:update` (current member list) to room.
 *   `presence:thread:leave` { threadId } → remove from set, broadcast update.
 *   `typing:start` / `typing:stop` { threadId } → broadcast `typing:update` to
 *     OTHER room members only (never echoed to the sender); honored only for a
 *     socket already present in the thread (i.e. it passed authz on join).
 *   disconnect → remove the socket from every thread it was present in and
 *     rebroadcast; empty presence sets are cleaned up.
 *
 * Extracted into its own module (with an injectable access checker) so the
 * authz + presence/typing branches are unit-testable against a fake socket
 * without a live Socket.IO server.
 */
import type { Socket } from "socket.io";
import type {
  AuthPayload,
  ClientToServerEvents,
  ServerToClientEvents,
  RoleKey,
} from "@metis/shared";
import { canAccessThread as defaultCanAccessThread } from "../discussions/access.js";
import { THREAD_DENIAL, threadRoom } from "./discussion-rooms.js";
import { createChildLogger } from "../logger.js";
import { onClientEvent, runDetached } from "./client-event-handler.js";
import { createClusterPresence, type PresenceMember } from "./cluster-presence.js";
import type { MetisIOServer } from "./server.js";
import { onRoomJoin, roomFromField } from "./join-rate-limit.js";

const log = createChildLogger("socket:thread-presence");

export type { PresenceMember };

/**
 * In-memory presence: thread room key → (socket.id → member). Keyed by socket
 * id (not user id) so the same user on two tabs is counted per-connection and a
 * disconnect of one tab does not evict the other.
 */
type PresenceMap = Map<string, Map<string, PresenceMember>>;

/**
 * One Socket.IO server's thread presence: its members, and how a change in a
 * room reaches that room's viewers.
 */
export interface ThreadPresence {
  members: PresenceMap;
  /**
   * Re-list `room` to its viewers after `origin` joined or left it. Only the
   * socket-less default (`defaultPresence`, one replica, the fake-socket unit
   * tests) sends through `origin`; a server's presence (`createThreadPresence`)
   * emits to the room's sockets through `io.local` and ignores it — so a socket
   * that has just left the room is no longer sent the list.
   */
  changed(room: string, origin: PresenceSocket): void;
}

/**
 * #651 — the thread presence of `io`, built once per server by
 * `createSocketServer`: with the cluster adapter (`clustered`) every list is
 * merged from every replica, and re-merged whenever the adapter's `LISTEN`
 * connection is re-established (`onAdapterListening`); without it, this
 * replica's list.
 */
export function createThreadPresence(
  io: MetisIOServer,
  clustered: boolean,
  onAdapterListening?: (listener: () => void) => void,
): ThreadPresence {
  const members: PresenceMap = new Map();
  const presence = createClusterPresence(io, {
    kind: "thread",
    clustered,
    localMembers: (room) => membersOf(members, room),
    onAdapterListening,
  });
  return { members, changed: (room) => presence.changed(room) };
}

/**
 * The default when no server's presence is injected (the fake-socket unit
 * tests): one replica, the list sent through the socket.
 */
const defaultPresence: ThreadPresence = {
  members: new Map(),
  changed: (room, socket) => broadcastPresence(defaultPresence.members, socket, room),
};

/** The minimal socket surface the presence/typing handlers depend on. */
export type PresenceSocket = Pick<
  Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: AuthPayload }>,
  "id" | "on" | "join" | "leave" | "emit" | "to" | "data"
>;

type AccessChecker = (
  actor: { id: string; role: RoleKey },
  threadId: string,
) => Promise<{ ok: boolean }>;

/** Snapshot the current members of a thread room. */
function membersOf(members: PresenceMap, room: string): PresenceMember[] {
  return [...(members.get(room)?.values() ?? [])];
}

/** Broadcast the current member list of `room` to everyone in it. */
function broadcastPresence(members: PresenceMap, socket: PresenceSocket, room: string): void {
  // Emit to the room INCLUDING the sender via socket.to + a self-emit, so a
  // newly-joined member sees themselves. `socket.to(room)` excludes the sender,
  // so we additionally emit to the sender directly.
  // `local` (#622): the list is this replica's members only, and a client
  // replaces its list with each update. Typing events stay cluster-wide.
  const payload = { room, users: membersOf(members, room), ts: Date.now() };
  socket.to(room).local.emit("presence:update", payload);
  socket.emit("presence:update", payload);
}

export interface WireDiscussionPresenceOptions {
  /** Injectable for tests; defaults to the shared `canAccessThread`. */
  canAccessThread?: AccessChecker;
  /** #651 — the server's presence (`createThreadPresence`); defaults to one local replica. */
  presence?: ThreadPresence;
}

/**
 * Attach per-thread presence + typing handlers to `socket`.
 */
export function wireDiscussionPresenceHandlers(
  socket: PresenceSocket,
  opts: WireDiscussionPresenceOptions = {},
): void {
  const user = socket.data.user;
  const access = opts.canAccessThread ?? (defaultCanAccessThread as AccessChecker);
  const presence = opts.presence ?? defaultPresence;
  const threadPresence = presence.members;
  /** Thread rooms this socket is currently present in. */
  const joined = new Set<string>();

  onRoomJoin(socket, "presence:thread:join", roomFromField("threadId", threadRoom), (payload) => {
    const threadId: unknown = payload?.threadId;
    if (!threadId || typeof threadId !== "string") return;
    return (async () => {
      try {
        const result = await access({ id: user.userId, role: user.role as RoleKey }, threadId);
        if (!result.ok) {
          socket.emit("auth:error", { message: THREAD_DENIAL, room: threadRoom(threadId) });
          return;
        }
        const room = threadRoom(threadId);
        await socket.join(room);
        joined.add(room);
        if (!threadPresence.has(room)) threadPresence.set(room, new Map());
        threadPresence.get(room)!.set(socket.id, {
          userId: user.userId,
          username: user.username,
          displayName: user.username,
        });
        presence.changed(room, socket);
      } catch (err) {
        log.warn("presence:thread:join failed", {
          socketId: socket.id,
          threadId,
          error: (err as Error).message,
        });
        socket.emit("auth:error", { message: THREAD_DENIAL, room: threadRoom(threadId) });
      }
    })();
  });

  onClientEvent(socket, "presence:thread:leave", (payload) => {
    const threadId: unknown = payload?.threadId;
    if (!threadId || typeof threadId !== "string") return;
    const room = threadRoom(threadId);
    runDetached(socket.leave(room), "presence:thread:leave", socket.id);
    joined.delete(room);
    removeFromRoom(threadPresence, room, socket.id);
    presence.changed(room, socket);
  });

  const broadcastTyping = (threadId: unknown, isTyping: boolean): void => {
    if (!threadId || typeof threadId !== "string") return;
    const room = threadRoom(threadId);
    // Only members already present in the thread (i.e. they passed authz on
    // join) may emit typing — prevents a non-member from spraying typing events
    // into a room they never joined.
    if (!joined.has(room)) return;
    socket.to(room).emit("typing:update", {
      threadId,
      userId: user.userId,
      username: user.username,
      isTyping,
      ts: Date.now(),
    });
  };

  onClientEvent(socket, "typing:start", (payload) => broadcastTyping(payload?.threadId, true));
  onClientEvent(socket, "typing:stop", (payload) => broadcastTyping(payload?.threadId, false));

  onClientEvent(socket, "disconnect", () => {
    for (const room of joined) {
      removeFromRoom(threadPresence, room, socket.id);
      presence.changed(room, socket);
    }
    joined.clear();
  });
}

/** Remove a socket from a room's presence set, cleaning up empty rooms. */
function removeFromRoom(threadPresence: PresenceMap, room: string, socketId: string): void {
  const set = threadPresence.get(room);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) threadPresence.delete(room);
}

/** Exposed for testing: inspect the default presence map. */
export function getThreadPresence(): PresenceMap {
  return defaultPresence.members;
}

/** Exposed for testing: reset the default presence state between tests. */
export function clearThreadPresence(): void {
  defaultPresence.members.clear();
}
