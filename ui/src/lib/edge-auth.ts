import { type NextResponse } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE, UPSTREAM_API_BASE } from "@/lib/config";

/**
 * Auth helpers shared by the Node route-handler proxy (`auth-proxy.ts`) and
 * the auth gate (`proxy.ts`, #274). Next 16's `proxy.ts` runs on the Node.js
 * runtime (the `middleware.ts` convention it replaces is deprecated); everything here
 * still uses only `fetch` + plain objects, so it has no runtime dependency.
 *
 * Single source of truth for the Next-origin cookie attributes so a token
 * rotation set by the auth gate carries byte-identical HttpOnly/SameSite/Secure
 * options to one set from the proxy (#409 AC).
 */

/** Upstream cookie names — overridable via env so the proxy can target a
 *  backend that uses non-default cookie names (defaults match the Express server). */
export const UPSTREAM_ACCESS_COOKIE = process.env.METIS_UPSTREAM_ACCESS_COOKIE ?? "accessToken";
export const UPSTREAM_REFRESH_COOKIE = process.env.METIS_UPSTREAM_REFRESH_COOKIE ?? "refreshToken";

export interface CookieOpts {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge: number;
}

export const ACCESS_OPTS: CookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60,
};

export const REFRESH_OPTS: CookieOpts = { ...ACCESS_OPTS, maxAge: 7 * 24 * 60 * 60 };
export const CLEAR_OPTS: CookieOpts = { ...ACCESS_OPTS, maxAge: 0 };

export interface RotatedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * #582 follow-up — single-flight for EVERY UI-side refresh.
 *
 * The server's refresh is strictly one-winner: a refresh token rotates exactly
 * once, and every other request presenting it is refused (401). Two paths in
 * this process present the browser's refresh cookie upstream: the auth gate
 * (`proxy.ts`, on a page request whose access cookie lapsed) and the
 * `/api/auth/refresh` route (`auth-proxy.ts`, which the browser api-client
 * calls on a 401 or from its sliding-session timer). A navigation plus its RSC
 * prefetches, two tabs each running the api-client, or a tab's api-client
 * racing a page request can all present the same refresh cookie at once —
 * without coordination every loser would be sent to /login. Both paths go
 * through `refreshUpstream` below, so within this process concurrent callers
 * presenting one refresh token share ONE upstream call and all receive the same
 * status, body and rotated cookies; callers arriving within
 * `REFRESH_RESULT_TTL_MS` after it succeeded reuse its rotated pair.
 *
 * The api-client has its own per-tab single-flight (`refreshOnce`); that one
 * only coalesces callers inside one tab. Cross-tab and cross-path coalescing is
 * this map's job.
 *
 * - Keyed by a SHA-256 of the refresh token, never the raw token.
 * - Bounded: at most `REFRESH_CACHE_MAX_ENTRIES` keys; expired entries are
 *   swept on insert, then the oldest are evicted. A failed refresh is never
 *   cached, so a transient upstream error is not sticky.
 * - Residual (accepted): this is per process. Several UI server instances behind
 *   a load balancer can still race on one refresh token; the server refuses the
 *   loser, and that request simply re-authenticates via /login. The replay
 *   window this cache adds is `REFRESH_RESULT_TTL_MS`, and only for a holder of
 *   the refresh token that was JUST rotated — the same holder the server would
 *   have handed a pair to a moment earlier.
 */
export const REFRESH_RESULT_TTL_MS = 5_000;
export const REFRESH_CACHE_MAX_ENTRIES = 500;

/**
 * The outcome of one upstream `/auth/refresh`, shared by every caller of a
 * flight. `body` is the upstream JSON envelope with the tokens still in it —
 * treat it as read-only and strip the tokens before it reaches a browser.
 */
export interface UpstreamRefreshResult {
  /** Upstream HTTP status; 502 when the upstream could not be reached. */
  status: number;
  body: unknown;
  /** The rotated pair — present only on a 2xx carrying both tokens. */
  tokens: RotatedTokens | null;
  /** Upstream `Retry-After`, forwarded on a retryable (5xx) refusal. */
  retryAfter: string | null;
}

interface RefreshFlight {
  promise: Promise<UpstreamRefreshResult>;
  /** `Infinity` while in flight; `settledAt + TTL` once it succeeded. */
  expiresAt: number;
}

const refreshFlights = new Map<string, RefreshFlight>();

/** Test hook: forget every in-flight and cached refresh. */
export function resetRefreshSingleFlight(): void {
  refreshFlights.clear();
}

/** Number of tracked refresh keys (test hook for the size bound). */
export function refreshSingleFlightSize(): number {
  return refreshFlights.size;
}

