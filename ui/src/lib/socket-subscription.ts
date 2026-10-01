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
 * buffer and is flushed on the next connect, so that one connect is skipped —
 * the same rule `job-rooms.ts` (#486) applies to job rooms.
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
 */
import type { Socket } from "socket.io-client";

/** The socket surface this helper needs; the typed app socket satisfies it. */
type SubscriptionSocket = Pick<Socket, "on" | "off" | "connected">;

/**
 * One follower of a server room: how to join it, how to leave it, and the room
 * it is. Build it with a factory from `socket-rooms.ts`, never by hand — the
 * factories are what keep `room` equal to the room the events join (#672).
 */
export interface RoomFollow {
  /** The server's room name; followers that share it share one membership. */
  room: string;
  subscribe: () => void;
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

function follow(
  socket: SubscriptionSocket,
  subscribe: () => void,
  leave: RoomFollow | undefined,
): () => void {
  if (leave) {
    const counts = countsFor(socket);
    counts.set(leave.room, (counts.get(leave.room) ?? 0) + 1);
  }
  let buffered = !socket.connected;
  const onConnect = () => {
    if (buffered) {
      buffered = false;
      return;
    }
    subscribe();
  };
  subscribe();
  socket.on("connect", onConnect);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    socket.off("connect", onConnect);
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
 * never left (it has no unsubscribe). Returns an idempotent release that stops
 * re-subscribing.
 */
export function keepSubscribed(socket: SubscriptionSocket, subscribe: () => void): () => void {
  return follow(socket, subscribe, undefined);
}

/**
 * Join `room.room` now and again on every reconnect. Returns an idempotent
 * release that stops re-joining and sends the unsubscribe once the last
 * follower of that room on this socket releases (#647).
 */
export function keepRoomSubscribed(socket: SubscriptionSocket, room: RoomFollow): () => void {
  return follow(socket, room.subscribe, room);
}
