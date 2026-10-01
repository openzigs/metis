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
 * `socketsLeave` reaches only sockets connected to THIS replica: `createSocketServer`
 * uses Socket.IO's default in-memory adapter, so on a multi-replica deployment a
 * socket held by another replica keeps the room until its next `subscribe:mcp`
 * or reconnect (#622). With no registered server (tests, scripts) there is no
 * socket to evict and both are no-ops.
 *
 * Both run after the database write has committed, so they are best-effort: an
 * adapter error is logged, never thrown, so the route cannot answer 500 for a
 * change that already landed. A socket missed here is still pruned on its next
 * `subscribe:mcp` or reconnect.
 */
import { createChildLogger } from "../logger.js";
import { mcpStatusWorkspaceRoom } from "../mcp/status-rooms.js";
import { getSocketServer } from "./registry.js";

const log = createChildLogger("mcp-status-eviction");

/** Every socket leaves the workspace's room — the workspace was deleted. */
export function evictWorkspaceMcpStatusRoom(workspaceId: string): void {
  try {
    getSocketServer()?.socketsLeave(mcpStatusWorkspaceRoom(workspaceId));
  } catch (err) {
    log.warn("could not evict sockets from a deleted workspace's MCP status room", {
      workspaceId,
      error: (err as Error).message,
    });
  }
}

/**
 * Every socket of `userId` (its personal `user:{id}` room, joined on connect
 * from the verified JWT) leaves the workspace's room — the user was removed.
 */
export function evictMemberMcpStatusRoom(userId: string, workspaceId: string): void {
  try {
    getSocketServer()?.in(`user:${userId}`).socketsLeave(mcpStatusWorkspaceRoom(workspaceId));
  } catch (err) {
    log.warn("could not evict a removed member's sockets from an MCP status room", {
      userId,
      workspaceId,
      error: (err as Error).message,
    });
  }
}
