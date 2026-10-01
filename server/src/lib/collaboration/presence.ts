/**
 * Epic #728 / Issue #732 — Socket.IO presence rooms per artifact.
 *
 * Rooms are ephemeral (in-memory, no DB persistence). Each replica holds its
 * own sockets' entries; with the cluster adapter (#622) every `presence:update`
 * carries the members on EVERY replica (#651, `socket/cluster-presence.ts`).
 *
 * Client events:
 *   `presence:join`  { artifactType: PresenceArtifactType, artifactId: string }
 *     → joins room `presence:{artifactType}:{artifactId}`; an artifact type
 *       outside `PRESENCE_ARTIFACT_TYPES` is ignored, so no free-form type can
 *       make two `type:id` pairs share a room (#676)
 *     → only if the user could read the artifact through REST
 *       (`canJoinPresenceRoom`, #679); otherwise `auth:error { message, room }`,
 *       the same for an unknown id, a forbidden one and a failed lookup; a
 *       refused socket already in the room is removed from it as on a leave
 *     → broadcasts `presence:update` with the cluster-wide user list to the room
 *
 *   `presence:leave` { artifactType: PresenceArtifactType, artifactId: string }
 *     → leaves room (or drops a join still being checked), broadcasts updated list
 *
 *   disconnect
 *     → leaves all presence rooms for that socket, broadcasts updates
 */
import { isPresenceArtifactType, presenceRoom } from "@metis/shared";
import type { MetisIOServer } from "../socket/server.js";
import { onClientEvent, onConnection } from "../socket/client-event-handler.js";
import { canJoinPresenceRoom } from "../socket/room-access.js";
import { createClusterPresence, type PresenceMember } from "../socket/cluster-presence.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket:presence");

/**
 * #679 — one refusal for every reason, naming the room: the UI re-joins
 * presence rooms on its own after a reconnect, so a room-scoped refusal is
 * dropped by its follower rather than toasted (`SocketAuthErrorEvent`).
 */
const PRESENCE_DENIAL = "FORBIDDEN: no access to artifact";

/** In-memory map: room key → Set of socket.data.user descriptors. */
const roomPresence = new Map<string, Map<string, PresenceMember>>();

/** #672 — shared with the UI, which reference-counts followers by this name. */
const roomKey = presenceRoom;

export interface WirePresenceOptions {
  /**
   * #651 — the server runs the cluster adapter: each list is merged from every
   * replica. Omitted, the list is this replica's alone (one replica).
   */
  clustered?: boolean;
}

export function wirePresenceHandlers(io: MetisIOServer, opts: WirePresenceOptions = {}): void {
  const presence = createClusterPresence(io, {
    kind: "artifact",
    clustered: opts.clustered ?? false,
    localMembers: (key) => [...(roomPresence.get(key)?.values() ?? [])],
  });

  onConnection(io, (socket) => {
    const user = socket.data.user;
    /** Tracks which presence rooms this socket has joined. */
    const joinedRooms = new Set<string>();
    /**
     * #679 — joins whose access check is still running, by room. A leave or a
     * disconnect drops the entry, so a check that resolves afterwards does not
     * join (a disconnected socket would otherwise linger in the list).
     */
    const pendingJoins = new Map<string, number>();
    let joinSeq = 0;

    /** Leaves `key` and broadcasts the shorter list to the viewers who remain. */
    async function leaveRoom(key: string): Promise<void> {
      await socket.leave(key);
      joinedRooms.delete(key);
      roomPresence.get(key)?.delete(socket.id);
      presence.changed(key);
      if ((roomPresence.get(key)?.size ?? 0) === 0) roomPresence.delete(key);
    }

    // #654 — the payload is read with `?.`, never destructured: a null or
    // missing payload rejected the handler's promise and crashed the process.
    onClientEvent(
      socket,
      "presence:join",
      async (payload?: { artifactType?: unknown; artifactId?: unknown } | null) => {
        const artifactType = payload?.artifactType;
        const artifactId = payload?.artifactId;
        if (!isPresenceArtifactType(artifactType) || typeof artifactId !== "string") return;
        // Cap rooms per socket to prevent unbounded growth; a join still being
        // checked counts, or a burst could pass the cap during the check.
        if (joinedRooms.size + pendingJoins.size >= 50) {
          socket.emit("presence:error", { message: "Maximum room limit reached" });
          return;
        }
        const key = roomKey(artifactType, artifactId);
        const attempt = ++joinSeq;
        pendingJoins.set(key, attempt);
        let allowed = false;
        try {
          allowed = await canJoinPresenceRoom(user, artifactType, artifactId);
        } catch (err) {
          log.warn("Socket presence access check failed", {
            socketId: socket.id,
            room: key,
            error: (err as Error).message,
          });
        }
        if (pendingJoins.get(key) !== attempt) return;
        pendingJoins.delete(key);
        if (!allowed) {
          // A socket already in the room (access revoked since it joined) is
          // taken out of it, or it would keep receiving `presence:update` and
          // stay on everyone's list while its UI follower drops the room.
          if (joinedRooms.has(key)) await leaveRoom(key);
          socket.emit("auth:error", { message: PRESENCE_DENIAL, room: key });
          return;
        }
        await socket.join(key);
        joinedRooms.add(key);
        if (!roomPresence.has(key)) roomPresence.set(key, new Map());
        roomPresence.get(key)!.set(socket.id, {
          userId: user.userId,
          username: user.username,
          displayName: user.username,
        });
        presence.changed(key);
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
        pendingJoins.delete(key);
        await leaveRoom(key);
      },
    );

    onClientEvent(socket, "disconnect", () => {
      pendingJoins.clear();
      for (const key of joinedRooms) {
        roomPresence.get(key)?.delete(socket.id);
        presence.changed(key);
        if ((roomPresence.get(key)?.size ?? 0) === 0) roomPresence.delete(key);
      }
      joinedRooms.clear();
    });
  });
}

/** Exposed for testing: inspect presence map state. */
export function getRoomPresence(): Map<string, Map<string, PresenceMember>> {
  return roomPresence;
}

/** Exposed for testing: reset state. */
export function clearPresenceState(): void {
  roomPresence.clear();
}
