/**
 * #642 — keep a Socket.IO room subscription alive across reconnects.
 *
 * A reconnect (network blip, the #414 token-renewal re-handshake, a
 * server-initiated drop) gives the socket a fresh server-side session with no
 * rooms. `useSocket` hands back the same `Socket` instance throughout, so an
 * effect that emitted `subscribe:*` once never re-runs and the view silently
 * stops receiving live events. This helper re-sends the subscription on every
 * `connect` until it is released.
 *
 * A subscribe emitted while the socket is down sits in socket.io-client's send
 * buffer and is flushed on the next connect, so that one connect does not
 * re-send it — the same rule `job-rooms.ts` (#486) applies to job rooms.
 *
 * Known window (#510, shared with `job-rooms.ts`): after a ping timeout but
 * before the client notices, `connected` still reads true, so a subscribe made
 * then is buffered without the skip being armed. The next connect flushes it
 * AND re-sends it, so the server sees the subscription twice. Every room this
 * helper serves joins idempotently (`socket.join`, and presence keys its list
 * by socket id), so the duplicate is harmless.
 *
 * Event listeners registered with `socket.on` survive a reconnect on the same
 * instance, so only the room join needs repeating.
 *
 * #647 — Socket.IO rooms are not reference-counted: one `unsubscribe:*` (or
 * `presence:leave`) removes the whole socket from the room, silencing every
 * other still-mounted follower on the page that shares it — the #430 shape
 * `job-rooms.ts` fixes for job rooms. A subscription that has an unsubscribe
 * therefore names its room, and the unsubscribe is sent only when the last
 * follower of that room on this socket releases. Each follower still sends its
 * own subscribe (and re-subscribe on reconnect): the server joins idempotently,
 * and a follower that arrives later may need the server's response to it.
 *
 * #672 — the room key used to be a free-form string passed beside the
 * unsubscribe, so a mistyped key, or two features sharing a key with different
 * unsubscribe events, silently broke the count. A room follow now comes only
 * from a factory in `socket-rooms.ts`, which derives the key from the
 * `@metis/shared` room name the server joins and pairs it with that room's own
 * subscribe and unsubscribe events.
 *
 * #646 — re-joining makes updates resume, but an event the server emitted while
 * the socket was down is gone. A follower may pass a `reconcile` callback that
 * runs on each reconnect, right after the re-subscribe, to re-read the state it
 * may have missed (invalidate its queries, refetch a status). It also runs on
 * the connect that flushes a subscribe buffered while the socket was down: a
 * view mounted mid-gap read on mount, and an event emitted between that read
 * and the connect would otherwise stay missed. Only the re-subscribe is skipped
 * there, since socket.io-client sends the buffered emit itself. A view mounted
 * on a connected socket is not reconciled until a later connect; its mount-time
 * read covers it. The extra refetch on a buffered connect is cheap: TanStack
 * dedups one already in flight.
 *
 * Known window: the re-subscribe is a socket emit and the reconcile is an HTTP
 * read, and nothing orders the server's room join before it answers the read.
 * An event emitted after the read is served but before the join lands (a few
 * milliseconds) is still missed, until the next event or reconnect.
 *
 * #682 — the server may refuse a room join over its join rate limit with a
 * room-scoped `auth:error { code: "RATE_LIMITED", retryAfterMs }`. That join
 * was legitimate, only early, so a room follower whose room is named sends its
 * subscribe again after `retryAfterMs` plus a little jitter
 * (`socket-rate-limit.ts`) — if it has not been released and the socket is up
 * by then; a reconnect re-subscribes anyway and cancels the pending retry. An
 * authorization refusal (no `code`) changes nothing here: the follower keeps
 * re-subscribing on reconnect, exactly as before. A `keepSubscribed` follower
 * is never left, but it is named too when built from a `RoomJoin` factory
 * (`projectJoin`, `schedulerJoin`), so its rate-limited join is retried the
 * same way; it still takes no part in the reference count.
 */
import type { Socket } from "socket.io-client";
import type { SocketAuthErrorEvent } from "@metis/shared";
import { rateLimitRetryDelay } from "./socket-rate-limit";

/** The socket surface this helper needs; the typed app socket satisfies it. */
type SubscriptionSocket = Pick<Socket, "on" | "off" | "connected">;

/**
 * #682 — a join of a server room that is never left: how to join it, and the
 * room it is, so a rate-limited refusal of the join can be matched. Build it
 * with a factory from `socket-rooms.ts`, never by hand (#672).
 */
export interface RoomJoin {
  /** The server's room name, as a refusal of this join names it. */
  room: string;
  subscribe: () => void;
}

