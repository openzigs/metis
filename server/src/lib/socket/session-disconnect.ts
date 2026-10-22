/**
 * #1414 — bind every socket to the sign-in session that opened it, and close
 * that session's sockets — and no other session's — when it ends.
 *
 * The handshake verifies the access token once. Before #1414 nothing tied the
 * socket to the session afterwards, so a socket outlived a logout: it kept
 * receiving `user:{id}` events and kept authorising `subscribe:*` joins for the
 * rest of its life. Each socket now joins a server-only room named after its
 * user and the token's session id (`sid`, minted at login and carried through
 * every refresh); no client event can name it.
 *
 * `disconnectSessionSockets` (called by `POST /api/auth/logout`):
 *   - disconnects every socket in that room. Through the cluster adapter
 *     (#622) `disconnectSockets` reaches every replica;
 *   - records the session as ended until its last access token has expired,
 *     here and — relayed — on every other replica, so the handshake refuses a
 *     reconnect with an access token of the ended session, and a handshake in
 *     flight during the logout is closed once it has joined the room.
 *
 * The record is in memory, per replica: a replica that restarts, or misses the
 * relay, no longer refuses a reconnect from that session. That socket is still
 * closed when its access token expires (`server.ts`), so the gap is bounded by
 * the access-token lifetime — the same bound the HTTP API has, where an access
 * token is not checked against any revocation.
 *
 * A token issued before #1414 has no session id. All such tokens of one user
 * share the `legacy` room, so a logout from one closes all of them; the first
 * refresh of any of them mints a session id, so this lasts at most one access
 * token lifetime after the upgrade.
 */
import { createChildLogger } from "../logger.js";
import { accessTokenTtlSeconds } from "../auth/jwt.js";
import { getSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";
import { onRelayedRevocation, relayRevocation } from "./revocation-relay.js";

const log = createChildLogger("socket-session-disconnect");

/** The room key for a token with no session id (issued before #1414). */
export const LEGACY_SESSION_KEY = "legacy";

/** The server-side event a replica relays so the others record a session as ended. */
export const DISCONNECT_SESSION_EVENT = "metis:session:disconnect";

/**
 * Most ended sessions remembered at once. An entry lives at most one
 * access-token lifetime (an expired one is dropped when it is next looked up);
 * past this the oldest is dropped, which only loses the reconnect refusal for
 * that session — its sockets were already disconnected.
 */
export const MAX_ENDED_SESSIONS = 50_000;

/**
 * The server-only room of one sign-in session. The user id is part of the
 * name, so one user's logout can never reach another user's sockets.
 */
export function authSessionRoom(userId: string, sid: string | undefined): string {
  return `auth-session:${userId}:${sid ?? LEGACY_SESSION_KEY}`;
}

/** Ended sessions (`authSessionRoom` name) → when the record may be forgotten (ms). */
const endedSessions = new Map<string, number>();

function rememberEnded(room: string, untilMs: number): void {
  endedSessions.delete(room);
  endedSessions.set(room, untilMs);
  // Every record lives the same span, so insertion order is expiry order: the
  // first record is the oldest, and an expired one is always dropped first.
  if (endedSessions.size > MAX_ENDED_SESSIONS) {
    endedSessions.delete(endedSessions.keys().next().value!);
  }
}

/** Whether the session `(userId, sid)` was ended by a logout this replica knows of. */
export function isSessionEnded(userId: string, sid: string | undefined): boolean {
  const room = authSessionRoom(userId, sid);
  const until = endedSessions.get(room);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  endedSessions.delete(room);
  return false;
}

/** Test helper — forget every ended session. */
export function __resetEndedSessionsForTests(): void {
  endedSessions.clear();
}

/** Latest instant an access token of a session ending now can still verify. */
function endedUntil(): number {
  return Date.now() + accessTokenTtlSeconds() * 1000;
}

/**
 * Close every socket of the session `(userId, sid)` on every replica the
 * adapter reaches, and refuse its access tokens at the handshake until they
 * have all expired. Best-effort: called after the logout's revocation, so an
 * adapter error is logged, never thrown.
 */
export function disconnectSessionSockets(userId: string, sid: string | undefined): void {
  const io = getSocketServer();
  if (!io) return;
  const room = authSessionRoom(userId, sid);
  const until = endedUntil();
  rememberEnded(room, until);
  try {
    io.in(room).disconnectSockets(true);
  } catch (err) {
    log.warn("could not disconnect an ended session's sockets", {
      userId,
      error: (err as Error).message,
    });
  }
  relayRevocation(io, DISCONNECT_SESSION_EVENT, userId, sid ?? LEGACY_SESSION_KEY);
}

/**
 * On a server built with the cluster adapter, record the sessions another
 * replica ended and disconnect their local sockets (idempotent with the
 * adapter's own cluster-wide `disconnectSockets`). The record's lifetime is
 * computed here, never taken from the relay. A no-op without the adapter.
 */
export function wireSessionRevocationRelay(io: MetisIOServer, clustered: boolean): void {
  onRelayedRevocation(io, clustered, DISCONNECT_SESSION_EVENT, 2, (userId, sidKey) => {
    const sid = sidKey === LEGACY_SESSION_KEY ? undefined : sidKey;
    const room = authSessionRoom(userId, sid);
    rememberEnded(room, endedUntil());
    io.local.in(room).disconnectSockets(true);
  });
}