async function refreshKey(refreshTokenValue: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refreshTokenValue));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function evictForInsert(now: number): void {
  for (const [key, flight] of refreshFlights) {
    if (flight.expiresAt <= now) refreshFlights.delete(key);
  }
  // Map iteration is insertion order, so this drops the oldest first. Evicting
  // an in-flight entry only costs its de-duplication, never correctness.
  while (refreshFlights.size >= REFRESH_CACHE_MAX_ENTRIES) {
    const oldest = refreshFlights.keys().next().value;
    if (oldest === undefined) break;
    refreshFlights.delete(oldest);
  }
}

/**
 * Attempt a token refresh against the upstream Express `/auth/refresh`,
 * presenting the refresh token as the upstream `refreshToken` cookie (the
 * server reads `cookies.refreshToken ?? body.refreshToken`). The upstream
 * verifies and ROTATES the refresh token, so this both renews the access token
 * and returns a fresh refresh token. Single-flight per refresh token within the
 * process — see the block comment above.
 *
 * Returns the rotated pair on success, or `null` on ANY failure — missing/empty
 * input, a non-2xx response (e.g. an expired/invalid/revoked refresh token →
 * 401 `REFRESH_FAILED`, or a retryable 503 `REFRESH_UNAVAILABLE`), a malformed
 * body, or a network error. It NEVER throws. Callers that must tell "retry"
 * apart from "log in again" use `refreshUpstream` and read the status.
 *
 * Security: only the refresh token is forwarded server-to-server; nothing is
 * trusted from the client beyond the HttpOnly cookie value, and tokens are
 * never logged.
 */
export async function refreshUpstreamTokens(
  refreshTokenValue: string | undefined,
): Promise<RotatedTokens | null> {
  return (await refreshUpstream(refreshTokenValue))?.tokens ?? null;
}

/**
 * The single-flight upstream refresh itself — `refreshUpstreamTokens` and the
 * `/api/auth/refresh` route both call this. Returns `null` only when there is no
 * refresh token to present; otherwise the shared upstream outcome, success or
 * not. Never throws.
 */
export async function refreshUpstream(
  refreshTokenValue: string | undefined,
): Promise<UpstreamRefreshResult | null> {
  if (!refreshTokenValue) return null;
  let key: string;
  try {
    key = await refreshKey(refreshTokenValue);
  } catch {
    return unreachable();
  }
  // Everything from here to the `set` is synchronous, so two callers resumed
  // from the digest cannot both miss the map.
  const now = Date.now();
  const existing = refreshFlights.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  if (existing) refreshFlights.delete(key);

  evictForInsert(now);
  const flight: RefreshFlight = {
    promise: fetchUpstreamRefresh(refreshTokenValue),
    expiresAt: Number.POSITIVE_INFINITY,
  };
  refreshFlights.set(key, flight);
  const result = await flight.promise;
  // Only the entry this call created is updated — an evicted or replaced one
  // belongs to someone else by now.
  if (refreshFlights.get(key) === flight) {
    if (result.tokens) flight.expiresAt = Date.now() + REFRESH_RESULT_TTL_MS;
    else refreshFlights.delete(key);
  }
  return result;
}

function unreachable(): UpstreamRefreshResult {
  return {
    status: 502,
    body: {
      success: false,
      error: { code: "UPSTREAM_UNREACHABLE", message: "Authentication service unreachable" },
    },
    tokens: null,
    retryAfter: null,
  };
}

async function fetchUpstreamRefresh(refreshTokenValue: string): Promise<UpstreamRefreshResult> {
  try {
    const upstream = await fetch(`${UPSTREAM_API_BASE}/auth/refresh`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Cookie: `${UPSTREAM_REFRESH_COOKIE}=${refreshTokenValue}`,
      },
    });
    const body = (await upstream.json().catch(() => null)) as {
      data?: { accessToken?: string; refreshToken?: string };
    } | null;
    const accessToken = body?.data?.accessToken;
    const refreshToken = body?.data?.refreshToken;
    return {
      status: upstream.status,
      body,
      tokens: upstream.ok && accessToken && refreshToken ? { accessToken, refreshToken } : null,
      retryAfter: upstream.headers?.get?.("retry-after") ?? null,
    };
  } catch {
    return unreachable();
  }
}

/** True when a refresh was refused for a transient reason — retry, don't log out. */
export function isRetryableRefreshStatus(status: number): boolean {
  return status >= 500;
}

/** Set the rotated Next-origin cookies (`metis.at` / `metis.rt`) on a response. */
export function applyRotatedCookies(response: NextResponse, tokens: RotatedTokens): void {
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, ACCESS_OPTS);
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, REFRESH_OPTS);
}
