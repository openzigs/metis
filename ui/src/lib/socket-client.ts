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
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Socket } from "socket.io-client";
import { setOnRefreshSuccess } from "./api-client";

let socketRef: Socket | null = null;

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";

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
  socket.on("auth:error", (data: { message: string }) => {
    setState({ error: data?.message ?? "Authentication error" });
  });

  // Reconnection events live on the Manager in socket.io v4.
  const manager = socket.io;
  manager.on("reconnect_attempt", () => {
    setState({ status: "reconnecting" });
  });
  manager.on("reconnect", () => {
    setState({ status: "connected", error: null });
  });
  manager.on("reconnect_failed", () => {
    setState({ status: "disconnected" });
  });
}

async function getSocket(): Promise<Socket> {
  // Return existing socket regardless of connection state — avoids creating a
  // second socket while the first is still connecting (race condition under HMR
  // / React Fast Refresh).
  if (socketRef) return socketRef;
  const { io } = await import("socket.io-client");
  // Connect directly to the Express server — Next.js cannot proxy WebSocket upgrades.
  socketRef = io(SOCKET_URL, {
    path: "/socket.io",
    transports: ["websocket"],
    withCredentials: true,
  });
  registerLifecycle(socketRef);
  // #414 — now that a socket exists, subscribe (once) to refresh-success so a
  // renewed access cookie forces a re-handshake instead of a silent dead socket.
  ensureRefreshSuccessSubscription();
  return socketRef;
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
        if (!cancelled) {
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
  // #414 — clear the refresh-success wiring + any pending renewal so each spec
  // starts from a clean slate.
  setOnRefreshSuccess(null);
  refreshSuccessRegistered = false;
  renewingForToken = false;
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
