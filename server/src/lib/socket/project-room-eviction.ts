/**
 * #1212 — take already-subscribed sockets out of a workspace's `project:{id}`
 * rooms once they lose the right to them.
 *
 * `subscribe:project` admits every member of the project's workspace
 * (`canJoinProjectRoom`), but it reads membership only at subscribe time. A
 * member removed from the workspace, or every member of a deleted workspace,
 * would otherwise keep receiving the project's live job, document, usage and
 * drift events until they unsubscribed or reconnected. The workspace routes
 * call these right after the database write, beside the #588 `mcp:status`
 * evictions (`mcp-status-eviction.ts`), whose shape this module follows:
 *
 * - Each eviction bumps the shared `eviction` epoch FIRST (#613). A
 *   `subscribe:project` snapshots that epoch before its access read and, when
 *   it has moved by the time the join is done, re-checks and leaves — so a join
 *   whose read raced the removal does not keep the room.
 * - On a clustered server each eviction is relayed to every other replica
 *   (#622), which bumps its own epoch and repeats the leave on its local
 *   sockets. One relay is sent per project room, so each carries only strings.
 *
 * Best-effort: these run after the database write committed, so a failed
 * project lookup or adapter error is logged, never thrown, and the route never
 * answers 500 for a change that already landed. A socket missed here is still
 * refused on its next `subscribe:project`, which re-reads membership.
 *
 * An admin removed from a workspace is evicted like anyone else, although the
 * admin bypass would let them straight back in: their next `subscribe:project`
 * (a page load or a reconnect) rejoins.
 */
import { projectRoom, userRoom } from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";
import { bumpEpoch, onRelayedRevocation, relayRevocation } from "./revocation-relay.js";

const log = createChildLogger("project-room-eviction");

/** Relayed after a workspace's project rooms are emptied: `(projectId)`. */
export const EVICT_PROJECT_ROOM_EVENT = "metis:project:evict-room";
/** Relayed after a removed member leaves a project room: `(userId, projectId)`. */
export const EVICT_PROJECT_MEMBER_EVENT = "metis:project:evict-member";

/** Ids of every project in `workspaceId`, or `null` when the lookup failed. */
async function workspaceProjectIds(workspaceId: string): Promise<string[] | null> {
  try {
    const rows = await prisma.project.findMany({ where: { workspaceId }, select: { id: true } });
    return rows.map((row) => row.id);
  } catch (err) {
    log.warn("could not list a workspace's projects to evict their socket rooms", {
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
  if (!projectIds?.length) return;
  bumpEpoch(io, "eviction");
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
 * Every socket of `userId` (its personal `user:{id}` room, joined on connect
 * from the verified token) leaves every project room of `workspaceId` — the
 * user was removed from it.
 */
export async function evictMemberProjectRooms(userId: string, workspaceId: string): Promise<void> {
  const io = getSocketServer();
  if (!io) return;
  const projectIds = await workspaceProjectIds(workspaceId);
  if (!projectIds?.length) return;
  bumpEpoch(io, "eviction");
  try {
    io.in(userRoom(userId)).socketsLeave(projectIds.map(projectRoom));
  } catch (err) {
    log.warn("could not evict a removed member's sockets from project rooms", {
      userId,
      workspaceId,
      error: (err as Error).message,
    });
  }
  for (const projectId of projectIds) {
    relayRevocation(io, EVICT_PROJECT_MEMBER_EVENT, userId, projectId);
  }
}

/**
 * #622 — on a server built with the cluster adapter, act on the project-room
 * evictions another replica relays: bump this replica's eviction epoch first,
 * then repeat the leave on the local sockets. A no-op without the adapter.
 */
export function wireProjectRoomEvictionRelay(io: MetisIOServer, clustered: boolean): void {
  onRelayedRevocation(io, clustered, EVICT_PROJECT_ROOM_EVENT, 1, (projectId) => {
    bumpEpoch(io, "eviction");
    io.local.socketsLeave(projectRoom(projectId));
  });
  onRelayedRevocation(io, clustered, EVICT_PROJECT_MEMBER_EVENT, 2, (userId, projectId) => {
    bumpEpoch(io, "eviction");
    io.local.in(userRoom(userId)).socketsLeave(projectRoom(projectId));
  });
}
