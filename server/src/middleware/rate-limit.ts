/**
 * Rate limiters. Auth endpoints are restricted to 20 requests / 15 minutes per
 * IP to throttle credential-stuffing attempts; the limit is configurable via
 * env so deployments can tune for their reverse-proxy topology.
 */
import rateLimit, { type Store } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? `${15 * 60 * 1000}`, 10);
const MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "20", 10);

/**
 * Routes under `/auth` that are exempt from the credential-stuffing limiter.
 *
 * Each entry is an unauthenticated, read-only, side-effect-free `GET` that the
 * login page polls before the user has any credentials to stuff — so counting
 * it against the credential-stuffing budget only hurts legitimate page loads.
 *
 * The paths are the router-relative `req.path` values the skip predicate sees
 * (the limiter is mounted at `/auth` for both the auth and SSO routers):
 *  - `/me`             session check  (`GET /api/auth/me`)
 *  - `/sso/providers`  public enabled-provider list for /login (#429, #452);
 *                      returns the safe `{ id, label, type, loginUrl }` projection only.
 *
 * Scoped to `GET` + an EXACT path match: credential-accepting routes
 * (`/login`, `/refresh`, `/logout`, SSO callbacks) and any other `/sso/*`
 * route stay throttled.
 */
const RATE_LIMIT_EXEMPT_GET_PATHS: ReadonlySet<string> = new Set(["/me", "/sso/providers"]);

/**
 * Pure predicate for the auth rate limiter's `skip` option. Exported so the
 * exemption set is directly unit-testable without standing up an HTTP harness.
 */
export function isRateLimitExempt(method: string, path: string): boolean {
  return method === "GET" && RATE_LIMIT_EXEMPT_GET_PATHS.has(path);
}

/** Overrides for {@link createAuthRateLimiter}; every field is test-only. */
export interface AuthRateLimiterOptions {
  /** Requests permitted per window. Defaults to `RATE_LIMIT_MAX`. */
  max?: number;
  /** Window length in ms. Defaults to `RATE_LIMIT_WINDOW_MS`. */
  windowMs?: number;
  /** Counter backend. Defaults to the config-selected cluster-safe store. */
  store?: Store;
}

/**
 * Build the credential-stuffing limiter.
 *
 * Exists so a test can obtain a limiter with a low `max`, a private counter and
 * an injected clock **without** re-importing the application (#1288). The old
 * test mutated `RATE_LIMIT_MAX`, called `vi.resetModules()` and re-imported
 * `createApp` purely to move this one number; that second, cold import of the
 * whole module graph ran inside a 30 s `beforeAll` budget and timed out under
 * full-suite fan-out on the shared runner — reddening the file with zero failed
 * tests, which reads exactly like the `cost-tracker.test.ts` teardown flake.
 *
 * Production behaviour is unchanged: {@link authRateLimiter} below calls this
 * with no overrides at module-import time, so the env is read exactly when and
 * as it was before.
 */
export function createAuthRateLimiter(options: AuthRateLimiterOptions = {}): RequestHandler {
  // `as unknown as RequestHandler` bridges the Express 4↔5 type split.
  return rateLimit({
    store: options.store ?? clusterRateLimitStore("auth"),
    windowMs: options.windowMs ?? WINDOW_MS,
    max: options.max ?? MAX,
    skip: (req) => isRateLimitExempt(req.method, req.path),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many authentication attempts — please try again later",
      },
    } satisfies ApiResponse,
  }) as unknown as RequestHandler;
}

export const authRateLimiter: RequestHandler = createAuthRateLimiter();
