/**
 * #1539 — the app-wide request budget, mounted as the first middleware on `/api`
 * and on the top-level `/metrics` scrape (`app.ts`).
 *
 * Until this, only six `/api` mounts had a limiter (`/auth` ×2, `/mcp`,
 * `/products`, `/jira`, `/admin`) plus the per-route ones, so about 300
 * handlers ran with none: repository ingest, traceability backfill, LLM
 * evaluations, cache rebuilds, imports, and unauthenticated token checks (the
 * SCIM bearer, the Slack OAuth callback, `/metrics`). This is the coarse OUTER
 * budget; every per-route limiter stays as a tighter inner one.
 *
 * Its key is never a value the caller chooses, and never the bare peer address
 * for a signed-in user: every browser request reaches the API through the
 * Next.js proxy, so a peer key would put the whole organisation in one bucket.
 *
 *  - a request carrying an access token THIS server signed (unexpired, or
 *    expired at most 15 minutes ago) → that user, `api:user:<id>`
 *    (`signedAccessTokenUserId`, the `runsPreAuthKey` rule, #1007/#1117);
 *  - otherwise, a client address the UI signed (`auth-client-address.ts`,
 *    #1385; the auth proxy sends one with every login, refresh and logout) →
 *    `api:addr:<address>`;
 *  - otherwise the TCP peer, `api:peer:<address>`, never `req.ip` or a header.
 *
 * Every key starts `api:`, so it never equals another cluster-store limiter's
 * key for the same request (`user:<id>`, `preauth:…`, `peer:…`), which
 * express-rate-limit would report as `ERR_ERL_DOUBLE_COUNT`.
 *
 * A spent bucket is `429 API_RATE_LIMITED`, except for a request that presented
 * an access token that did not resolve to a user: that is answered as
 * `requireAuth` answers it (401) so the UI refreshes. A request with no token is
 * always 429: this limiter fronts routes that are anonymous by design
 * (`/health`, `/source`, sign-in, SCIM, webhooks, `/metrics`), where a 401
 * would tell a caller its credentials are wrong rather than to wait.
 * The shared peer bucket has its own, much larger budget
 * (`API_RATE_LIMIT_PEER_MAX`, default 6000), so one client cannot cheaply spend it.
 *
 * A store failure lets the request through (`passOnStoreError`): this budget
 * sits on every route, so a rate-limit backend outage must not become an
 * outage of the whole API. The tighter per-route limiters still fail closed.
 *
 * Budget: `API_RATE_LIMIT_MAX` requests (default 600, read per request) per
 * `API_RATE_LIMIT_WINDOW_MS` (default one minute, read at module load).
 */
import jwt from "jsonwebtoken";
import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "./auth.js";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { verifiedClientAddress } from "./auth-client-address.js";
import { peerKey, presentedAccessToken } from "./runs-rate-limit.js";
import { signedAccessTokenUserId } from "../lib/auth/jwt.js";
import { envMs } from "../lib/config/env-ms.js";

export const API_RATE_LIMIT_DEFAULT_MAX = 600;
export const API_RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000;
/**
 * The budget for the shared TCP-peer bucket. Every anonymous request the UI
 * could not attach a signed client address to lands there, for every tenant, so
 * it is far larger than a single user's: one client must not be able to spend
 * it cheaply and lock out the webhooks, SCIM and /health behind it.
 */
export const API_RATE_LIMIT_DEFAULT_PEER_MAX = 6000;
const PEER_KEY_PREFIX = "api:peer:";

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * A JWT-shaped token was presented but did not resolve to a user. An opaque
 * bearer (the SCIM token, `METRICS_TOKEN`) is not a session the UI can refresh,
 * so it stays a 429.
 */
function unresolvedTokenPresented(req: Request): boolean {
  const token = presentedAccessToken(req);
  return (
    token !== undefined &&
    !apiRateLimitKey(req).startsWith("api:user:") &&
    jwt.decode(token) !== null
  );
}

/** {@link apiRateLimiter}'s key. Exported for its test. */
export function apiRateLimitKey(req: Request): string {
  const token = presentedAccessToken(req);
  const userId = token ? signedAccessTokenUserId(token) : null;
  if (userId) return `api:user:${userId}`;
  const signed = verifiedClientAddress(req);
  if (signed) return `api:addr:${ipKeyGenerator(signed, 64)}`;
  return `api:${peerKey(req)}`;
}

const limited: ApiResponse = {
  success: false,
  error: { code: "API_RATE_LIMITED", message: "Too many requests — please slow down" },
};

/**
 * A spent bucket is 429, except for a request that presented a token which did
 * not resolve to a user (expired over 15 minutes, unsigned): it is answered as
 * `requireAuth` answers it (401), which the UI recovers from by refreshing,
 * rather than a 429 that would look like a sign-out until the window rolls.
 */
function limitReached(rawReq: unknown, rawRes: unknown, rawNext: unknown): void {
  const req = rawReq as Request;
  const res = rawRes as Response;
  const next = rawNext as NextFunction;
  const tooMany = () => {
    res.status(429).json(limited);
  };
  if (!unresolvedTokenPresented(req)) {
    tooMany();
    return;
  }
  res.removeHeader("Retry-After");
  void requireAuth(req, res, (err?: unknown) => {
    if (err) next(err);
    else tooMany();
  });
}

/**
 * The limiter's options, store included. Exported so a test can build the same
 * limiter over a private (or failing) counter —
 * `rateLimit({ ...apiRateLimitOptions(), store })` — without re-importing the
 * application.
 */
export function apiRateLimitOptions(): Partial<Options> {
  return {
    store: clusterRateLimitStore("api"),
    windowMs: envMs("API_RATE_LIMIT_WINDOW_MS", API_RATE_LIMIT_DEFAULT_WINDOW_MS, { min: 1 }),
    limit: (req) =>
      apiRateLimitKey(req as unknown as Request).startsWith(PEER_KEY_PREFIX)
        ? intFromEnv("API_RATE_LIMIT_PEER_MAX", API_RATE_LIMIT_DEFAULT_PEER_MAX)
        : intFromEnv("API_RATE_LIMIT_MAX", API_RATE_LIMIT_DEFAULT_MAX),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: (req) => apiRateLimitKey(req as unknown as Request),
    message: limited,
    handler: limitReached,
  };
}

/**
 * The one instance `app.ts` mounts on `/api` and `/metrics`. Exported as the
 * `rateLimit()` result itself, not wrapped in a function, so CodeQL sees it.
 * `as unknown as RequestHandler` bridges the Express 4↔5 type split.
 */
export const apiRateLimiter: RequestHandler = rateLimit(
  apiRateLimitOptions(),
) as unknown as RequestHandler;
