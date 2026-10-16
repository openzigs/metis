/**
 * #1212 — take already-subscribed sockets out of `project:{id}` rooms once they
 * lose the right to them.
 *
 * `subscribe:project` admits every member of the project's workspace, and
 * anyone for a legacy project with no workspace (`canJoinProjectRoom`), but it
 * judges a socket only when it joins. Three writes can revoke a join, and the
 * routes call these right after each one commits:
 *
 * - a member removed from a workspace → `evictMemberProjectRooms`: that user's
 *   sockets re-judge every project room they are in. No project lookup is
 *   needed, so a database error cannot skip the eviction; a re-judgement that
 *   throws leaves the room (fail closed — the member rejoins on their next
 *   subscribe).
 * - a workspace deleted → `evictWorkspaceProjectRooms`: every socket leaves its
 *   projects' rooms. If the project lookup fails, every local socket's project
 *   rooms are re-judged instead, fail closed.
 * - a legacy project assigned to a workspace → `evictProjectRoom`: the room is
 *   re-judged in place. Members of the new workspace stay subscribed (their UI
 *   never re-subscribes on its own, so evicting them would silently stop their
 *   live updates); everyone else leaves.
 *
 * Shape (from #588's `mcp-status-eviction.ts`): each bumps the shared
 * `eviction` epoch FIRST (#613), so a `subscribe:project` whose check is in
 * flight re-checks once it has joined; and each is relayed to every other
 * replica (#622), which bumps its own epoch and repeats the work on its local
 * sockets. A relay that is lost is caught by the re-validation pass
 * (`revalidateLocalSockets`), which re-judges every project room too.
 *
 * Best-effort: these run after the database write committed, so nothing here
 * throws into the route.
 */
import { projectRoom } from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { runDetached } from "./client-event-handler.js";
import { rejudgeProjectRooms } from "./project-rooms.js";
import { getSocketServer } from "./registry.js";
import type { MetisIOServer, MetisSocket } from "./server.js";
import { bumpEpoch, onRelayedRevocation, relayRevocation } from "./revocation-relay.js";

const log = createChildLogger("project-room-eviction");

/** Relayed after a deleted workspace's project room is emptied: `(projectId)`. */
export const EVICT_PROJECT_ROOM_EVENT = "metis:project:evict-room";
/** Relayed after a project room is re-judged in place: `(projectId)`. */
export const REJUDGE_PROJECT_ROOM_EVENT = "metis:project:rejudge-room";
/** Relayed after a removed member's project rooms are re-judged: `(userId)`. */
export const REJUDGE_USER_PROJECT_ROOMS_EVENT = "metis:project:rejudge-user";
/** Relayed when a workspace's projects could not be listed: `(reason)`. */
export const REJUDGE_ALL_PROJECT_ROOMS_EVENT = "metis:project:rejudge-all";

type LocalSocket = MetisSocket;

function localSockets(io: MetisIOServer, keep: (socket: LocalSocket) => boolean): LocalSocket[] {
  return [...io.of("/").sockets.values()].filter(keep);
}

/** Re-judge `sockets`' project rooms (all, or `only`), fail closed. Never rejects. */
async function rejudge(sockets: LocalSocket[], only?: string): Promise<void> {
  await Promise.all(
    sockets.map((socket) =>
      rejudgeProjectRooms(socket, socket.data.user, { failClosed: true, only }),
    ),
  );
}

const rejudgeRoomLocally = (io: MetisIOServer, projectId: string) => {
  const room = projectRoom(projectId);
  return rejudge(
    localSockets(io, (s) => s.rooms.has(room)),
    room,
  );
};
const rejudgeUserLocally = (io: MetisIOServer, userId: string) =>
  rejudge(localSockets(io, (s) => s.data.user.userId === userId));
const rejudgeAllLocally = (io: MetisIOServer) => rejudge(localSockets(io, () => true));

/** Ids of every project in `workspaceId`, or `null` when the lookup failed. */
async function workspaceProjectIds(workspaceId: string): Promise<string[] | null> {
  try {
    const rows = await prisma.project.findMany({ where: { workspaceId }, select: { id: true } });
    return rows.map((row) => row.id);
  } catch (err) {
    log.warn("could not list a deleted workspace's projects — re-judging every project room", {
      workspaceId,
      error: (err as Error).message,
    });
    return null;
  }
}

/** Every socket leaves every project room of `workspaceId` — it was deleted. */
export async function evictWorkspaceProjectRooms(workspaceId: string): Promise<void> {
  const io = getSocketServer();
  if (!io) return;
  const projectIds = await workspaceProjectIds(workspaceId);
  bumpEpoch(io, "eviction");
  if (projectIds === null) {
    relayRevocation(io, REJUDGE_ALL_PROJECT_ROOMS_EVENT, "workspace-lookup-failed");
    await rejudgeAllLocally(io);
    return;
  }
  if (projectIds.length === 0) return;
  try {
    io.socketsLeave(projectIds.map(projectRoom));
  } catch (err) {
    log.warn("could not evict sockets from a deleted workspace's project rooms", {
      workspaceId,
      error: (err as Error).message,
    });
  }
  for (const projectId of projectIds) relayRevocation(io, EVICT_PROJECT_ROOM_EVENT, projectId);
}

/**
 * `userId` was removed from `workspaceId`: every one of their sockets re-judges
 * the project rooms it is in, and leaves those the rule now refuses.
 */
export async function evictMemberProjectRooms(userId: string, workspaceId: string): Promise<void> {
  const io = getSocketServer();
  if (!io) return;
  bumpEpoch(io, "eviction");
  relayRevocation(io, REJUDGE_USER_PROJECT_ROOMS_EVENT, userId);
  log.debug("re-judging a removed member's project rooms", { userId, workspaceId });
  await rejudgeUserLocally(io, userId);
}

/**
 * `projectId` changed hands (a legacy project assigned to a workspace): the
 * sockets in its room are re-judged in place — members of the new workspace
 * stay, everyone else leaves.
 */
export async function evictProjectRoom(projectId: string): Promise<void> {
  const io = getSocketServer();
  if (!io) return;
  bumpEpoch(io, "eviction");
  relayRevocation(io, REJUDGE_PROJECT_ROOM_EVENT, projectId);
  await rejudgeRoomLocally(io, projectId);
}

/**
 * #622 — on a server built with the cluster adapter, act on the project-room
 * evictions another replica relays: bump this replica's eviction epoch first,
 * then repeat the work on the local sockets. A no-op without the adapter.
 */
export function wireProjectRoomEvictionRelay(io: MetisIOServer, clustered: boolean): void {
  onRelayedRevocation(io, clustered, EVICT_PROJECT_ROOM_EVENT, 1, (projectId) => {
    bumpEpoch(io, "eviction");
    io.local.socketsLeave(projectRoom(projectId));
  });
  onRelayedRevocation(io, clustered, REJUDGE_PROJECT_ROOM_EVENT, 1, (projectId) => {
    bumpEpoch(io, "eviction");
    runDetached(rejudgeRoomLocally(io, projectId), "relayed project room re-judgement");
  });
  onRelayedRevocation(io, clustered, REJUDGE_USER_PROJECT_ROOMS_EVENT, 1, (userId) => {
    bumpEpoch(io, "eviction");
    runDetached(rejudgeUserLocally(io, userId), "relayed member project room re-judgement");
  });
  onRelayedRevocation(io, clustered, REJUDGE_ALL_PROJECT_ROOMS_EVENT, 1, () => {
    bumpEpoch(io, "eviction");
    runDetached(rejudgeAllLocally(io), "relayed project room re-judgement of every socket");
  });
}
