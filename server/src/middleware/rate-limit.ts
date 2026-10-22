/**
 * Rate limiters for `/api/auth/*`. Two budgets (#1385):
 *
 *  - {@link authRateLimiter} — per CLIENT ADDRESS, every credential route:
 *    20 requests / 15 minutes (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). The
 *    address is the one the UI signed, else the TCP peer — never a header the
 *    browser wrote (`auth-client-address.ts`).
 *  - {@link authAccountRateLimiter} — per ACCOUNT, `POST /login` only: 10
 *    sign-in attempts / 15 minutes for one username, from any number of
 *    addresses (`AUTH_ACCOUNT_RATE_LIMIT_MAX`).
 */
import { createHash } from "node:crypto";
import rateLimit, { type Store } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { authAddressKey } from "./auth-client-address.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? `${15 * 60 * 1000}`, 10);
const MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "20", 10);
export const AUTH_ACCOUNT_DEFAULT_MAX = 10;

function accountMaxFromEnv(): number {
  const n = Number.parseInt(process.env.AUTH_ACCOUNT_RATE_LIMIT_MAX ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : AUTH_ACCOUNT_DEFAULT_MAX;
}

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
    keyGenerator: (req) => authAddressKey(req as unknown as Request),
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

/**
 * The account a `POST /login` names, as its limiter key, or null when the
 * request is not a login or names no usable account (the route's own
 * validation answers those). Case- and whitespace-folded, so `Alice ` and
 * `alice` share one budget; hashed, so the store never holds a username.
 */
export function authAccountKey(req: Request): string | null {
  if (req.method !== "POST" || req.path !== "/login") return null;
  const username: unknown = (req.body as { username?: unknown } | undefined)?.username;
  if (typeof username !== "string") return null;
  const folded = username.trim().toLowerCase();
  if (!folded || folded.length > 256) return null;
  return `acct:${createHash("sha256").update(folded).digest("hex")}`;
}

/**
 * Build the per-account login limiter: an attacker cycling addresses (or
 * sharing a NAT with everyone) still meets this budget for each account.
 *
 * Every attempt counts, successful or not. Counting only failures would need
 * `skipSuccessfulRequests`, which un-counts a hit through `Store.decrement`, and
 * the cluster-safe store has no decrement: its Postgres and Valkey backends are
 * append-only window counters (`cluster-rate-limit-store.ts`). Nobody signs in
 * ten times in fifteen minutes; a session lives on refresh, not `/login`.
 * Every option is test-only, as for {@link createAuthRateLimiter}.
 */
export function createAuthAccountRateLimiter(options: AuthRateLimiterOptions = {}): RequestHandler {
  return rateLimit({
    store: options.store ?? clusterRateLimitStore("auth-account"),
    windowMs: options.windowMs ?? WINDOW_MS,
    limit: () => options.max ?? accountMaxFromEnv(),
    keyGenerator: (req) => authAccountKey(req as unknown as Request) ?? "acct:none",
    skip: (req) => authAccountKey(req as unknown as Request) === null,
    // The address limiter already set these; a second set would overwrite them.
    standardHeaders: false,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many sign-in attempts for this account — please try again later",
      },
    } satisfies ApiResponse,
  }) as unknown as RequestHandler;
}

export const authAccountRateLimiter: RequestHandler = createAuthAccountRateLimiter();
