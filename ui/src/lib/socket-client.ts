"use client";

/**
 * Tiny Socket.IO singleton for the UI. Only loaded when a hook calls it so
 * server-rendered pages never see the client lib.
 *
 * Epic #405 / Issue #415 — the singleton now registers connection-lifecycle
 * handlers and publishes a typed connection status through a module-level
 * subscribable store (`useSocketStatus`). The existing `useSocket(): Socket | null`
 * signature is unchanged (PresenceAvatars, collaboration, comments all consume
 * it), so this layers on without breaking callers. Token-refresh-on-reconnect is
 * deliberately NOT handled here — that is sibling issue #414; the lifecycle
 * handlers below are kept composable so #414 can layer on later.
 *
 * Epic #405 / Issue #414 — token-refresh-driven reconnect. The handshake reads
 * the 1h `metis.at` access cookie ONCE (cookie-only auth, no `socket.auth`
 * token). When that cookie is renewed by the api-client (`setOnRefreshSuccess`,
 * shared with the reactive 401 retry AND the proactive sliding-session timer
 * #410), socket.io's auto-reconnect would otherwise re-handshake with the SAME
 * stale cookie and the server rejects it `TOKEN_EXPIRED` — realtime silently
 * dies ~1h in. We subscribe to refresh-success and force a debounced
 * disconnect()+connect() so the NEXT handshake carries the FRESH cookie.
 *
 * #1414 — the server now closes a socket's transport when the access token it
 * was opened with expires. The proactive refresh above normally re-handshakes
 * the socket first; when it did not (a throttled background tab, a laptop that
 * slept), the reconnect is refused `TOKEN_EXPIRED`, and that refusal now
 * triggers one refresh, whose success re-handshakes the socket as above.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Socket } from "socket.io-client";
import type { SocketAuthErrorEvent } from "@metis/shared";
import { refreshAccessToken, setOnRefreshSuccess } from "./api-client";
import { browserSocketUrl } from "./socket-url";

let socketRef: Socket | null = null;
// #1391 — the in-flight connection. `getSocket()` awaits a dynamic import
// before it can call `io()`, so checking `socketRef` alone let every caller
// that arrived during that await open its own socket (three per page load).
// Concurrent callers now share this promise. It is cleared when it fails, so
// the next call retries, and by `closeSocket()`, so a new session starts fresh.
let pendingSocket: Promise<Socket> | null = null;
// Bumped by `closeSocket()`. An import that resolves after a close sees a
// different generation and opens nothing.
let socketGeneration = 0;

/** Rejection for a `getSocket()` whose connection was closed while it waited. */
export class SocketClosedError extends Error {
  constructor() {
    super("Realtime connection closed");
    this.name = "SocketClosedError";
  }
}

/**
 * Typed connection state surfaced to the UI:
 *  - `connected`      — handshake complete, live updates flowing.
 *  - `reconnecting`   — transient: connecting for the first time, or the
 *                       manager is retrying after a drop.
 *  - `disconnected`   — gave up / hard failure / auth rejected. Live updates
 *                       are paused.
 */
export type SocketStatus = "connected" | "reconnecting" | "disconnected";

interface SocketState {
  status: SocketStatus;
  /** Last `auth:error` / `connect_error` reason, surfaced to the user. */
  error: string | null;
}

// ---- Subscribable store (useSyncExternalStore-compatible) ------------------

let state: SocketState = { status: "reconnecting", error: null };
const listeners = new Set<() => void>();

function emitChange() {
  for (const l of listeners) l();
}

