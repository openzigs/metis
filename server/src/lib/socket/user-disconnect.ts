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
 * Every disconnect / reconnect here bumps the revocation epoch first (#613), on
 * this replica and — through `wireUserRevocationRelay` — on every other one, so
 * a handshake in flight on any replica re-reads the live user
 * (`revocation-relay.ts`).
 *
 * Called after the database write has committed, so it is best-effort: an
 * adapter error is logged, never thrown, so the route cannot answer 500 for a
 * change that already landed.
 */
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";
import { bumpEpoch, onRelayedRevocation, readEpoch, relayRevocation } from "./revocation-relay.js";

const log = createChildLogger("socket-user-disconnect");

/**
 * #613 — moves whenever any user's sockets are revoked on this server, here or
 * (relayed, #622) on another replica. Either revocation reaches only sockets
 * already in `user:{id}`, which a socket joins only once connected — after the
 * handshake has read the live user — so the socket server snapshots this before
 * the read and re-reads the user when it has moved by the time the socket is in
 * its room. See `revocation-relay.ts` for its scope and cost.
 */
export const userSocketRevocationEpoch = (io: MetisIOServer): number => readEpoch(io, "revocation");

/** The server-side event a replica relays to make the others close a user's transports. */
export const RECONNECT_USER_EVENT = "metis:user:reconnect";

/**
 * The server-side event a replica relays after a deprovision, so the others
 * move their revocation epoch and disconnect the user's local sockets.
 */
export const DISCONNECT_USER_EVENT = "metis:user:disconnect";

/** Disconnect every socket of `userId`, on every replica the adapter reaches (#622). */
export function disconnectUserSockets(userId: string): void {
  const io = getSocketServer();
  if (!io) return;
  bumpEpoch(io, "revocation");
  try {
    io.in(`user:${userId}`).disconnectSockets(true);
  } catch (err) {
    log.warn("could not disconnect a deprovisioned user's sockets", {
      userId,
      error: (err as Error).message,
    });
  }
  relayRevocation(io, DISCONNECT_USER_EVENT, userId);
}

/**
 * #633 — make every socket of `userId` re-handshake after a role change, so it
 * picks up the new durable role (#617) and every room gate runs again.
 *
 * A socket keeps the role it had at connect time: a demoted admin otherwise
 * stays in `mcp:status:admin` for the life of the connection. Closing the
 * transport (rather than `disconnectSockets`, which sends a disconnect packet
 * the client treats as final) leaves the client's own reconnect loop running,
 * so a user who is still active comes back with the new role instead of being
 * parked disconnected. Leaving the socket drops every room it held.
 *
 * Reach (#622): a remote socket cannot have its transport closed from another
 * replica — Socket.IO's `RemoteSocket` offers only `disconnect()`, which is the
 * final "io server disconnect". So this replica closes its own sockets, and
 * when the cluster adapter is installed it relays `RECONNECT_USER_EVENT` with
 * `serverSideEmit`; every other replica's `wireUserRevocationRelay` handler then
 * closes the transports of the user's sockets it holds. With the in-memory
 * adapter it reaches this replica only.
 *
 * Same best-effort contract as `disconnectUserSockets`: call it after the role
 * write commits.
 */
export function reconnectUserSockets(userId: string): void {
  const io = getSocketServer();
  if (!io) return;
  bumpEpoch(io, "revocation");
  try {
    closeLocalUserTransports(io, userId);
  } catch (err) {
    log.warn("could not reconnect a user's sockets after a role change", {
      userId,
      error: (err as Error).message,
    });
  }
  relayRevocation(io, RECONNECT_USER_EVENT, userId);
}

/**
 * #622 — on a server built with the cluster adapter, act on the user
 * revocations another replica relays (and mark this server so its own are
 * relayed). Each relayed revocation bumps this replica's epoch FIRST, so a
 * handshake in flight here re-reads the live user (#613), then repeats the
 * revocation on the user's local sockets:
 *   - `RECONNECT_USER_EVENT` closes their transports (only this replica can);
 *   - `DISCONNECT_USER_EVENT` disconnects them. The adapter's own cluster-wide
 *     `disconnectSockets` already reaches them; the local repeat is idempotent
 *     and keeps the outcome independent of which of the two arrives first.
 * A no-op without the adapter, where `serverSideEmit` is unsupported.
 */
export function wireUserRevocationRelay(io: MetisIOServer, clustered: boolean): void {
  onRelayedRevocation(io, clustered, RECONNECT_USER_EVENT, 1, (userId) => {
    bumpEpoch(io, "revocation");
    closeLocalUserTransports(io, userId);
  });
  onRelayedRevocation(io, clustered, DISCONNECT_USER_EVENT, 1, (userId) => {
    bumpEpoch(io, "revocation");
    io.local.in(`user:${userId}`).disconnectSockets(true);
  });
}

/** Close the transport of every socket of `userId` connected to this replica. */
function closeLocalUserTransports(io: MetisIOServer, userId: string): void {
  const sids = io.sockets.adapter.rooms.get(`user:${userId}`);
  for (const sid of [...(sids ?? [])]) io.sockets.sockets.get(sid)?.conn.close();
}
