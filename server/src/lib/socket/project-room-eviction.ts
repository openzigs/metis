/**
 * #1212 — take already-subscribed sockets out of `project:{id}` rooms once they
 * lose the right to them.
 *
 * `subscribe:project` admits every member of the project's workspace, and
 * anyone for a legacy project with no workspace (`canJoinProjectRoom`), but it
 * judges a socket only when it joins. Four writes can revoke a join, and their
 * callers run these right after each one commits:
 *
 * - a member removed from a workspace → `evictMemberProjectRooms`: that user's
 *   sockets re-judge every project room they are in. No project lookup is
 *   needed, so a database error cannot skip the eviction; a re-judgement that
 *   throws leaves the room (fail closed — the member rejoins on their next
 *   subscribe).
 * - a workspace deleted → `evictWorkspaceProjectRooms`: its projects' rooms are
 *   re-judged in place. The workspace is soft-deleted, so every non-admin
 *   leaves and an admin (whom the rule still admits) stays subscribed. If the
 *   project lookup fails, the database is likely unwell, so rather than
 *   re-judge every socket at once and fail closed (the reconnect storm #659
 *   avoids), each replica runs the bounded, single-flight re-validation pass
 *   (`revalidateLocalSockets(io, "listen")`), which re-judges project rooms
 *   `REVALIDATE_CONCURRENCY` users at a time.
 * - a project soft-deleted (`deleteProject`) → `evictProjectRoom`: the room is
 *   re-judged, so every non-admin leaves.
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
 * Every re-judgement runs at most `REVALIDATE_CONCURRENCY` sockets at a time,
 * so a large room cannot fan out unbounded against the database.
 *
 * #1251 — the same four writes re-judge `job:{id}` rooms too (`rejudgeJobRooms`
 * in `job-rooms.ts`, with the `subscribe:job` rule). A job room carries a job's
 * lifecycle and doc-section events; an impact analysis's is gated on the
 * members of its projects' workspaces since #1232, so a removed member kept
 * streaming a run until they reconnected. A removed member's sockets re-judge
 * every job room they are in; a project (or a deleted workspace's projects)
 * re-judges the job rooms of that project, of a cross-project job (an impact
 * analysis), or of a job this process holds no scope for
 * (`jobTouchesProjects`). The relays and the re-validation pass carry the job
 * rooms with the project rooms.
 *
 * Best-effort: these run after the database write committed, so nothing here
 * throws into the route.
 */
import { projectRoom } from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { runDetached } from "./client-event-handler.js";
import { jobIdsOf, jobTouchesProjects, rejudgeJobRooms } from "./job-rooms.js";
import { rejudgeProjectRooms } from "./project-rooms.js";
import { getSocketServer } from "./registry.js";
import {
  REVALIDATE_CONCURRENCY,
  revalidateLocalSockets,
  type MetisIOServer,
  type MetisSocket,
} from "./server.js";
import { bumpEpoch, onRelayedRevocation, relayRevocation } from "./revocation-relay.js";

const log = createChildLogger("project-room-eviction");

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

/**
 * Run `judge` over `sockets`, `REVALIDATE_CONCURRENCY` sockets at a time.
 * `judge` never rejects (both re-judgements catch their own errors).
 */
async function rejudge(
  sockets: LocalSocket[],
  judge: (socket: LocalSocket) => Promise<void>,
): Promise<void> {
  const queue = [...sockets];
  const worker = async (): Promise<void> => {
    for (let socket = queue.shift(); socket; socket = queue.shift()) await judge(socket);
  };
  await Promise.all(Array.from({ length: REVALIDATE_CONCURRENCY }, worker));
}

/** Re-judge `projectId`'s room in place, fail closed. */
const rejudgeProjectRoomLocally = (io: MetisIOServer, projectId: string) => {
  const room = projectRoom(projectId);
  return rejudge(
    localSockets(io, (s) => s.rooms.has(room)),
    (socket) => rejudgeProjectRooms(socket, socket.data.user, { failClosed: true, only: room }),
  );
};

/** #1251 — re-judge every job room that may involve `projectIds`, fail closed. */
const rejudgeProjectJobRoomsLocally = (io: MetisIOServer, projectIds: ReadonlySet<string>) => {
  const only = (jobId: string) => jobTouchesProjects(jobId, projectIds);
  return rejudge(
    localSockets(io, (s) => jobIdsOf(s).some(only)),
    (socket) => rejudgeJobRooms(socket, socket.data.user, { failClosed: true, only }),
  );
};

const rejudgeRoomLocally = async (io: MetisIOServer, projectId: string) => {
  await rejudgeProjectRoomLocally(io, projectId);
  await rejudgeProjectJobRoomsLocally(io, new Set([projectId]));
};

/** A removed member: every project and job room their sockets are in. */
const rejudgeUserLocally = (io: MetisIOServer, userId: string) =>
  rejudge(
    localSockets(io, (s) => s.data.user.userId === userId),
    async (socket) => {
      await rejudgeProjectRooms(socket, socket.data.user, { failClosed: true });
      await rejudgeJobRooms(socket, socket.data.user, { failClosed: true });
    },
  );

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

/**
 * `workspaceId` was deleted: the rooms of its projects are re-judged in place,
 * so non-admins leave and admins stay.
 */
export async function evictWorkspaceProjectRooms(workspaceId: string): Promise<void> {
  const io = getSocketServer();
  if (!io) return;
  const projectIds = await workspaceProjectIds(workspaceId);
  bumpEpoch(io, "eviction");
  if (projectIds === null) {
    relayRevocation(io, REJUDGE_ALL_PROJECT_ROOMS_EVENT, "workspace-lookup-failed");
    await revalidateLocalSockets(io, "listen");
    return;
  }
  for (const projectId of projectIds) relayRevocation(io, REJUDGE_PROJECT_ROOM_EVENT, projectId);
  await Promise.all(projectIds.map((projectId) => rejudgeProjectRoomLocally(io, projectId)));
  // One pass over the job rooms for every project, so an impact analysis's
  // room is judged once rather than once per project.
  await rejudgeProjectJobRoomsLocally(io, new Set(projectIds));
}

/**
 * `userId` was removed from `workspaceId`: every one of their sockets re-judges
 * the project rooms and (#1251) the job rooms it is in, and leaves those the
 * rule now refuses.
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
 * `projectId`'s access rule changed — a legacy project assigned to a
 * workspace, or the project soft-deleted: the sockets in its room, and (#1251)
 * in the job rooms that may involve it, are re-judged in place, so whoever the
 * rule now refuses leaves and everyone else stays.
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
    runDetached(revalidateLocalSockets(io, "listen"), "relayed re-validation pass");
  });
}
