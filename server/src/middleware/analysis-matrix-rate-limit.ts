/**
 * #838 — rate limiters for the analysis traceability matrix:
 * `GET /api/projects/:projectId/analyses/:id/traceability` (JSON, `?format=csv`,
 * `?format=md`) and `GET …/:id/export`, which builds the same matrix into the
 * analysis report. Each call runs the #814 "Tested by" resolver's code-graph
 * load for one analysis's requirements, so it is bounded like the other
 * compute-backed reads (CodeQL `js/missing-rate-limiting`). Same shape as
 * `runs-rate-limit.ts` (#1007), whose header explains the reasoning in full:
 *
 *  - {@link analysisMatrixUserRateLimiter} — AFTER `requireAuth`, keyed on
 *    `req.user.userId`. Default 300 per 15 minutes
 *    (`ANALYSIS_MATRIX_RATE_LIMIT_MAX`), the traceability-gaps budget. The UI
 *    loads the matrix once when the Traceability tab opens for an analysis
 *    (react-query, 30 s stale time, no refetch on focus) and once per export
 *    click, so an analyst working through analyses spends a handful a minute.
 *  - {@link analysisMatrixPreAuthRateLimiter} — in FRONT of `requireAuth`
 *    (CodeQL counts only a limiter before the authorization step). Default 3000
 *    per 15 minutes (`ANALYSIS_MATRIX_PREAUTH_RATE_LIMIT_MAX`). Keyed on the
 *    user inside an access token this server signed that is unexpired or
 *    expired at most 15 minutes ago (#1117), otherwise on the TCP peer — never
 *    on `req.ip`, a client-writable `X-Forwarded-For` entry under
 *    `trust proxy`. A spent peer bucket answers `requireAuth`'s own 401, not
 *    429 (#1117, `preauth-limit-handler.ts`).
 *
 * The keys are `runs-rate-limit.ts`'s own key functions, so they never drift
 * apart; the stores are separate (`analysis-matrix-*` prefixes).
 *
 * Caps are read per request; the window once, at module load
 * (`ANALYSIS_MATRIX_RATE_LIMIT_WINDOW_MS`, shared). Each limiter is exported as
 * the `rateLimit()` result itself so CodeQL sees it.
 */
import rateLimit from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey, runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const ANALYSIS_MATRIX_DEFAULT_MAX = 300;
export const ANALYSIS_MATRIX_PREAUTH_DEFAULT_MAX = 3_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  // #1117 — a spent user bucket is 429; a spent peer bucket is requireAuth's 401.
  handler: preAuthLimitReachedHandler(runsPreAuthKey, limited),
}) as unknown as RequestHandler;

export const analysisMatrixUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("analysis-matrix-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("ANALYSIS_MATRIX_RATE_LIMIT_MAX", ANALYSIS_MATRIX_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
