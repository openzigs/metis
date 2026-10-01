/**
 * #612 — close every open socket of a user who has lost access (SCIM
 * deprovision or `active: false`).
 *
 * Revoking refresh tokens stops new sessions but touches no open socket, and a
 * socket keeps every room it joined — MCP workspace status rooms included —
 * until it disconnects. `disconnectSockets(true)` closes the underlying
 * connection for every socket in the user's personal `user:{id}` room (joined
 * on connect from the verified JWT). With no registered server (tests, scripts)
 * it is a no-op.
 *
 * Reach is THIS replica only. No Socket.IO cluster adapter is installed
 * (`createSocketServer` uses the default in-memory adapter), so on a
 * multi-replica deployment a socket held by another replica survives the
 * deprovision and keeps its rooms. Cross-replica reach is tracked in #622.
 *
 * Called after the database write has committed, so it is best-effort: an
 * adapter error is logged, never thrown, so the route cannot answer 500 for a
 * change that already landed.
 */
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "./registry.js";

const log = createChildLogger("socket-user-disconnect");

/** Disconnect every socket of `userId` connected to this replica (see #622). */
export function disconnectUserSockets(userId: string): void {
  try {
    getSocketServer()?.in(`user:${userId}`).disconnectSockets(true);
  } catch (err) {
    log.warn("could not disconnect a deprovisioned user's sockets", {
      userId,
      error: (err as Error).message,
    });
  }
}
