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
 * #582 follow-up — single-flight for the proxy-side refresh.
 *
 * The server's refresh is strictly one-winner: a refresh token rotates exactly
 * once, and every other request presenting it is refused (401). A navigation
 * plus its RSC prefetches, or two tabs, can reach `proxy.ts` together with the
 * same lapsed access cookie and the same refresh cookie — without coordination
 * every loser would be bounced to /login. So within this process, concurrent
 * callers presenting one refresh token share ONE upstream call, and callers
 * arriving within `REFRESH_RESULT_TTL_MS` after it succeeded reuse its rotated
 * pair (so they set the same cookies the winner did).
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

interface RefreshFlight {
  promise: Promise<RotatedTokens | null>;
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
 * 401 `REFRESH_FAILED`), a malformed body, or a network error. It NEVER throws;
 * callers treat `null` as "refresh not possible → fall back to /login".
 *
 * Security: only the refresh token is forwarded server-to-server; nothing is
 * trusted from the client beyond the HttpOnly cookie value, and tokens are
 * never logged.
 */
export async function refreshUpstreamTokens(
  refreshTokenValue: string | undefined,
): Promise<RotatedTokens | null> {
  if (!refreshTokenValue) return null;
  let key: string;
  try {
    key = await refreshKey(refreshTokenValue);
  } catch {
    return null;
  }
  // Everything from here to the `set` is synchronous, so two callers resumed
  // from the digest cannot both miss the map.
  const now = Date.now();
  const existing = refreshFlights.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  if (existing) refreshFlights.delete(key);

  evictForInsert(now);
  const flight: RefreshFlight = {
    promise: fetchRotatedTokens(refreshTokenValue),
    expiresAt: Number.POSITIVE_INFINITY,
  };
  refreshFlights.set(key, flight);
  const result = await flight.promise;
  // Only the entry this call created is updated — an evicted or replaced one
  // belongs to someone else by now.
  if (refreshFlights.get(key) === flight) {
    if (result) flight.expiresAt = Date.now() + REFRESH_RESULT_TTL_MS;
    else refreshFlights.delete(key);
  }
  return result;
}

async function fetchRotatedTokens(refreshTokenValue: string): Promise<RotatedTokens | null> {
  try {
    const upstream = await fetch(`${UPSTREAM_API_BASE}/auth/refresh`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Cookie: `${UPSTREAM_REFRESH_COOKIE}=${refreshTokenValue}`,
      },
    });
    if (!upstream.ok) return null;
    const json = (await upstream.json().catch(() => null)) as {
      data?: { accessToken?: string; refreshToken?: string };
    } | null;
    const accessToken = json?.data?.accessToken;
    const refreshToken = json?.data?.refreshToken;
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
  } catch {
    return null;
  }
}

/** Set the rotated Next-origin cookies (`metis.at` / `metis.rt`) on a response. */
export function applyRotatedCookies(response: NextResponse, tokens: RotatedTokens): void {
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, ACCESS_OPTS);
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, REFRESH_OPTS);
}
