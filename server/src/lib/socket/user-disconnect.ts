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
import type { MetisIOServer } from "./server.js";

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
 * `serverSideEmit`; every other replica's `wireReconnectUserRelay` handler then
 * closes the transports of the user's sockets it holds. With the in-memory
 * adapter it reaches this replica only.
 *
 * Same best-effort contract as `disconnectUserSockets`: call it after the role
 * write commits.
 */
export function reconnectUserSockets(userId: string): void {
  revocations++;
  const io = getSocketServer();
  if (!io) return;
  try {
    closeLocalUserTransports(io, userId);
  } catch (err) {
    log.warn("could not reconnect a user's sockets after a role change", {
      userId,
      error: (err as Error).message,
    });
  }
  if (!relayed.has(io)) return;
  try {
    asRelayServer(io).serverSideEmit(RECONNECT_USER_EVENT, userId);
  } catch (err) {
    log.warn("could not relay a role-change reconnect to the other replicas", {
      userId,
      error: (err as Error).message,
    });
  }
}

/** The server-side event a replica relays to make the others close a user's transports. */
export const RECONNECT_USER_EVENT = "metis:user:reconnect";

/** Servers built with the cluster adapter, whose reconnects are relayed. */
const relayed = new WeakSet<object>();

/**
 * The server-side-event surface. `MetisIOServer` declares no server-side
 * events, and widening its generic would ripple through every typed `Socket`.
 */
interface RelayServer {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  serverSideEmit(event: string, ...args: unknown[]): unknown;
}
function asRelayServer(io: MetisIOServer): RelayServer {
  return io as unknown as RelayServer;
}

/**
 * #622 — on a server built with the cluster adapter, close the transports of a
 * user's local sockets when another replica relays `RECONNECT_USER_EVENT`, and
 * relay this replica's own `reconnectUserSockets`. A no-op without the adapter,
 * where `serverSideEmit` is unsupported.
 */
export function wireReconnectUserRelay(io: MetisIOServer, clustered: boolean): void {
  if (!clustered) return;
  relayed.add(io);
  asRelayServer(io).on(RECONNECT_USER_EVENT, (userId: unknown) => {
    if (typeof userId !== "string" || userId.length === 0) return;
    try {
      closeLocalUserTransports(io, userId);
    } catch (err) {
      log.warn("could not reconnect a user's sockets for a relayed role change", {
        userId,
        error: (err as Error).message,
      });
    }
  });
}

/** Close the transport of every socket of `userId` connected to this replica. */
function closeLocalUserTransports(io: MetisIOServer, userId: string): void {
  const sids = io.sockets.adapter.rooms.get(`user:${userId}`);
  for (const sid of [...(sids ?? [])]) io.sockets.sockets.get(sid)?.conn.close();
}
