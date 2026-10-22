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
 * `endUserSessionsIssuedBy` (called by `revokeAllUserSessions`) does the same
 * for every session of one user at once: the handshake refuses any of that
 * user's access tokens issued at or before the cutoff, so a sign-out-everywhere
 * for a user who stays active cannot be undone by a reconnect. The same
 * in-memory, relayed, access-token-lifetime bound applies.
 *
 * A token issued before #1414 has no session id. All such tokens of one user
 * share the `legacy` room, so a logout from one closes all of them; the first
 * refresh of any of them mints a session id, so this lasts at most one access
 * token lifetime after the upgrade.
 */
import { createChildLogger } from "../logger.js";
import { accessTokenTtlSeconds } from "../auth/token-ttl.js";
import { getSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";
import { onRelayedRevocation, relayRevocation } from "./revocation-relay.js";

const log = createChildLogger("socket-session-disconnect");

/** The room key for a token with no session id (issued before #1414). */
export const LEGACY_SESSION_KEY = "legacy";

/** The server-side event a replica relays so the others record a session as ended. */
export const DISCONNECT_SESSION_EVENT = "metis:session:disconnect";

/** The server-side event a replica relays so the others end a user's sessions issued up to a cutoff. */
export const END_USER_SESSIONS_EVENT = "metis:session:end-user";

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

/**
 * Users whose every session issued up to a cutoff was ended → the cutoff (`iat`
 * seconds, inclusive, as the revocation store's) and when the record may be
 * forgotten (ms).
 */
const endedUsers = new Map<string, { issuedBySec: number; untilMs: number }>();

function rememberEndedUser(userId: string, issuedBySec: number, untilMs: number): void {
  const previous = endedUsers.get(userId);
  endedUsers.delete(userId);
  endedUsers.set(userId, {
    issuedBySec: Math.max(issuedBySec, previous?.issuedBySec ?? issuedBySec),
    untilMs,
  });
  if (endedUsers.size > MAX_ENDED_SESSIONS) {
    endedUsers.delete(endedUsers.keys().next().value!);
  }
}

/**
 * Whether an access token of `userId` in session `sid`, issued at `iat`
 * (seconds), belongs to a session that has ended: logged out
 * (`isSessionEnded`), or issued at or before a revoke-all cutoff. A token with
 * no `iat` is treated as issued before any cutoff.
 */
export function isTokenSessionEnded(
  userId: string,
  sid: string | undefined,
  iat: number | undefined,
): boolean {
  if (isSessionEnded(userId, sid)) return true;
  const marker = endedUsers.get(userId);
  if (!marker) return false;
  if (marker.untilMs <= Date.now()) {
    endedUsers.delete(userId);
    return false;
  }
  return iat === undefined || iat <= marker.issuedBySec;
}

/** Test helper — forget every ended session. */
export function __resetEndedSessionsForTests(): void {
  endedSessions.clear();
  endedUsers.clear();
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
 * Refuse, at the handshake, every access token of `userId` issued at or before
 * `issuedBySec` until they have all expired — here and, relayed, on every
 * other replica. Disconnecting the user's open sockets is the caller's
 * (`disconnectUserSockets`). Recorded even with no registered server, so the
 * order of the two calls does not matter.
 */
export function endUserSessionsIssuedBy(userId: string, issuedBySec: number): void {
  rememberEndedUser(userId, issuedBySec, endedUntil());
  const io = getSocketServer();
  if (io) relayRevocation(io, END_USER_SESSIONS_EVENT, userId, String(issuedBySec));
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
  // A relayed cutoff is never later than now here, so a replica cannot be
  // made to refuse tokens issued after it heard of the revocation.
  onRelayedRevocation(io, clustered, END_USER_SESSIONS_EVENT, 2, (userId, issuedBy) => {
    const issuedBySec = Number(issuedBy);
    if (!Number.isInteger(issuedBySec)) return;
    rememberEndedUser(userId, Math.min(issuedBySec, Math.floor(Date.now() / 1000)), endedUntil());
  });
}
