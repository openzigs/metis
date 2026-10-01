/**
 * #588 — take already-subscribed sockets out of an `mcp:status` workspace room
 * once they lose the right to it.
 *
 * `subscribe:mcp` joins workspace rooms from live memberships (#562), but that
 * is read only at subscribe time: a socket that joined before the workspace was
 * soft-deleted, or before its user was removed, would otherwise keep receiving
 * that workspace's project-server events until it unsubscribed or reconnected.
 * The workspace routes call these right after the database write.
 *
 * Reach (#622): on a Postgres datasource `createServer` installs the Postgres
 * cluster adapter (`cluster-adapter.ts`), which relays `socketsLeave` over
 * `LISTEN` / `NOTIFY` to EVERY replica. Without it (SQLite dev, or
 * `NODE_ENV=test`) the in-memory adapter reaches only this replica's sockets —
 * all there is in a single-replica setup. With no registered server (tests,
 * scripts) there is no socket to evict and both are no-ops.
 *
 * Every eviction bumps the eviction epoch first (#613), on this replica and —
 * through `wireMcpStatusEvictionRelay` — on every other one, so a
 * `subscribe:mcp` in flight on any replica re-reads its memberships
 * (`revocation-relay.ts`).
 *
 * Both run after the database write has committed, so they are best-effort: an
 * adapter error is logged, never thrown, so the route cannot answer 500 for a
 * change that already landed. A socket missed here is still pruned on its next
 * `subscribe:mcp` or reconnect.
 */
import { createChildLogger } from "../logger.js";
import { mcpStatusWorkspaceRoom } from "../mcp/status-rooms.js";
import { getSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";
import { bumpEpoch, onRelayedRevocation, readEpoch, relayRevocation } from "./revocation-relay.js";

const log = createChildLogger("mcp-status-eviction");

/**
 * #613 — moves whenever any MCP status workspace room is evicted on this
 * server, here or (relayed, #622) on another replica. `subscribe:mcp` reads
 * memberships, then joins: an eviction landing between the two finds the
 * socket not yet in the room and misses it. The handler snapshots this before
 * the read and, when it has moved by the time the join is done, re-reads the
 * memberships and leaves any room it lost. See `revocation-relay.ts` for its
 * scope and cost.
 */
export const mcpStatusEvictionEpoch = (io: MetisIOServer): number => readEpoch(io, "eviction");

/** Relayed after a workspace eviction: `(workspaceId)`. */
export const EVICT_WORKSPACE_EVENT = "metis:mcp:evict-workspace";
/** Relayed after a member eviction: `(userId, workspaceId)`. */
export const EVICT_MEMBER_EVENT = "metis:mcp:evict-member";

/** Every socket leaves the workspace's room — the workspace was deleted. */
export function evictWorkspaceMcpStatusRoom(workspaceId: string): void {
  const io = getSocketServer();
  if (!io) return;
  bumpEpoch(io, "eviction");
  try {
    io.socketsLeave(mcpStatusWorkspaceRoom(workspaceId));
  } catch (err) {
    log.warn("could not evict sockets from a deleted workspace's MCP status room", {
      workspaceId,
      error: (err as Error).message,
    });
  }
  relayRevocation(io, EVICT_WORKSPACE_EVENT, workspaceId);
}

/**
 * Every socket of `userId` (its personal `user:{id}` room, joined on connect
 * from the verified JWT) leaves the workspace's room — the user was removed.
 */
export function evictMemberMcpStatusRoom(userId: string, workspaceId: string): void {
  const io = getSocketServer();
  if (!io) return;
  bumpEpoch(io, "eviction");
  try {
    io.in(`user:${userId}`).socketsLeave(mcpStatusWorkspaceRoom(workspaceId));
  } catch (err) {
    log.warn("could not evict a removed member's sockets from an MCP status room", {
      userId,
      workspaceId,
      error: (err as Error).message,
    });
  }
  relayRevocation(io, EVICT_MEMBER_EVENT, userId, workspaceId);
}

/**
 * #622 — on a server built with the cluster adapter, act on the evictions
 * another replica relays (and mark this server so its own are relayed). Each
 * bumps this replica's eviction epoch FIRST, so a `subscribe:mcp` in flight
 * here re-reads its memberships (#613), then repeats the `socketsLeave` on the
 * local sockets — idempotent with the adapter's own cluster-wide leave, and
 * independent of which of the two arrives first. A no-op without the adapter.
 */
export function wireMcpStatusEvictionRelay(io: MetisIOServer, clustered: boolean): void {
  onRelayedRevocation(io, clustered, EVICT_WORKSPACE_EVENT, 1, (workspaceId) => {
    bumpEpoch(io, "eviction");
    io.local.socketsLeave(mcpStatusWorkspaceRoom(workspaceId));
  });
  onRelayedRevocation(io, clustered, EVICT_MEMBER_EVENT, 2, (userId, workspaceId) => {
    bumpEpoch(io, "eviction");
    io.local.in(`user:${userId}`).socketsLeave(mcpStatusWorkspaceRoom(workspaceId));
  });
}
