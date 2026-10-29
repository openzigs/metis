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
 * A spent bucket is `429 API_RATE_LIMITED` for every key. Unlike the runs guard
 * (`preauth-limit-handler.ts`), an anonymous bucket is NOT turned into
 * `requireAuth`'s 401: this limiter also fronts routes that are anonymous by
 * design (`/health`, `/source`, sign-in, SCIM, webhooks, `/metrics`), where a
 * 401 would tell a caller its credentials are wrong rather than to wait.
 *
 * A store failure lets the request through (`passOnStoreError`): this budget
 * sits on every route, so a rate-limit backend outage must not become an
 * outage of the whole API. The tighter per-route limiters still fail closed.
 *
 * Budget: `API_RATE_LIMIT_MAX` requests (default 600, read per request) per
 * `API_RATE_LIMIT_WINDOW_MS` (default one minute, read at module load).
 */
import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { verifiedClientAddress } from "./auth-client-address.js";
import { peerKey, presentedAccessToken } from "./runs-rate-limit.js";
import { signedAccessTokenUserId } from "../lib/auth/jwt.js";
import { envMs } from "../lib/config/env-ms.js";

export const API_RATE_LIMIT_DEFAULT_MAX = 600;
export const API_RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
 * The limiter's options, store included. Exported so a test can build the same
 * limiter over a private (or failing) counter —
 * `rateLimit({ ...apiRateLimitOptions(), store })` — without re-importing the
 * application.
 */
export function apiRateLimitOptions(): Partial<Options> {
  return {
    store: clusterRateLimitStore("api"),
    windowMs: envMs("API_RATE_LIMIT_WINDOW_MS", API_RATE_LIMIT_DEFAULT_WINDOW_MS, { min: 1 }),
    limit: () => intFromEnv("API_RATE_LIMIT_MAX", API_RATE_LIMIT_DEFAULT_MAX),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: (req) => apiRateLimitKey(req as unknown as Request),
    message: limited,
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
