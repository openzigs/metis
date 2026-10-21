/**
 * #838 — rate limiters for the analysis traceability matrix:
 * `GET /api/projects/:projectId/analyses/:id/traceability` (JSON, `?format=csv`,
 * `?format=md`) and `GET …/:id/export`, which builds the same matrix into the
 * analysis report. Each call runs the #814 "Tested by" resolver's code-graph
 * load for one analysis's requirements, so it is bounded like the other
 * compute-backed reads (CodeQL `js/missing-rate-limiting`, alert 543 class).
 *
 * THE BUDGET IS THE USER'S:
 *
 *  - {@link analysisMatrixUserRateLimiter} — after `requireAuth`, keyed on
 *    `req.user.userId`. Default 300 per 15 minutes
 *    (`ANALYSIS_MATRIX_RATE_LIMIT_MAX`), the traceability-gaps budget. The UI
 *    loads the matrix once when the Traceability tab opens for an analysis
 *    (react-query, 30 s stale time, no refetch on focus) and once per export
 *    click, so an analyst working through analyses spends a handful a minute.
 *
 *  - {@link analysisMatrixPreAuthRateLimiter} — ahead of the route's
 *    `requireAuth`, because CodeQL counts only a limiter that precedes it.
 *    Default 3000 per 15 minutes (`ANALYSIS_MATRIX_PREAUTH_RATE_LIMIT_MAX`).
 *    Keyed, like `runs-rate-limit.ts` (#1007), never on a value the caller
 *    chooses: the user id inside an access token THIS server signed (expiry
 *    ignored, so an expired browser token still gets its 401 `TOKEN_EXPIRED`,
 *    not a 429), else the TCP peer. Never `req.ip`, which under
 *    `trust proxy` is a client-writable `X-Forwarded-For` entry.
 *
 * Caps are read per request; the window once, at module load
 * (`ANALYSIS_MATRIX_RATE_LIMIT_WINDOW_MS`, shared). Each limiter is exported as
 * the `rateLimit()` result itself so CodeQL sees it.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import { signedAccessTokenUserId } from "../lib/auth/jwt.js";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const ANALYSIS_MATRIX_DEFAULT_MAX = 300;
export const ANALYSIS_MATRIX_PREAUTH_DEFAULT_MAX = 3_000;

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
 * {@link analysisMatrixPreAuthRateLimiter}'s key. Exported for its test. Always
 * under `preauth:` so it never equals the per-user key for the same request
 * (express-rate-limit reports a same-store-class, same-key pair as a double count).
 */
export function analysisMatrixPreAuthKey(req: Request): string {
  const token = presentedAccessToken(req);
  const userId = token ? signedAccessTokenUserId(token) : null;
  return `preauth:${userId ? `user:${userId}` : peerKey(req)}`;
}

/** {@link analysisMatrixUserRateLimiter}'s key. Exported for its test. */
export function analysisMatrixUserKey(req: Request): string {
  return req.user?.userId ? `user:${req.user.userId}` : peerKey(req);
}

const WINDOW_MS = envMs("ANALYSIS_MATRIX_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "ANALYSIS_MATRIX_RATE_LIMITED",
    message: "Too many traceability matrix requests — slow down",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const analysisMatrixPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("analysis-matrix-preauth"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv("ANALYSIS_MATRIX_PREAUTH_RATE_LIMIT_MAX", ANALYSIS_MATRIX_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => analysisMatrixPreAuthKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;

export const analysisMatrixUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("analysis-matrix-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("ANALYSIS_MATRIX_RATE_LIMIT_MAX", ANALYSIS_MATRIX_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => analysisMatrixUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
