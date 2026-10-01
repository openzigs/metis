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
 * Event listeners registered with `socket.on` survive a reconnect on the same
 * instance, so only the room join needs repeating.
 */
import type { Socket } from "socket.io-client";

/** The socket surface this helper needs; the typed app socket satisfies it. */
type SubscriptionSocket = Pick<Socket, "on" | "off" | "connected">;

/**
 * Run `subscribe` now and again on every reconnect. Returns an idempotent
 * release that stops re-subscribing and runs `unsubscribe` (if given) once.
 */
export function keepSubscribed(
  socket: SubscriptionSocket,
  subscribe: () => void,
  unsubscribe?: () => void,
): () => void {
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
    unsubscribe?.();
  };
}
