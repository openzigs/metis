/**
 * #1007 — rate limiters for the five routes of `runsRouter` (the run list, the
 * chat-turn list, a run, its replay and its sandbox sessions). The router had
 * none and the app has no global one, so every route on it was CodeQL
 * `js/missing-rate-limiting` (alert 520 on the list; 562 on `GET /chat-turns`,
 * a failing check on #1112). #1116 — and on every route of
 * `backgroundRunsRouter` (background runs, run groups, steering), which shares
 * the `/api/runs` prefix: the whole prefix is limited.
 *
 * Every route requires a signed-in user, so THE BUDGET IS THE USER'S:
 *
 *  - {@link runsUserRateLimiter} — every READ, AFTER `requireAuth`, keyed on
 *    `req.user.userId`. Default 3000 per 15 minutes per user (`RUNS_LIMIT_MAX`):
 *    `/runs` makes two requests per load and per filter keystroke, a run's page
 *    three, and the dashboard's active-runs widget polls
 *    `GET /runs/background` every 10 s (90 a window per open tab). Nobody but
 *    the user can spend it.
 *  - {@link runsWriteUserRateLimiter} — every WRITE of `backgroundRunsRouter`
 *    (submit, cancel, pause, resume, best-of-N, steer), AFTER `requireAuth`.
 *    A budget of its own, default 300 per 15 minutes per user
 *    (`RUNS_WRITE_LIMIT_MAX`): a write is a click, a submit can start up to
 *    eight agent runs, and a polling read must never be refused because the
 *    user clicked, nor the other way round.
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
 *        database read). A token that expired at most 15 minutes ago still
 *        counts as its user's, so a browser whose token just ran out gets the
 *        401 `TOKEN_EXPIRED` it refreshes on, never a 429. An older one does
 *        not (#1117): a token from months ago cannot spend its user's budget.
 *      • every other request — no token, one we did not sign, one expired
 *        longer ago — is keyed on the TCP peer (the UI server or the proxy;
 *        never a header). Every one of those is a request `requireAuth`
 *        refuses, so when that bucket is exhausted the guard answers with
 *        `requireAuth`'s own 401 instead of 429 (#1117,
 *        the limiter's `handler`): a browser whose cookie fell out of
 *        the jar must reach the 401 it recovers from (refresh, else sign-in),
 *        and nobody who would have been served is refused.
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
import { requireAuth } from "./auth.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const RUNS_USER_DEFAULT_MAX = 3_000;
export const RUNS_PREAUTH_DEFAULT_MAX = 20_000;
export const RUNS_WRITE_DEFAULT_MAX = 300;

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

/**
 * {@link runsPreAuthRateLimiter}'s key. Exported for its test.
 *
 * Always under `preauth:`, so it is never the key {@link runsUserKey} gives
 * the same request. Both limiters use the one store class, and
 * express-rate-limit takes "same store class, same key, one request" for a
 * double count: with `user:<id>` from both it logged `ERR_ERL_DOUBLE_COUNT` on
 * the first signed-in request of every process, though the two stores count
 * apart (their own prefixes, `runs-preauth` and `runs-user`).
 */
export function runsPreAuthKey(req: Request): string {
  const token = presentedAccessToken(req);
  const userId = token ? signedAccessTokenUserId(token) : null;
  return `preauth:${userId ? `user:${userId}` : peerKey(req)}`;
}

/** {@link runsUserRateLimiter}'s key. Exported for its test. */
export function runsUserKey(req: Request): string {
  // `requireAuth` runs first on every route that mounts this, so the fallback
  // is for a route wired wrongly: it still never reads a client-supplied header.
  return req.user?.userId ? `user:${req.user.userId}` : peerKey(req);
}

/**
 * {@link runsWriteUserRateLimiter}'s key. Exported for its test. Under
 * `write:` so it is never the key {@link runsUserKey} or {@link runsPreAuthKey}
 * gives the same request (same store class: `ERR_ERL_DOUBLE_COUNT`).
 */
export function runsWriteUserKey(req: Request): string {
  return `write:${runsUserKey(req)}`;
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
  /*
   * #1117 — what the guard answers once a bucket is spent. A user's bucket (a
   * token this server signed, at most 15 minutes expired) is told 429: it is
   * theirs to wait out. The PEER bucket only ever holds requests `requireAuth`
   * refuses — no token, an unsigned one, a refresh token, a token long
   * expired — so each is told what `requireAuth` tells it (`AUTH_REQUIRED`,
   * `TOKEN_INVALID`, `TOKEN_EXPIRED`), which the UI recovers from. Should
   * `requireAuth` ever accept one, it is still refused with 429: the guard
   * never lets a request past its budget.
   */
  handler: (rawReq, rawRes, rawNext) => {
    const req = rawReq as unknown as Request;
    const res = rawRes as unknown as Response;
    const tooMany = () => {
      res.status(429).json(limited);
    };
    if (!runsPreAuthKey(req).startsWith("preauth:peer:")) {
      tooMany();
      return;
    }
    // A 401 carries no promise that waiting helps.
    res.removeHeader("Retry-After");
    void requireAuth(req, res, (err?: unknown) => {
      if (err) (rawNext as unknown as NextFunction)(err);
      else tooMany();
    });
  },
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

export const runsWriteUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("runs-write-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("RUNS_WRITE_LIMIT_MAX", RUNS_WRITE_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsWriteUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