function setState(next: Partial<SocketState>) {
  const merged = { ...state, ...next };
  // Skip notifying React when nothing actually changed — avoids redundant
  // re-renders when, e.g., repeated reconnect_attempt events fire.
  if (merged.status === state.status && merged.error === state.error) return;
  state = merged;
  emitChange();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SocketState {
  return state;
}

// A stable snapshot for SSR / the very first client render before any socket
// lifecycle event has fired. Must be referentially stable across calls or
// useSyncExternalStore throws an infinite-loop warning.
const SERVER_SNAPSHOT: SocketState = { status: "reconnecting", error: null };
function getServerSnapshot(): SocketState {
  return SERVER_SNAPSHOT;
}

// ---- #414 token-refresh-driven reconnect -----------------------------------

/** Debounce window collapsing a burst of refresh-successes into one reconnect. */
const RECONNECT_DEBOUNCE_MS = 250;

let reconnectDebounceTimer: ReturnType<typeof setTimeout> | null = null;
// Set while a token-renewal disconnect is in flight so the `disconnect` handler
// (which sees reason "io client disconnect" and would otherwise map to a stuck
// `disconnected`) treats it as a deliberate renewal that WILL reconnect.
let renewingForToken = false;
// Ensures the refresh-success subscription is registered exactly once, no matter
// how many times getSocket() runs.
let refreshSuccessRegistered = false;

/**
 * Force the socket to re-handshake with the freshest `metis.at` cookie after a
 * successful token refresh (#414). Debounced so a single refresh — or rapid
 * back-to-back refreshes — causes EXACTLY ONE reconnect, and an in-flight
 * renewal never stacks another.
 *
 * GUARD 1: only acts when a socket actually exists (`socketRef !== null`). No
 * socket = nobody wants realtime yet → no-op.
 * GUARD 2: debounce collapses bursts into one disconnect()+connect().
 * GUARD 3: marks the manual disconnect as a renewal so the store shows
 * `reconnecting` (not stuck `disconnected`) around the cookie swap.
 */
function triggerTokenRefreshReconnect(): void {
  // GUARD 1 — no socket means nobody has asked for realtime yet.
  if (!socketRef) return;
  // GUARD 2 — collapse bursts; a renewal already queued must not stack another.
  if (reconnectDebounceTimer !== null) return;
  reconnectDebounceTimer = setTimeout(() => {
    reconnectDebounceTimer = null;
    const socket = socketRef;
    if (!socket) return;
    // GUARD 3 — deliberate renewal: hold the UI at `reconnecting` so the manual
    // "io client disconnect" does not park the banner at `disconnected`.
    renewingForToken = true;
    setState({ status: "reconnecting", error: null });
    socket.disconnect();
    socket.connect();
  }, RECONNECT_DEBOUNCE_MS);
}

/**
 * #1414 — at most one refresh per this window is started by a `TOKEN_EXPIRED`
 * handshake refusal, so a refresh that succeeds but whose re-handshake is
 * refused again cannot loop.
 */
const EXPIRED_TOKEN_REFRESH_COOLDOWN_MS = 30_000;
let lastExpiredTokenRefreshAt: number | null = null;

/**
 * #1414 — the server refused the handshake because the access cookie had
 * expired. Refresh it; a success fires `setOnRefreshSuccess`, which
 * re-handshakes with the fresh cookie (`triggerTokenRefreshReconnect`). A
 * failure leaves the socket down: the session is over, and the api-client's
 * own 401 handling signs the user out on their next request.
 */
function refreshAfterExpiredHandshake(): void {
  const now = Date.now();
  if (
    lastExpiredTokenRefreshAt !== null &&
    now - lastExpiredTokenRefreshAt < EXPIRED_TOKEN_REFRESH_COOLDOWN_MS
  ) {
    return;
  }
  lastExpiredTokenRefreshAt = now;
  void refreshAccessToken().catch(() => undefined);
}

/** Subscribe the token-refresh reconnect to the api-client's success signal once. */
function ensureRefreshSuccessSubscription(): void {
  if (refreshSuccessRegistered) return;
  refreshSuccessRegistered = true;
  setOnRefreshSuccess(() => {
    triggerTokenRefreshReconnect();
  });
}

/**
 * Register the connection-lifecycle handlers exactly once per socket. In
 * socket.io v4 the `connect` / `connect_error` / `disconnect` events live on the
 * Socket instance, while reconnection events (`reconnect`, `reconnect_attempt`)
 * live on the underlying Manager (`socket.io`). We also surface the server's
 * `auth:error` so a forbidden subscribe is no longer silently dropped.
 */
function registerLifecycle(socket: Socket): void {
  // Initialise from the socket's current state so a socket that is already
  // connected by the time the first hook mounts reports `connected`.
  setState({ status: socket.connected ? "connected" : "reconnecting", error: null });

  socket.on("connect", () => {
    setState({ status: "connected", error: null });
  });

  socket.on("connect_error", (err: Error) => {
    // The manager keeps retrying after a connect_error (unless reconnection is
    // disabled), so treat this as "still trying" but surface the reason.
    setState({ status: "reconnecting", error: err?.message ?? "Connection error" });
    if (err?.message === "TOKEN_EXPIRED") refreshAfterExpiredHandshake();
  });

  socket.on("disconnect", (reason: string) => {
    // #414 — a token-renewal disconnect is a deliberate "io client disconnect"
    // that WILL be followed by an immediate manual connect(). Treat it as
    // `reconnecting` so the UI is never parked at `disconnected` mid-renewal.
    if (renewingForToken) {
      renewingForToken = false;
      setState({ status: "reconnecting", error: null });
      return;
    }
    // "io client disconnect" / "io server disconnect" are intentional and will
    // NOT auto-reconnect; everything else triggers the manager's retry loop.
    const willRetry = reason !== "io client disconnect" && reason !== "io server disconnect";
    setState({ status: willRetry ? "reconnecting" : "disconnected" });
  });

  // Server emits `auth:error` on a forbidden subscribe (server/src/lib/socket/
  // server.ts). Surface it instead of dropping it. Reflected both as the store
  // error (for any status-aware UI) and — because the connection itself may
  // still be healthy — left to the UI layer to toast.
  //
  // #655 — a refusal that names a `room` belongs to that room's follower, not
  // to the user: job rooms are re-subscribed automatically on every reconnect,
  // and a job the server has since forgotten is refused (`job-rooms.ts` drops
  // it). Toasting that would show the user who started the job an error for
  // nothing they did.
  socket.on("auth:error", (data: SocketAuthErrorEvent) => {
    if (data?.room) return;
    setState({ error: data?.message ?? "Authentication error" });
  });

  // Reconnection events live on the Manager in socket.io v4.
  const manager = socket.io;
  manager.on("reconnect_attempt", onManagerReconnectAttempt);
  manager.on("reconnect", onManagerReconnect);
  manager.on("reconnect_failed", onManagerReconnectFailed);
}

// Module-level so `closeSocket()` can remove exactly these from the Manager.
// The Manager also carries the library's own internal subscriptions, so
// clearing it wholesale is not safe (#1391). A later socket does not reuse this
// Manager: socket.io-client 4.8.4's `lookup()` makes a new one whenever the
// cached Manager already holds the namespace (`cache[id].nsps`), and a Manager
// never forgets one.
function onManagerReconnectAttempt(): void {
  setState({ status: "reconnecting" });
}
function onManagerReconnect(): void {
  setState({ status: "connected", error: null });
}
function onManagerReconnectFailed(): void {
  setState({ status: "disconnected" });
}

type SocketIoModule = Pick<typeof import("socket.io-client"), "io">;
const defaultSocketIoLoader = (): Promise<SocketIoModule> => import("socket.io-client");
// #1391 — the dynamic import behind `getSocket()`. Injectable only so a test
// can hold two attempts open at once and settle them in a chosen order.
let loadSocketIo: () => Promise<SocketIoModule> = defaultSocketIoLoader;

function getSocket(): Promise<Socket> {
  // Return the existing socket regardless of connection state, and share the
  // in-flight attempt, so every hook on the page gets the SAME socket (#1391).
  if (socketRef) return Promise.resolve(socketRef);
  if (pendingSocket) return pendingSocket;
  const generation = socketGeneration;
  const attempt = loadSocketIo().then(({ io }) => {
    if (generation !== socketGeneration) throw new SocketClosedError();
    // Connect directly to the Express server — Next.js cannot proxy WebSocket upgrades.
    // #1377 — resolved at connect time, not baked at build: the page's own origin
    // unless the UI server supplies an override (see socket-url.ts).
    const socket = io(browserSocketUrl(), {
      path: "/socket.io",
      transports: ["websocket"],
      withCredentials: true,
    });
    socketRef = socket;
    registerLifecycle(socket);
    // #414 — now that a socket exists, subscribe (once) to refresh-success so a
    // renewed access cookie forces a re-handshake instead of a silent dead socket.
    ensureRefreshSuccessSubscription();
    return socket;
  });
  pendingSocket = attempt;
  // Free the slot once settled, but only if it is still this attempt's: on
  // success `socketRef` answers later calls, on failure the next call retries.
  const settle = () => {
    if (pendingSocket === attempt) pendingSocket = null;
  };
  attempt.then(settle, settle);
  return attempt;
}

/**
 * Close the shared socket and forget it, so the next `getSocket()` opens a new
 * one (#1391). Called whenever the session ends: on sign-out, and when a failed
 * token refresh clears the user (auth-context.tsx). A socket left open would
 * stay authenticated as the old user until the server closes it (#1414: on
 * logout, or when its token expires), and a different user signing in within
 * the same tab would inherit it. An attempt still loading when this runs opens nothing and rejects with
 * `SocketClosedError`.
 */
export function closeSocket(): void {
  socketGeneration += 1;
  pendingSocket = null;
  if (reconnectDebounceTimer !== null) {
    clearTimeout(reconnectDebounceTimer);
    reconnectDebounceTimer = null;
  }
  renewingForToken = false;
  const socket = socketRef;
  socketRef = null;
  if (socket) {
    // Detach every handler first: the lifecycle ones, and the ones hooks
    // registered for their rooms. A closed socket must not write to the status
    // store or call back into components of the old session.
    socket.removeAllListeners();
    socket.io.off("reconnect_attempt", onManagerReconnectAttempt);
    socket.io.off("reconnect", onManagerReconnect);
    socket.io.off("reconnect_failed", onManagerReconnectFailed);
    socket.disconnect();
  }
  // Back to the "not connected yet" baseline that the next session starts from.
  setState({ status: "reconnecting", error: null });
}

export function useSocket(): Socket | null {
  const [socket, setSocket] = useState<Socket | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSocket()
      .then((s) => {
        if (!cancelled) setSocket(s);
      })
      .catch((err: unknown) => {
        // #415 — do NOT swallow the failure silently. Route it to the status
        // store so the connection-status banner can surface it, then keep the
        // hook contract (`Socket | null`) intact for existing callers.
        // #1391 — a deliberate close is not a failure to report. The hook
        // stays null by design and does not retry: `closeSocket()` runs only
        // when the session ends, and every consumer sits under the signed-in
        // shell, so it unmounts. The next session's hooks mount fresh and open
        // a new socket.
        if (!cancelled && !(err instanceof SocketClosedError)) {
          setSocket(null);
          setState({
            status: "disconnected",
            error: err instanceof Error ? err.message : "Failed to load realtime connection",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return socket;
}

/**
 * Subscribe to the live connection status + last error. Backed by
 * `useSyncExternalStore` over the module-level store so every consumer shares a
 * single source of truth and updates tear-free.
 */
export function useSocketStatus(): SocketState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Test-only reset hook. Lets unit tests drive lifecycle handlers from a known
 * baseline without leaking store state between cases. Not used in production.
 */
export function __resetSocketStatusForTests(): void {
  state = { status: "reconnecting", error: null };
  socketRef = null;
  pendingSocket = null;
  socketGeneration += 1;
  loadSocketIo = defaultSocketIoLoader;
  // #414 — clear the refresh-success wiring + any pending renewal so each spec
  // starts from a clean slate.
  setOnRefreshSuccess(null);
  refreshSuccessRegistered = false;
  renewingForToken = false;
  lastExpiredTokenRefreshAt = null;
  if (reconnectDebounceTimer !== null) {
    clearTimeout(reconnectDebounceTimer);
    reconnectDebounceTimer = null;
  }
  emitChange();
}

/**
 * Test-only seam (#414): invoke the token-refresh reconnect directly so a spec
 * can assert the `socketRef === null` no-op guard without standing up a socket.
 * Production code reaches this path only via the `setOnRefreshSuccess` callback.
 */
export function __triggerTokenRefreshReconnectForTests(): void {
  triggerTokenRefreshReconnect();
}

/**
 * Test-only seam (#1391): replace the `socket.io-client` dynamic import so a
 * spec can hold attempts open and settle them in a chosen order. Vitest cannot
 * do this with `vi.mock` alone: when two dynamic imports of a mocked module
 * are in flight at once, it resolves the second to the real module.
 * `__resetSocketStatusForTests` restores the real import.
 *
 * Refuses in a production build, where it would let any code that can import
 * this module swap the realtime client.
 */
export function __setSocketIoLoaderForTests(loader: () => Promise<SocketIoModule>): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setSocketIoLoaderForTests is not available in production");
  }
  loadSocketIo = loader;
}