/**
 * One follower of a server room: how to join it, how to leave it, and the room
 * it is. Build it with a factory from `socket-rooms.ts`, never by hand — the
 * factories are what keep `room` equal to the room the events join (#672).
 */
export interface RoomFollow extends RoomJoin {
  /** The server's room name; followers that share it share one membership. */
  room: string;
  unsubscribe: () => void;
}

/** Live followers per room key, per socket (#647). */
const followers = new WeakMap<SubscriptionSocket, Map<string, number>>();

function countsFor(socket: SubscriptionSocket): Map<string, number> {
  let counts = followers.get(socket);
  if (!counts) {
    counts = new Map();
    followers.set(socket, counts);
  }
  return counts;
}

/**
 * #672 — a snapshot of the live follower count per room on `socket`. Lets a
 * call site's test pin the room key it uses to the server's room name.
 *
 * @internal Test-only; production code follows rooms through `keepRoomSubscribed`.
 */
export function followedRooms(socket: SubscriptionSocket): ReadonlyMap<string, number> {
  return new Map(followers.get(socket));
}

/** The subscribe of a follower that joins nothing (`onReconnect`). */
const noop = () => {};

function follow(
  socket: SubscriptionSocket,
  subscribe: () => void,
  room: string | undefined,
  leave: RoomFollow | undefined,
  reconcile: (() => void) | undefined,
): () => void {
  if (leave) {
    const counts = countsFor(socket);
    counts.set(leave.room, (counts.get(leave.room) ?? 0) + 1);
  }
  // Only a subscription that emits something can have it buffered (#646: the
  // reconcile-only `onReconnect` has nothing to flush).
  let buffered = subscribe !== noop && !socket.connected;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const cancelRetry = () => {
    clearTimeout(retry);
    retry = undefined;
  };
  const onConnect = () => {
    cancelRetry();
    if (buffered) buffered = false;
    else subscribe();
    reconcile?.();
  };
  // #682 — only a follower that knows its room can be named by a refusal.
  const onAuthError = (data: SocketAuthErrorEvent | undefined) => {
    if (room === undefined || data?.room !== room || retry !== undefined) return;
    const delay = rateLimitRetryDelay(data);
    if (delay === undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (socket.connected) subscribe();
    }, delay);
  };
  // Listen before subscribing, so no refusal of this subscribe can be missed.
  socket.on("connect", onConnect);
  if (room !== undefined) socket.on("auth:error", onAuthError);
  subscribe();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    cancelRetry();
    socket.off("connect", onConnect);
    if (room !== undefined) socket.off("auth:error", onAuthError);
    if (!leave) return;
    const counts = countsFor(socket);
    const remaining = (counts.get(leave.room) ?? 1) - 1;
    if (remaining > 0) {
      counts.set(leave.room, remaining);
      return;
    }
    counts.delete(leave.room);
    leave.unsubscribe();
  };
}

/**
 * Run `subscribe` now and again on every reconnect, for a subscription that is
 * never left (it has no unsubscribe), then `reconcile` (#646). Returns an
 * idempotent release that stops re-subscribing.
 *
 * #682 — pass a `RoomJoin` (`projectJoin`, `schedulerJoin`) rather than a bare
 * function and a rate-limited refusal of that room is re-subscribed after its
 * delay. A bare function has no room for a refusal to name, so is never retried.
 */
export function keepSubscribed(
  socket: SubscriptionSocket,
  subscribe: (() => void) | RoomJoin,
  reconcile?: () => void,
): () => void {
  if (typeof subscribe === "function") {
    return follow(socket, subscribe, undefined, undefined, reconcile);
  }
  return follow(socket, subscribe.subscribe, subscribe.room, undefined, reconcile);
}

/**
 * Join `room.room` now and again on every reconnect, then `reconcile` (#646).
 * Returns an idempotent release that stops re-joining and sends the
 * unsubscribe once the last follower of that room on this socket releases
 * (#647).
 */
export function keepRoomSubscribed(
  socket: SubscriptionSocket,
  room: RoomFollow,
  reconcile?: () => void,
): () => void {
  return follow(socket, room.subscribe, room.room, room, reconcile);
}

/**
 * #646 — run `reconcile` on every reconnect, for a view that listens to events
 * delivered without a room subscription of its own. Same rules as the
 * `reconcile` of `keepSubscribed`. Returns an idempotent release.
 */
export function onReconnect(socket: SubscriptionSocket, reconcile: () => void): () => void {
  return follow(socket, noop, undefined, undefined, reconcile);
}
