import { type NextResponse } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE, UPSTREAM_API_BASE } from "@/lib/config";

/**
 * Edge-safe auth helpers shared by the Node route-handler proxy
 * (`auth-proxy.ts`) and the Edge middleware (`middleware.ts`). Everything here
 * uses only `fetch` + plain objects so it is safe under the Next.js Edge
 * runtime (no Node-only APIs).
 *
 * Single source of truth for the Next-origin cookie attributes so a token
 * rotation set from the edge carries byte-identical HttpOnly/SameSite/Secure
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
 * Attempt a token refresh against the upstream Express `/auth/refresh`,
 * presenting the refresh token as the upstream `refreshToken` cookie (the
 * server reads `cookies.refreshToken ?? body.refreshToken`). The upstream
 * verifies and ROTATES the refresh token, so this both renews the access token
 * and returns a fresh refresh token.
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
