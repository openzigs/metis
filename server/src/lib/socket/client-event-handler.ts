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
 * Three wrappers, one per way async socket work can fail outside a try/catch:
 *   - `onClientEvent(socket, event, handler)` registers a client-event handler.
 *     It catches a synchronous throw and a rejection of the promise — or any
 *     other thenable, such as a lazy PrismaPromise — the handler RETURNS, logs
 *     it at `error` with the event name and socket id, and leaves the socket
 *     connected. Nothing is sent to the client: the error text is server-side
 *     detail.
 *   - `onConnection(io, attach)` registers the `connection` listener, which
 *     socket.io also runs from `process.nextTick` with no try/catch. A throw
 *     from `attach` is logged and disconnects that one socket.
 *   - `runDetached(work, what, socketId)` takes async work started mid-handler
 *     that nothing waits on (a `socket.join` / `socket.leave`), in place of
 *     `void work`, and logs its rejection.
 *
 * Enforced by ESLint (`eslint.config.mjs`), on non-test files only:
 *   - anywhere in `server/src`: `on`, `once`, `addListener`, `prependListener`,
 *     `prependOnceListener` or `onAny` called on an object named `socket`
 *     (`socket.on(...)`, `this.socket.once(...)`) — `no-restricted-syntax`;
 *   - in `server/src/lib/socket/**` and `collaboration/presence.ts`: the same
 *     methods called on ANY object (`s.on`, `client.once`, `io.on`), except
 *     `asRelayServer(io).on(...)`, the replica-to-replica relay in
 *     `revocation-relay.ts`. This file and `cluster-adapter.ts` (pg `Pool` and
 *     `Client` listeners only) are exempt;
 *   - in those same socket modules: a floating promise, `void` included —
 *     type-aware `@typescript-eslint/no-floating-promises` with
 *     `ignoreVoid: false`.
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

/** Anything with a callable `then`: a native promise or any other thenable. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

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
    let pending: PromiseLike<unknown>;
    try {
      const result = (handler as (...a: unknown[]) => unknown)(...args);
      if (!isThenable(result)) return undefined;
      pending = result;
    } catch (err) {
      logFailure(event, socket.id, err);
      return undefined;
    }
    // `Promise.resolve` adopts a non-native thenable too (a lazy PrismaPromise
    // returned directly), so its rejection is caught here as well — and a
    // `then` that throws becomes a rejection rather than an escape.
    return Promise.resolve(pending).then(
      () => undefined,
      (err: unknown) => logFailure(event, socket.id, err),
    );
  };
  (socket.on as unknown as RawOn).call(socket, event, contained);
}

/**
 * Start async work nothing waits on — a `socket.join` mid-handler, a
 * `socket.leave` loop, a re-check kicked off at connect — so that a rejection
 * is logged at `error` (with `what` and the socket id) instead of escaping as an
 * `unhandledRejection`, which `void work` would let it do. Timing is unchanged:
 * the caller does not wait. A non-native thenable is subscribed to, so lazy
 * work runs. Type-aware `no-floating-promises` (`ignoreVoid: false`) enforces
 * this in the socket modules (`eslint.config.mjs`).
 */
export function runDetached(work: unknown, what: string, socketId?: string): void {
  if (!isThenable(work)) return;
  Promise.resolve(work).then(undefined, (err: unknown) => {
    log.error("Detached socket work failed", {
      what,
      socketId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
}

/** The socket surface `onConnection` needs to drop a socket it could not set up. */
export interface ConnectionSocket {
  id: string;
  disconnect(close?: boolean): unknown;
}

/**
 * Register `attach` as the server's `connection` listener. socket.io 4.x runs
 * `connection` listeners from `process.nextTick` with no try/catch
 * (`Namespace._doConnect`), so a synchronous throw while attaching handlers
 * would crash the process. A throw is logged at `error` with the socket id, and
 * that one socket is disconnected: it would otherwise stay connected with only
 * some of its handlers registered. `attach` is synchronous — a promise it
 * returns is not awaited, so async work belongs inside a handler.
 */
export function onConnection<S extends ConnectionSocket>(
  io: { on(event: "connection", listener: (socket: S) => void): unknown },
  attach: (socket: S) => void,
): void {
  const contained = (socket: S): void => {
    try {
      attach(socket);
    } catch (err) {
      log.error("Socket connection setup failed; disconnecting the socket", {
        socketId: socket.id,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        socket.disconnect(true);
      } catch (disconnectErr) {
        log.error("Socket disconnect after a failed setup also failed", {
          socketId: socket.id,
          error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        });
      }
    }
  };
  io.on("connection", contained);
}
