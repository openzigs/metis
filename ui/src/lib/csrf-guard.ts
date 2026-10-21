/**
 * #913 — cross-origin request refusal for the UI's API proxy routes.
 *
 * The browser holds the session as HttpOnly cookies on THIS origin
 * (`metis.at` / `metis.rt`, `SameSite=Lax`), and the `/api/*` proxy turns the
 * access cookie into the bearer token the API trusts. So the CSRF boundary of
 * the browser app is here, not at the API: a forged POST to `/api/...` that
 * carried the cookie would reach the API with a valid bearer token.
 * `SameSite=Lax` keeps the cookie off a cross-SITE POST; this refuses a
 * cross-ORIGIN one too (a sibling subdomain is the same site), and does not
 * rely on the browser's cookie policy alone.
 *
 * Same algorithm as Go 1.25's `http.CrossOriginProtection`, which needs no
 * token and no client change:
 *
 *  - `GET` / `HEAD` / `OPTIONS` pass.
 *  - `Sec-Fetch-Site` (sent by every current browser) must be `same-origin`
 *    or `none` (the user typed it / a bookmark).
 *  - Without it, an `Origin` header must name this host (`Host`, or the
 *    `X-Forwarded-Host` a reverse proxy set). A request with neither header
 *    is not from a browser that could be forged into sending it, so it passes:
 *    webhooks, Playwright's request API, curl.
 *  - `METIS_TRUSTED_ORIGINS` (comma-separated) allows another origin outright.
 */
import { NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface GuardedRequest {
  method: string;
  headers: Headers;
}

function trustedOrigins(): Set<string> {
  const raw = process.env.METIS_TRUSTED_ORIGINS ?? "";
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const origin = toOrigin(part.trim());
    if (origin) out.add(origin);
  }
  return out;
}

function toOrigin(raw: string | null | undefined): string | null {
  if (!raw || raw === "null") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Why the request is refused, or null when it may proceed. */
export function crossOriginRejectionReason(req: GuardedRequest): string | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;

  const rawOrigin = req.headers.get("origin");
  const origin = toOrigin(rawOrigin);
  if (origin && trustedOrigins().has(origin)) return null;

  const site = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (site) return site === "same-origin" || site === "none" ? null : `Sec-Fetch-Site: ${site}`;

  if (rawOrigin === null) return null;
  if (!origin) return "opaque Origin";
  const originHost = new URL(origin).host;
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")?.split(",")[0]]
    .map((h) => h?.trim().toLowerCase())
    .filter((h): h is string => Boolean(h));
  return hosts.includes(originHost) ? null : "cross-origin Origin";
}

/** A 403 response when the request is cross-origin, else null. */
export function rejectCrossOrigin(req: GuardedRequest): NextResponse | null {
  const reason = crossOriginRejectionReason(req);
  if (reason === null) return null;
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "CSRF_REJECTED",
        message:
          "Cross-site request refused: requests that change data must come from the METIS app",
        details: { reason },
      },
    },
    { status: 403 },
  );
}

/** Header the API requires on a cookie-authenticated state-changing request. */
export const CSRF_HEADER = "X-METIS-CSRF";
