/**
 * Epic #475 (Phase 2, #482) — per-thread presence + typing indicators.
 *
 * Ephemeral (in-memory, no DB persistence), modelled on the artifact-presence
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
import { threadRoom } from "./discussion-rooms.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket:thread-presence");

/** A present member of a thread room. */
export interface PresenceMember {
  userId: string;
  username: string;
  displayName: string;
}

/**
 * In-memory presence: thread room key → (socket.id → member). Keyed by socket
 * id (not user id) so the same user on two tabs is counted per-connection and a
 * disconnect of one tab does not evict the other.
 */
const threadPresence = new Map<string, Map<string, PresenceMember>>();

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
function membersOf(room: string): PresenceMember[] {
  return [...(threadPresence.get(room)?.values() ?? [])];
}

/** Broadcast the current member list of `room` to everyone in it. */
function broadcastPresence(socket: PresenceSocket, room: string): void {
  // Emit to the room INCLUDING the sender via socket.to + a self-emit, so a
  // newly-joined member sees themselves. `socket.to(room)` excludes the sender,
  // so we additionally emit to the sender directly.
  const payload = { room, users: membersOf(room), ts: Date.now() };
  socket.to(room).emit("presence:update", payload);
  socket.emit("presence:update", payload);
}

export interface WireDiscussionPresenceOptions {
  /** Injectable for tests; defaults to the shared `canAccessThread`. */
  canAccessThread?: AccessChecker;
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
  /** Thread rooms this socket is currently present in. */
  const joined = new Set<string>();

  socket.on("presence:thread:join", ({ threadId }) => {
    if (!threadId || typeof threadId !== "string") return;
    void (async () => {
      try {
        const result = await access({ id: user.userId, role: user.role as RoleKey }, threadId);
        if (!result.ok) {
          socket.emit("auth:error", {
            message: "FORBIDDEN: no access to discussion thread",
          });
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
        broadcastPresence(socket, room);
      } catch (err) {
        log.warn("presence:thread:join failed", {
          socketId: socket.id,
          threadId,
          error: (err as Error).message,
        });
        socket.emit("auth:error", { message: "FORBIDDEN: no access to discussion thread" });
      }
    })();
  });

  socket.on("presence:thread:leave", ({ threadId }) => {
    if (!threadId || typeof threadId !== "string") return;
    const room = threadRoom(threadId);
    void socket.leave(room);
    joined.delete(room);
    removeFromRoom(room, socket.id);
    broadcastPresence(socket, room);
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

  socket.on("typing:start", ({ threadId }) => broadcastTyping(threadId, true));
  socket.on("typing:stop", ({ threadId }) => broadcastTyping(threadId, false));

  socket.on("disconnect", () => {
    for (const room of joined) {
      removeFromRoom(room, socket.id);
      broadcastPresence(socket, room);
    }
    joined.clear();
  });
}

/** Remove a socket from a room's presence set, cleaning up empty rooms. */
function removeFromRoom(room: string, socketId: string): void {
  const set = threadPresence.get(room);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) threadPresence.delete(room);
}

/** Exposed for testing: inspect the presence map. */
export function getThreadPresence(): Map<string, Map<string, PresenceMember>> {
  return threadPresence;
}

/** Exposed for testing: reset presence state between tests. */
export function clearThreadPresence(): void {
  threadPresence.clear();
}
