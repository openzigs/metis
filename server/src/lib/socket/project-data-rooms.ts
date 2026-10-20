/**
 * #1290 — take a socket out of the join-only rooms that carry a project's data
 * once it may no longer join them.
 *
 * These rooms are judged once, when a socket joins:
 *
 * - `analysis:{id}` — an analysis run's progress and promotion counts
 *   (`canJoinAnalysisRoom`);
 * - `session:{id}` — a chat session's tool events and approval prompts
 *   (`canJoinSessionRoom`);
 * - `connector:{id}` — a connector's ingest and test progress
 *   (`canJoinConnectorRoom`);
 * - `run:{id}` — a background run's steps (`canJoinBgRunRoom`);
 * - `thread:{id}` — a discussion's messages, typing and presence
 *   (`canAccessThread`; joined by `subscribe:thread` and `presence:thread:join`);
 * - `presence:{type}:{id}` — who is viewing a discussion or Spec Kit artifact
 *   (`canJoinPresenceRoom`).
 *
 * So a member removed from the workspace, or anyone on a project or workspace
 * deleted since, kept receiving them until they reconnected. This is the twin
 * of `rejudgeProjectRooms` (#1212) and `rejudgeJobRooms` (#1251), driven from
 * the same places — the member, workspace and project evictions
 * (`project-room-eviction.ts`) with their relays and eviction epoch, and the
 * re-validation pass (`revalidateLocalSockets`) — and it re-judges each room
 * with that room's own join rule, never a second one: whoever the join would
 * admit now stays, everyone else leaves.
 */
import {
  analysisRoom,
  bgRunRoom,
  connectorRoom,
  isPresenceArtifactType,
  sessionRoom,
  threadRoom,
  type AuthPayload,
} from "@metis/shared";
import { canAccessThread } from "../discussions/access.js";
import { createChildLogger } from "../logger.js";
import { canJoinAnalysisRoom } from "./analysis-room-access.js";
import type { RejudgedSocket } from "./project-rooms.js";
import { readEpoch } from "./revocation-relay.js";
import {
  canJoinBgRunRoom,
  canJoinConnectorRoom,
  canJoinPresenceRoom,
  canJoinSessionRoom,
} from "./room-access.js";
import { rememberRoomProject, roomEvicted } from "./room-scope.js";
import type { MetisIOServer } from "./server.js";

const log = createChildLogger("socket:project-data-room");

/** Prefix of every `presence:{type}:{id}` room. */
export const PRESENCE_ROOM_PREFIX = "presence:";

/** One kind of project-data room: its name prefix and its join rule. */
interface ProjectDataRoomKind {
  prefix: string;
  /** The join rule for the id after the prefix. Throws on a database error. */
  allowed(user: AuthPayload, id: string): Promise<boolean>;
}

/**
 * The `subscribe:thread` / `presence:thread:join` rule. The thread's project is
 * recorded here, since `canAccessThread` is not a socket rule of its own.
 */
async function canJoinThreadRoom(user: AuthPayload, threadId: string): Promise<boolean> {
  const access = await canAccessThread({ id: user.userId, role: user.role }, threadId);
  if (access.ok) rememberRoomProject(threadRoom(threadId), access.projectId);
  return access.ok;
}

/** The `presence:join` rule, for the `{type}:{id}` after the prefix. */
function canJoinPresence(user: AuthPayload, typeAndId: string): Promise<boolean> {
  const sep = typeAndId.indexOf(":");
  const artifactType = typeAndId.slice(0, sep);
  if (sep <= 0 || !isPresenceArtifactType(artifactType)) return Promise.resolve(false);
  return canJoinPresenceRoom(user, artifactType, typeAndId.slice(sep + 1));
}

