/**
 * #913 — CSRF protection for the cookie-authenticated path of the API.
 *
 * `requireAuth` accepts an `Authorization: Bearer` header OR the `accessToken`
 * cookie, and `/auth/refresh` and `/auth/logout` read the `refreshToken`
 * cookie. A browser attaches cookies to a request it did not mean to send, so a
 * state-changing request authenticated by one is forgeable from another site.
 * The cookies are `SameSite=Lax`, which stops a cross-SITE POST from carrying
 * them, but not a request from a sibling subdomain (same site, other origin),
 * and it is a browser policy rather than a check this server makes.
 *
 * The rule, applied to every request before any router:
 *
 *  1. `GET`, `HEAD` and `OPTIONS` pass — they must not change state.
 *  2. A request carrying a non-empty bearer token passes: `requireAuth` reads
 *     that and never the cookie, and a page on another origin cannot attach an
 *     `Authorization` header without a CORS preflight this server refuses.
 *     The UI's Next.js proxy always talks to the API this way.
 *  3. A request carrying neither session cookie passes: there is no ambient
 *     credential for a forgery to ride. (Login CSRF is handled on the UI
 *     origin, where the browser posts its login form; see `ui/src/lib/csrf-guard.ts`.)
 *  4. A cookie-authenticated, state-changing request must carry
 *     `X-METIS-CSRF` (any non-empty value) — a custom header, which an HTML
 *     form cannot send and a cross-origin `fetch` can only send after a
 *     preflight that `cors` answers for `CORS_ORIGIN` alone — AND must not be
 *     marked cross-origin by the browser: `Sec-Fetch-Site` other than
 *     `same-origin`/`none`, or an `Origin` that is neither this host nor a
 *     trusted origin, is refused. Same algorithm as Go 1.25's
 *     `http.CrossOriginProtection`, plus the header.
 *
 * Exempt: the SAML Assertion Consumer Service. The identity provider POSTs to
 * it from its own origin by design, it is authenticated by the signed
 * assertion, and it is a login (it sets the cookies) rather than a use of them.
 * HMAC-signed webhooks need no exemption: a server sends them without our
 * session cookies, so rule 3 passes them.
 *
 * Refusals are 403 `CSRF_REJECTED`, logged without the cookie values.
 */
import type { RequestHandler } from "express";
import { AppError } from "./error-handler.js";
import { normaliseOrigin } from "../lib/config/cors-origins.js";

/** The custom header a cookie-authenticated state-changing request must carry. */
export const CSRF_HEADER = "x-metis-csrf";

/** Cookies `requireAuth` and the refresh/logout routes authenticate with. */
const SESSION_COOKIES = ["accessToken", "refreshToken"] as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths a third party posts to by design, authenticated by their own signature. */
const EXEMPT_PATHS = new Set(["/api/auth/saml/acs"]);

export interface CsrfProtectionOptions {
  /**
   * Origins allowed to send cookie-authenticated state-changing requests, in
   * addition to the API's own host. `createApp` passes the CORS origin.
   */
  trustedOrigins?: readonly string[];
}

// Shared with the socket.io handshake's Origin check (#1349).
export { normaliseOrigin };

function hasBearer(header: string | undefined): boolean {
  return Boolean(header?.startsWith("Bearer ") && header.slice("Bearer ".length).trim());
}

function hasSessionCookie(cookies: Record<string, unknown> | undefined): boolean {
  return SESSION_COOKIES.some((name) => {
    const value = cookies?.[name];
    return typeof value === "string" && value.length > 0;
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Why a cookie-authenticated request is refused, or null when it may proceed.
 * Exported for its test.
 */
export function crossOriginReason(
  headers: Record<string, string | string[] | undefined>,
  trusted: ReadonlySet<string>,
): string | null {
  if (!headerValue(headers[CSRF_HEADER])?.trim()) return "missing X-METIS-CSRF header";

  const rawOrigin = headerValue(headers.origin);
  const origin = normaliseOrigin(rawOrigin);
  if (origin && trusted.has(origin)) return null;

  const site = headerValue(headers["sec-fetch-site"])?.toLowerCase();
  if (site) {
    return site === "same-origin" || site === "none" ? null : `Sec-Fetch-Site: ${site}`;
  }
  // No Fetch Metadata: an older browser, or not a browser at all. Fall back to
  // comparing Origin with the host the request was sent to.
  if (rawOrigin === undefined) return null;
  if (!origin) return "opaque Origin";
  const host = headerValue(headers.host);
  return host && new URL(origin).host === host.toLowerCase() ? null : "cross-origin Origin";
}

export function csrfProtection(opts: CsrfProtectionOptions = {}): RequestHandler {
  const trusted = new Set(
    (opts.trustedOrigins ?? [])
      .map((o) => normaliseOrigin(o.trim()))
      .filter((o): o is string => o !== null),
  );
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (EXEMPT_PATHS.has(req.path)) return next();
    if (hasBearer(req.headers.authorization)) return next();
    const cookies = (req as unknown as { cookies?: Record<string, unknown> }).cookies;
    if (!hasSessionCookie(cookies)) return next();

    const reason = crossOriginReason(req.headers, trusted);
    if (reason === null) return next();
    next(
      new AppError(
        403,
        "CSRF_REJECTED",
        "Cross-site request refused: a cookie-authenticated request that changes state must come from the METIS app",
        { reason },
      ),
    );
  };
}
