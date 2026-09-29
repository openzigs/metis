/**
 * #340 — where an `mcp:status` event may go.
 *
 * `global` and `project` events go to the shared `mcp:status` room, which any
 * `mcp.manage` holder may join (unchanged). A `scope: "user"` server is one
 * user's own, so its label, status and lastError go ONLY to a room its owner
 * joins and to the system admins' room — never to the shared room. A user
 * server with no owner on record reaches admins only (fail closed).
 *
 * Pure (no Socket.IO import) so the socket server and the MCP bootstrap share
 * one definition of the room names.
 */
import type { MCPStatusEvent } from "./types.js";

/** Shared room: `global` and `project` server events. */
export const MCP_STATUS_ROOM = "mcp:status";
/** System admins: every user-scope server's events. */
export const MCP_STATUS_ADMIN_ROOM = "mcp:status:admin";
/** One owner's user-scope server events. The id is always the verified JWT's. */
export const mcpStatusOwnerRoom = (userId: string): string => `mcp:status:user:${userId}`;

/** The rooms `event` is emitted to. `ownerId` is the server's owning user id. */
export function mcpStatusRooms(
  event: Pick<MCPStatusEvent, "scope">,
  ownerId: string | null | undefined,
): string[] {
  if (event.scope !== "user") return [MCP_STATUS_ROOM];
  return ownerId ? [mcpStatusOwnerRoom(ownerId), MCP_STATUS_ADMIN_ROOM] : [MCP_STATUS_ADMIN_ROOM];
}

/** The rooms a subscriber that passed the `mcp.manage` gate joins. */
export function mcpStatusRoomsFor(user: { userId: string; role: string }): string[] {
  const rooms = [MCP_STATUS_ROOM, mcpStatusOwnerRoom(user.userId)];
  if (user.role === "admin") rooms.push(MCP_STATUS_ADMIN_ROOM);
  return rooms;
}