// Each rule is wrapped rather than referenced, so that importing this module
// reads none of them (several suites mock their modules with only the rules
// they drive).
const KINDS: readonly ProjectDataRoomKind[] = [
  { prefix: analysisRoom(""), allowed: (user, id) => canJoinAnalysisRoom(user, id) },
  { prefix: sessionRoom(""), allowed: (user, id) => canJoinSessionRoom(user, id) },
  { prefix: connectorRoom(""), allowed: (user, id) => canJoinConnectorRoom(user, id) },
  { prefix: bgRunRoom(""), allowed: (user, id) => canJoinBgRunRoom(user, id) },
  { prefix: threadRoom(""), allowed: (user, id) => canJoinThreadRoom(user, id) },
  { prefix: PRESENCE_ROOM_PREFIX, allowed: (user, id) => canJoinPresence(user, id) },
];

function kindOf(room: string): { kind: ProjectDataRoomKind; id: string } | null {
  for (const kind of KINDS) {
    if (room.startsWith(kind.prefix) && room.length > kind.prefix.length) {
      return { kind, id: room.slice(kind.prefix.length) };
    }
  }
  return null;
}

/** Whether `room` is one of the project-data rooms this module re-judges. */
export function isProjectDataRoom(room: string): boolean {
  return kindOf(room) !== null;
}

/** The project-data rooms `socket` is in. */
export function projectDataRoomsOf(socket: Pick<RejudgedSocket, "rooms">): string[] {
  return [...socket.rooms].filter(isProjectDataRoom);
}

/**
 * Re-judge the project-data rooms `socket` is in against `user` (the live
 * user), leaving each one its join rule now refuses. `only` limits it to the
 * rooms it accepts. A socket taken out of a room is reported to the room's
 * eviction listeners (`roomEvicted`), so a presence list drops it too.
 *
 * A check that throws keeps the room when failing open (the periodic sweep: a
 * database blip is not evidence of revocation, and the next pass re-judges).
 * Failing closed, it leaves the room AND closes the transport, as
 * `rejudgeProjectRooms` does: the client reconnects and re-subscribes, so a
 * member the error wrongly removed is re-admitted rather than silently left
 * without live updates. Never rejects.
 */
export async function rejudgeProjectDataRooms(
  socket: RejudgedSocket,
  user: AuthPayload,
  opts: { failClosed: boolean; only?: (room: string) => boolean },
): Promise<void> {
  let reconnect = false;
  for (const room of projectDataRoomsOf(socket)) {
    if (opts.only && !opts.only(room)) continue;
    const target = kindOf(room)!;
    let allowed: boolean;
    try {
      allowed = await target.kind.allowed(user, target.id);
    } catch (err) {
      log.warn("Project-data room re-judgement failed", {
        socketId: socket.id,
        room,
        failClosed: opts.failClosed,
        error: (err as Error).message,
      });
      if (!opts.failClosed) continue;
      allowed = false;
      reconnect = true;
    }
    if (allowed) continue;
    try {
      await socket.leave(room);
    } catch (err) {
      log.warn("Socket could not leave a project-data room", {
        socketId: socket.id,
        room,
        error: (err as Error).message,
      });
    }
    roomEvicted(socket, room);
  }
  if (reconnect) socket.conn.close();
}

/** The eviction epoch of the server `socket` belongs to: read before a join's check. */
export function evictionEpochOf(socket: { nsp: { server: MetisIOServer } }): number {
  return readEpoch(socket.nsp.server, "eviction");
}

/**
 * A join whose check was in flight while an eviction ran could not be seen by
 * it: the socket was not yet in the room. `epochBefore` is the eviction epoch
 * read before the check ({@link evictionEpochOf}); once the socket has joined,
 * a moved epoch means an eviction ran in between, so the join is judged again,
 * failing closed — as `subscribe:project` and `subscribe:job` do. Never rejects.
 */
export async function recheckJoinAfterEviction(
  socket: RejudgedSocket & { nsp: { server: MetisIOServer } },
  user: AuthPayload,
  room: string,
  epochBefore: number,
): Promise<void> {
  if (evictionEpochOf(socket) === epochBefore) return;
  await rejudgeProjectDataRooms(socket, user, { failClosed: true, only: (r) => r === room });
}
