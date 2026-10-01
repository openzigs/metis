/**
 * Epic #728 / Issue #732 — Socket.IO presence rooms per artifact.
 *
 * Rooms are ephemeral (in-memory, no DB persistence), and per replica: with
 * the cluster adapter (#622) a viewer sees only the users connected to the same
 * replica, because `presence:update` is emitted locally (see below).
 *
 * Client events:
 *   `presence:join`  { artifactType: PresenceArtifactType, artifactId: string }
 *     → joins room `presence:{artifactType}:{artifactId}`; an artifact type
 *       outside `PRESENCE_ARTIFACT_TYPES` is ignored, so no free-form type can
 *       make two `type:id` pairs share a room (#676)
 *     → broadcasts `presence:update` with current user list to the room
 *
 *   `presence:leave` { artifactType: PresenceArtifactType, artifactId: string }
 *     → leaves room, broadcasts updated list
 *
 *   disconnect
 *     → leaves all presence rooms for that socket, broadcasts updates
 */
import { isPresenceArtifactType, presenceRoom } from "@metis/shared";
import type { MetisIOServer } from "../socket/server.js";
import { onClientEvent, onConnection } from "../socket/client-event-handler.js";

/** In-memory map: room key → Set of socket.data.user descriptors. */
const roomPresence = new Map<
  string,
  Map<string, { userId: string; username: string; displayName: string }>
>();

/** #672 — shared with the UI, which reference-counts followers by this name. */
const roomKey = presenceRoom;

/**
 * #622 — `local`: the list is THIS replica's sockets only, and the client
 * replaces its whole list with each update, so relaying it through the cluster
 * adapter would make every viewer's avatars flip between replicas' partial
 * lists. Kept per-replica (the pre-adapter behaviour) until presence state is
 * shared across replicas (#651).
 */
function broadcastPresenceUpdate(io: MetisIOServer, key: string): void {
  const users = [...(roomPresence.get(key)?.values() ?? [])];
  io.local.to(key).emit("presence:update", { room: key, users, ts: Date.now() });
}

export function wirePresenceHandlers(io: MetisIOServer): void {
  onConnection(io, (socket) => {
    const user = socket.data.user;
    /** Tracks which presence rooms this socket has joined. */
    const joinedRooms = new Set<string>();

    // #654 — the payload is read with `?.`, never destructured: a null or
    // missing payload rejected the handler's promise and crashed the process.
    onClientEvent(
      socket,
      "presence:join",
      async (payload?: { artifactType?: unknown; artifactId?: unknown } | null) => {
        const artifactType = payload?.artifactType;
        const artifactId = payload?.artifactId;
        if (!isPresenceArtifactType(artifactType) || typeof artifactId !== "string") return;
        // Cap rooms per socket to prevent unbounded growth.
        if (joinedRooms.size >= 50) {
          socket.emit("presence:error", { message: "Maximum room limit reached" });
          return;
        }
        const key = roomKey(artifactType, artifactId);
        await socket.join(key);
        joinedRooms.add(key);
        if (!roomPresence.has(key)) roomPresence.set(key, new Map());
        roomPresence.get(key)!.set(socket.id, {
          userId: user.userId,
          username: user.username,
          displayName: user.username,
        });
        broadcastPresenceUpdate(io, key);
      },
    );

    onClientEvent(
      socket,
      "presence:leave",
      async (payload?: { artifactType?: unknown; artifactId?: unknown } | null) => {
        const artifactType = payload?.artifactType;
        const artifactId = payload?.artifactId;
        if (!isPresenceArtifactType(artifactType) || typeof artifactId !== "string") return;
        const key = roomKey(artifactType, artifactId);
        await socket.leave(key);
        joinedRooms.delete(key);
        roomPresence.get(key)?.delete(socket.id);
        broadcastPresenceUpdate(io, key);
        if ((roomPresence.get(key)?.size ?? 0) === 0) roomPresence.delete(key);
      },
    );

    onClientEvent(socket, "disconnect", () => {
      for (const key of joinedRooms) {
        roomPresence.get(key)?.delete(socket.id);
        broadcastPresenceUpdate(io, key);
        if ((roomPresence.get(key)?.size ?? 0) === 0) roomPresence.delete(key);
      }
      joinedRooms.clear();
    });
  });
}

/** Exposed for testing: inspect presence map state. */
export function getRoomPresence(): Map<
  string,
  Map<string, { userId: string; username: string; displayName: string }>
> {
  return roomPresence;
}

/** Exposed for testing: reset state. */
export function clearPresenceState(): void {
  roomPresence.clear();
}
