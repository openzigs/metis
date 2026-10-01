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
 */
import type { Socket } from "socket.io-client";

/** The socket surface this helper needs; the typed app socket satisfies it. */
type SubscriptionSocket = Pick<Socket, "on" | "off" | "connected">;

/** How a subscription leaves its room, and which room that is. */
export interface RoomRelease {
  /**
   * Identifies the room per socket, e.g. `thread:{id}`. Followers that share a
   * key share one membership; the unsubscribe goes out when the last releases.
   */
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
 * Run `subscribe` now and again on every reconnect. Returns an idempotent
 * release that stops re-subscribing and, if `leave` is given, runs its
 * `unsubscribe` once the last follower of `leave.room` on this socket releases.
 */
export function keepSubscribed(
  socket: SubscriptionSocket,
  subscribe: () => void,
  leave?: RoomRelease,
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
