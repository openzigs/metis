/**
 * #1059 — rate limiters for the Spec Kit job endpoints
 * (`/api/projects/:id/spec-kit/jobs…` and `POST …/commands/:cmd/jobs`).
 *
 * Every job endpoint requires a signed-in user, so THE BUDGETS ARE THE USER'S:
 *
 *  - {@link specKitJobUserReadRateLimiter} — `GET /jobs` and `GET /jobs/:jobId`.
 *    Default 6000 per 15 minutes per user: one tab polling every 3 seconds
 *    makes 300. `SPECKIT_JOB_LIMIT_MAX`.
 *  - {@link specKitJobUserWriteRateLimiter} — start and cancel. Default 120 per
 *    15 minutes per user. `SPECKIT_JOB_USER_WRITE_LIMIT_MAX`.
 *
 * Both run AFTER `requireAuth` and key on `req.user.userId`. READS and WRITES
 * are separate budgets, so a page (or twenty) polling a job can never make
 * `cancel` or a new start answer 429; and nobody but the user can spend either.
 *
 * WHY NOT THE CLIENT ADDRESS. `req.ip` under the default `trust proxy = 1`
 * (`app.ts`) is the LAST entry of `X-Forwarded-For`. When the Next UI server is
 * the edge, that entry is whatever the CLIENT sent: Next fills the header only
 * when it is absent (`x-forwarded-for ??= socket.remoteAddress`,
 * `next/dist/server/base-server.js`) and the UI's API proxy
 * (`ui/src/app/api/[...path]/route.ts`) forwards request headers as they are.
 * A budget keyed on it can be dodged (a new value per request) and can be
 * spent on somebody else's behalf (their address, sent by an unauthenticated
 * caller). A reverse proxy in front of the UI that APPENDS the peer address it
 * saw closes that: the last entry is then the real client, and the default
 * `TRUST_PROXY=1` is already right for one such proxy (count the appending
 * proxies in front of the UI; never raise it past that count, or the entry
 * selected is again one the client wrote). Every other `req.ip`-keyed limiter
 * in the app has this property; it is tracked in #1109.
 *
 *  - {@link specKitJobPreAuthRateLimiter} — in front of `requireAuth` on every
 *    job endpoint and, since #960, on every other Spec Kit route that has no
 *    limiter of its own (the project-access check those routes now run reads
 *    the database), because CodeQL js/missing-rate-limiting wants a limiter
 *    ahead of every auth check (as in `spec-kit-delete-rate-limit.ts`). It is a
 *    coarse guard, default 20000 per 15 minutes
 *    (`SPECKIT_JOB_PREAUTH_LIMIT_MAX`), and its key is nothing a caller can aim
 *    at someone else: a digest of the access token the request presents, or,
 *    for a request that presents none, the address of the TCP peer (the UI
 *    server or the proxy, never a header). Exhausting the first needs the
 *    victim's own token; exhausting the second refuses only requests that
 *    `requireAuth` would answer 401 anyway. It does not bound a caller who
 *    invents a new token per request: `requireAuth` refuses those on a
 *    signature check, without a database read.
 *
 * Caps are read per request; the window length once, at module load
 * (`SPECKIT_JOB_LIMIT_WINDOW_MS`, one window for all three). Each limiter is
 * exported as the `rateLimit()` result itself (not wrapped in a function) so
 * CodeQL recognises it.
 */
import { createHash } from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const SPECKIT_JOB_DEFAULT_MAX = 6000;
export const SPECKIT_JOB_USER_WRITE_DEFAULT_MAX = 120;
export const SPECKIT_JOB_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The TCP peer: the UI server or the proxy in front of the API. Never a header. */
function peerKey(req: Request): string {
  const socket = req.socket;
  return `peer:${ipKeyGenerator(socket?.remoteAddress ?? "", socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

/** The access token a request presents, read where `requireAuth` reads it. Not verified. */
function presentedAccessToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const cookie = (req as unknown as { cookies?: Record<string, unknown> }).cookies?.accessToken;
  return typeof cookie === "string" && cookie ? cookie : undefined;
}

/** {@link specKitJobPreAuthRateLimiter}'s key. Exported for its test. */
export function specKitJobPreAuthKey(req: Request): string {
  const token = presentedAccessToken(req);
  if (!token) return peerKey(req);
  return `cred:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

/** The per-user limiters' key. Exported for its test. */
export function specKitJobUserKey(req: Request): string {
  // `requireAuth` runs first on every route that mounts these, so the fallback
  // is for a route wired wrongly: it still never reads a client-supplied header.
  return req.user?.userId ? `user:${req.user.userId}` : peerKey(req);
}

const WINDOW_MS = envMs("SPECKIT_JOB_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited = (message: string): ApiResponse => ({
  success: false,
  error: { code: "SPECKIT_JOB_RATE_LIMITED", message },
});

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const specKitJobPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-job-preauth"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("SPECKIT_JOB_PREAUTH_LIMIT_MAX", SPECKIT_JOB_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => specKitJobPreAuthKey(req as unknown as Request),
  message: limited("Too many Spec Kit job requests — slow down"),
}) as unknown as RequestHandler;

export const specKitJobUserReadRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-job-read-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("SPECKIT_JOB_LIMIT_MAX", SPECKIT_JOB_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => specKitJobUserKey(req as unknown as Request),
  message: limited("Too many Spec Kit job requests — slow down"),
}) as unknown as RequestHandler;

export const specKitJobUserWriteRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-job-write-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("SPECKIT_JOB_USER_WRITE_LIMIT_MAX", SPECKIT_JOB_USER_WRITE_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => specKitJobUserKey(req as unknown as Request),
  message: limited("You have started or cancelled too many Spec Kit commands — wait a few minutes"),
}) as unknown as RequestHandler;
