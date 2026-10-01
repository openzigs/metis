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
 * Reach (#622): on a Postgres datasource `createServer` installs the Postgres
 * cluster adapter (`cluster-adapter.ts`), which relays the disconnect over
 * `LISTEN` / `NOTIFY` so it closes the user's sockets on EVERY replica. Without
 * it (SQLite dev, or `NODE_ENV=test`) the in-memory adapter reaches only the
 * sockets on this replica — which is all there is in a single-replica setup.
 * A replica whose adapter is cut off from Postgres at that moment misses the
 * relay and keeps that socket until it disconnects; a reconnect is refused by
 * the live-user handshake (#617).
 *
 * Called after the database write has committed, so it is best-effort: an
 * adapter error is logged, never thrown, so the route cannot answer 500 for a
 * change that already landed.
 */
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "./registry.js";

const log = createChildLogger("socket-user-disconnect");

/**
 * #613 — bumped by every disconnect / reconnect below, before it looks for
 * sockets. Either one reaches only sockets already in `user:{id}`, which a
 * socket joins only once connected — after the handshake has read the live
 * user. A revocation committing inside that gap would miss the socket, so the
 * socket server snapshots this before the read and re-reads the user when it
 * has moved by the time the socket is in its room.
 *
 * The counter is process-wide, not per user: it counts EVERY revocation on this
 * replica, so any handshake in flight during any user's revocation does one
 * extra live-user read. That bounded cost is a deliberate trade-off against
 * keeping (and pruning) a per-user map.
 */
let revocations = 0;

/** #613 — moves whenever any user's sockets are revoked on this replica. */
export const userSocketRevocationEpoch = (): number => revocations;

/** Disconnect every socket of `userId`, on every replica the adapter reaches (#622). */
export function disconnectUserSockets(userId: string): void {
  revocations++;
  try {
    getSocketServer()?.in(`user:${userId}`).disconnectSockets(true);
  } catch (err) {
    log.warn("could not disconnect a deprovisioned user's sockets", {
      userId,
      error: (err as Error).message,
    });
  }
}

/**
 * #633 — make every socket of `userId` on this replica re-handshake after a role
 * change, so it picks up the new durable role (#617) and every room gate runs
 * again.
 *
 * A socket keeps the role it had at connect time: a demoted admin otherwise
 * stays in `mcp:status:admin` for the life of the connection. Closing the
 * transport (rather than `disconnectSockets`, which sends a disconnect packet
 * the client treats as final) leaves the client's own reconnect loop running,
 * so a user who is still active comes back with the new role instead of being
 * parked disconnected. Leaving the socket drops every room it held.
 *
 * Same reach (this replica only, #622) and best-effort contract as
 * `disconnectUserSockets`: call it after the role write commits.
 */
export function reconnectUserSockets(userId: string): void {
  revocations++;
  try {
    const io = getSocketServer();
    if (!io) return;
    const sids = io.sockets.adapter.rooms.get(`user:${userId}`);
    for (const sid of [...(sids ?? [])]) io.sockets.sockets.get(sid)?.conn.close();
  } catch (err) {
    log.warn("could not reconnect a user's sockets after a role change", {
      userId,
      error: (err as Error).message,
    });
  }
}
