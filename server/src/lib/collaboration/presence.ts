/**
 * Epic #728 / Issue #732 — Socket.IO presence rooms per artifact.
 *
 * Rooms are ephemeral (in-memory, no DB persistence).
 *
 * Client events:
 *   `presence:join`  { artifactType: string, artifactId: string }
 *     → joins room `presence:{artifactType}:{artifactId}`
 *     → broadcasts `presence:update` with current user list to the room
 *
 *   `presence:leave` { artifactType: string, artifactId: string }
 *     → leaves room, broadcasts updated list
 *
 *   disconnect
 *     → leaves all presence rooms for that socket, broadcasts updates
 */
import type { MetisIOServer } from "../socket/server.js";

/** In-memory map: room key → Set of socket.data.user descriptors. */
const roomPresence = new Map<
  string,
  Map<string, { userId: string; username: string; displayName: string }>
>();

function roomKey(artifactType: string, artifactId: string): string {
  return `presence:${artifactType}:${artifactId}`;
}

function broadcastPresenceUpdate(io: MetisIOServer, key: string): void {
  const users = [...(roomPresence.get(key)?.values() ?? [])];
  io.to(key).emit("presence:update", { room: key, users, ts: Date.now() });
}

export function wirePresenceHandlers(io: MetisIOServer): void {
  io.on("connection", (socket) => {
    const user = socket.data.user;
    /** Tracks which presence rooms this socket has joined. */
    const joinedRooms = new Set<string>();

    socket.on(
      "presence:join",
      async ({ artifactType, artifactId }: { artifactType?: unknown; artifactId?: unknown }) => {
        if (typeof artifactType !== "string" || typeof artifactId !== "string") return;
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

    socket.on(
      "presence:leave",
      async ({ artifactType, artifactId }: { artifactType?: unknown; artifactId?: unknown }) => {
        if (typeof artifactType !== "string" || typeof artifactId !== "string") return;
        const key = roomKey(artifactType, artifactId);
        await socket.leave(key);
        joinedRooms.delete(key);
        roomPresence.get(key)?.delete(socket.id);
        broadcastPresenceUpdate(io, key);
        if ((roomPresence.get(key)?.size ?? 0) === 0) roomPresence.delete(key);
      },
    );

    socket.on("disconnect", () => {
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
