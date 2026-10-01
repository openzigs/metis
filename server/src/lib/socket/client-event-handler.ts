/**
 * #658 — register a client-event handler so that its failure cannot crash the
 * API process.
 *
 * socket.io 4.x dispatches a client event's listeners from `process.nextTick`
 * with no try/catch, so a listener that throws synchronously is an
 * `uncaughtException`, and an async listener whose promise rejects is an
 * `unhandledRejection`. Node exits on either, so any signed-in user who could
 * make one handler fail took every other user's connection down with it.
 * #652 / #654 removed every known way to do that; this closes the class.
 *
 * `onClientEvent(socket, event, handler)` is the only way a handler is
 * registered on a server-side socket — `socket.on(...)` is a lint error in
 * `server/src` (see `eslint.config.mjs`). The wrapper:
 *   - catches a synchronous throw;
 *   - catches a rejection of the promise the handler RETURNS. A handler that
 *     starts async work must return (or `await`) it: a promise it discards with
 *     `void` is out of reach, exactly as before;
 *   - logs the failure at `error` with the event name and socket id, and leaves
 *     the socket connected. Nothing is sent to the client — the error text is
 *     server-side detail.
 *
 * Decision — no process-level `uncaughtException` / `unhandledRejection`
 * handler is registered. A throw that escapes this wrapper is a genuine fault
 * somewhere else, and Node's default (print the stack, exit non-zero so the
 * supervisor restarts the replica) is the right answer to it; a listener that
 * merely logged would replace that exit with a process running in an unknown
 * state, and one that logged and re-exited would only duplicate the stack Node
 * already prints.
 */
import type { ClientToServerEvents } from "@metis/shared";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket");

/** Every event a server-side socket listens for: the client's, plus `disconnect`. */
export interface ClientEventListeners extends ClientToServerEvents {
  disconnect: (reason: string) => void;
}

export type ClientEventName = keyof ClientEventListeners;

/** A handler for `event`; it may return a promise, whose rejection is caught. */
export type ClientEventHandler<E extends ClientEventName> = (
  ...args: Parameters<ClientEventListeners[E]>
) => unknown;

/**
 * The socket surface needed here. `on`'s parameters are `never` so that a
 * socket.io `Socket` (whose `on` is generic over its event map) is assignable.
 */
export interface ClientEventSocket {
  id: string;
  on(event: never, listener: never): unknown;
}

type RawOn = (event: string, listener: (...args: unknown[]) => unknown) => unknown;

function logFailure(event: string, socketId: string, err: unknown): void {
  log.error("Socket handler failed", {
    event,
    socketId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}

/** Register `handler` for `event` on `socket`, containing any failure (see above). */
export function onClientEvent<E extends ClientEventName>(
  socket: ClientEventSocket,
  event: E,
  handler: ClientEventHandler<E>,
): void {
  // Returns the contained promise (which never rejects) so a caller that
  // invokes the listener directly — a unit test's fake socket — can await the
  // handler's work. socket.io ignores a listener's return value.
  const contained = (...args: unknown[]): Promise<void> | undefined => {
    let result: unknown;
    try {
      result = (handler as (...a: unknown[]) => unknown)(...args);
    } catch (err) {
      logFailure(event, socket.id, err);
      return undefined;
    }
    if (result instanceof Promise) {
      return result.then(
        () => undefined,
        (err: unknown) => logFailure(event, socket.id, err),
      );
    }
    return undefined;
  };
  (socket.on as unknown as RawOn).call(socket, event, contained);
}
