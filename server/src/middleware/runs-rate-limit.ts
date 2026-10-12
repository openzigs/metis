/**
 * #1007 — rate limiters for `/api/runs` (the run list, the chat-turn list, a
 * run, its replay and its sandbox sessions). The router had none and the app
 * has no global one, so every route on it was CodeQL `js/missing-rate-limiting`
 * (alert 520 on the list; 562 on `GET /chat-turns`, a failing check on #1112).
 *
 * Every route requires a signed-in user, so THE BUDGET IS THE USER'S:
 *
 *  - {@link runsUserRateLimiter} — AFTER `requireAuth`, keyed on
 *    `req.user.userId`. Default 3000 per 15 minutes per user (`RUNS_LIMIT_MAX`):
 *    `/runs` makes two requests per load and per filter keystroke, a run's page
 *    three. Nobody but the user can spend it.
 *
 * WHY NOT THE CLIENT ADDRESS. `req.ip` under the default `trust proxy = 1` is
 * the last entry of `X-Forwarded-For`, and when the Next UI server is the edge
 * that entry is whatever the client sent — see `spec-kit-job-rate-limit.ts`
 * (#1105) for the full account. A budget keyed on it can be dodged with a new
 * value per request and spent on somebody else's behalf.
 *
 *  - {@link runsPreAuthRateLimiter} — in FRONT of `requireAuth`, because CodeQL
 *    counts only a limiter that runs before the authorization step. A coarse
 *    guard, default 20000 per 15 minutes (`RUNS_PREAUTH_LIMIT_MAX`). Its key is
 *    never a value the caller chooses:
 *
 *      • a request carrying an access token THIS server signed is keyed on the
 *        user id inside it (`signedAccessTokenUserId`: a signature check, no
 *        database read). An expired token still counts as its user's, so a
 *        browser whose token just ran out gets the 401 `TOKEN_EXPIRED` it
 *        refreshes on, never a 429. Spending this budget needs the user's own
 *        token.
 *      • every other request — no token, or one we did not sign — is keyed on
 *        the TCP peer (the UI server or the proxy; never a header). All of
 *        those are requests `requireAuth` answers 401 anyway, so exhausting
 *        that bucket refuses nobody who would have been served.
 *
 *    The spec-kit guard keys the first case on a digest of the PRESENTED token
 *    without checking it; a caller inventing a token per request then mints a
 *    counter per request, and the rate-limit store holds each until its window
 *    ends. Here the key space is the users plus the peers.
 *
 * Caps are read per request; the window once, at module load
 * (`RUNS_LIMIT_WINDOW_MS`, shared). Each limiter is exported as the
 * `rateLimit()` result itself (not wrapped in a function) so CodeQL sees it.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import { signedAccessTokenUserId } from "../lib/auth/jwt.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const RUNS_USER_DEFAULT_MAX = 3_000;
export const RUNS_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The TCP peer: the UI server or the proxy in front of the API. Never a header. */
function peerKey(req: Request): string {
  const socket = req.socket;
  return `peer:${ipKeyGenerator(socket?.remoteAddress ?? "", socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

/** The access token a request presents, read where `requireAuth` reads it. */
function presentedAccessToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const cookie = (req as unknown as { cookies?: Record<string, unknown> }).cookies?.accessToken;
  return typeof cookie === "string" && cookie ? cookie : undefined;
}

/** {@link runsPreAuthRateLimiter}'s key. Exported for its test. */
export function runsPreAuthKey(req: Request): string {
  const token = presentedAccessToken(req);
  const userId = token ? signedAccessTokenUserId(token) : null;
  return userId ? `user:${userId}` : peerKey(req);
}

/** {@link runsUserRateLimiter}'s key. Exported for its test. */
export function runsUserKey(req: Request): string {
  // `requireAuth` runs first on every route that mounts this, so the fallback
  // is for a route wired wrongly: it still never reads a client-supplied header.
  return req.user?.userId ? `user:${req.user.userId}` : peerKey(req);
}

const WINDOW_MS = envMs("RUNS_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: { code: "RUNS_RATE_LIMITED", message: "Too many run requests — slow down" },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const runsPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("runs-preauth"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("RUNS_PREAUTH_LIMIT_MAX", RUNS_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;

export const runsUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("runs-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("RUNS_LIMIT_MAX", RUNS_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
