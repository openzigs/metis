/**
 * #1212 — the `project:{id}` room: who may join it, and the re-judgement that
 * takes a socket out once it may not.
 *
 * The room carries the project's live job, document, connector, usage,
 * background-run and drift events, so joining it takes the rule of
 * `GET /projects/:id` (`canJoinProjectRoom` → `assertProjectAccess`): admins,
 * live members of the project's workspace, and anyone for a legacy project with
 * no workspace. It used to be the creator-only `actorCanAccessProject`.
 *
 * A join is judged once, so every change that can revoke it re-judges the
 * sockets already in the room with the same rule (`rejudgeProjectRooms`): a
 * member removed or a workspace deleted (`project-room-eviction.ts`), a legacy
 * project assigned to a workspace (`evictProjectRoom`), and the re-validation
 * pass (`revalidateLocalSockets`), which catches a relay another replica lost.
 *
 * Kept apart from `server.ts` so the handler can be driven in-process with a
 * fake socket, without a TCP handshake (#1379).
 */
import type { Socket } from "socket.io";
import {
  projectRoom,
  type AuthPayload,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { onClientEvent } from "./client-event-handler.js";
import { onRoomJoin, roomFromField } from "./join-rate-limit.js";
import { canJoinProjectRoom } from "./room-access.js";
import { readEpoch } from "./revocation-relay.js";
import type { MetisIOServer } from "./server.js";

const log = createChildLogger("socket:project-room");

/** The one refusal for a project room, whatever the cause: no existence oracle. */
export const PROJECT_ROOM_DENIAL = "FORBIDDEN: no access to project";

/** Prefix of every `project:{id}` room. */
export const PROJECT_ROOM_PREFIX = projectRoom("");

/** The minimal socket surface the project-room handlers depend on. */
export type ProjectRoomSocket = Pick<
  Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: AuthPayload }>,
  "id" | "on" | "join" | "leave" | "emit" | "data" | "rooms"
> & { nsp: { server: MetisIOServer } };

/** The socket surface a re-judgement needs. */
export type RejudgedSocket = Pick<ProjectRoomSocket, "id" | "rooms" | "leave"> & {
  conn: { close(): void };
};

/** Leave `room`, logging rather than throwing, so the caller always goes on. */
async function leaveQuietly(socket: Pick<ProjectRoomSocket, "id" | "leave">, room: string) {
  try {
    await socket.leave(room);
  } catch (err) {
    log.warn("Socket could not leave a project room", {
      socketId: socket.id,
      room,
      error: (err as Error).message,
    });
  }
}

/** `canJoinProjectRoom`, retried once when it throws (a transient database error). */
async function judgeWithRetry(user: AuthPayload, projectId: string, socketId: string) {
  try {
    return await canJoinProjectRoom(user, projectId);
  } catch (err) {
    log.warn("Socket subscribe:project access check failed — retrying once", {
      socketId,
      projectId,
      error: (err as Error).message,
    });
    return canJoinProjectRoom(user, projectId);
  }
}

/**
 * Attach `subscribe:project` / `unsubscribe:project` to `socket`.
 *
 * - A refused join gets {@link PROJECT_ROOM_DENIAL}, whether the project is
 *   unknown, forbidden or soft-deleted, and a socket already in the room leaves.
 * - A check that still throws after one retry is not evidence of revocation: a
 *   socket already in the room keeps it (a real revocation reaches it through
 *   eviction or the re-validation pass) and a new join is refused.
 * - The eviction epoch is read before the check. When it has moved by the time
 *   the socket is in the room, an eviction ran while the check was in flight
 *   and could not see this socket, so the check is repeated; that repeat fails
 *   closed.
 */
export function wireProjectRoomHandlers(socket: ProjectRoomSocket): void {
  const user = socket.data.user;
  onRoomJoin(socket, "subscribe:project", roomFromField("projectId", projectRoom), (payload) => {
    const projectId: unknown = payload?.projectId;
    if (!projectId || typeof projectId !== "string") return;
    const room = projectRoom(projectId);
    const refuse = (): void => {
      socket.emit("auth:error", { message: PROJECT_ROOM_DENIAL });
    };
    return (async () => {
      const wasIn = socket.rooms.has(room);
      const evictionEpoch = readEpoch(socket.nsp.server, "eviction");
      let allowed: boolean;
      try {
        allowed = await judgeWithRetry(user, projectId, socket.id);
      } catch (err) {
        log.warn("Socket subscribe:project failed", {
          socketId: socket.id,
          projectId,
          keptInRoom: wasIn,
          error: (err as Error).message,
        });
        if (!wasIn) refuse();
        return;
      }
      if (!allowed) {
        log.warn("Socket subscribe:project rejected — no project access", {
          socketId: socket.id,
          userId: user.userId,
          projectId,
        });
        await leaveQuietly(socket, room);
        refuse();
        return;
      }
      await socket.join(room);
      if (readEpoch(socket.nsp.server, "eviction") === evictionEpoch) return;
      let stillAllowed = false;
      try {
        stillAllowed = await judgeWithRetry(user, projectId, socket.id);
      } catch (err) {
        log.warn("Socket subscribe:project re-check failed — leaving the room", {
          socketId: socket.id,
          projectId,
          error: (err as Error).message,
        });
      }
      if (!stillAllowed) {
        await leaveQuietly(socket, room);
        refuse();
      }
    })();
  });
  onClientEvent(socket, "unsubscribe:project", (payload) => {
    const projectId: unknown = payload?.projectId;
    if (!projectId || typeof projectId !== "string") return;
    return socket.leave(projectRoom(projectId));
  });
}

/**
 * Re-judge the project rooms `socket` is in against `user` (the live user),
 * leaving each one the rule now refuses. `only` limits it to one room.
 *
 * A check that throws keeps the room when failing open (the periodic sweep,
 * where a database blip is not evidence of revocation and the next pass
 * re-judges). Failing closed, it leaves the room AND closes the transport, as
 * the #649 `listen` pass does: the client reconnects and re-subscribes from
 * live state (`keepRoomSubscribed`), so a member the error wrongly removed is
 * re-admitted rather than silently left without live updates. Never rejects.
 */
export async function rejudgeProjectRooms(
  socket: RejudgedSocket,
  user: AuthPayload,
  opts: { failClosed: boolean; only?: string },
): Promise<void> {
  const rooms = [...socket.rooms].filter(
    (room) => room.startsWith(PROJECT_ROOM_PREFIX) && (!opts.only || room === opts.only),
  );
  let reconnect = false;
  for (const room of rooms) {
    const projectId = room.slice(PROJECT_ROOM_PREFIX.length);
    let allowed: boolean;
    try {
      allowed = await canJoinProjectRoom(user, projectId, "socket.project_room.revalidate");
    } catch (err) {
      log.warn("Project room re-judgement failed", {
        socketId: socket.id,
        room,
        failClosed: opts.failClosed,
        error: (err as Error).message,
      });
      if (!opts.failClosed) continue;
      allowed = false;
      reconnect = true;
    }
    if (!allowed) await leaveQuietly(socket, room);
  }
  if (reconnect) socket.conn.close();
}
