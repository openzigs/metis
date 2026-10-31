/**
 * #1625 — rate limiters for `/api/portfolio-assessments`. Same shape as the
 * #838 fan-out limiters (`analysis-matrix-rate-limit.ts`, after
 * `runs-rate-limit.ts`, whose header explains the reasoning in full):
 *
 *  - {@link portfolioAssessmentPreAuthRateLimiter} — in FRONT of `requireAuth`
 *    on every route (CodeQL counts only a limiter before the authorization
 *    step). Default 3000 per window (`PORTFOLIO_ASSESSMENT_PREAUTH_RATE_LIMIT_MAX`).
 *    Keyed on the user inside a token this server signed, else on the TCP
 *    peer, never on `req.ip`; a spent peer bucket answers `requireAuth`'s 401.
 *  - {@link portfolioAssessmentStartRateLimiter} — AFTER `requireAuth` on
 *    `POST /`, keyed on the user. Default 10 per window
 *    (`PORTFOLIO_ASSESSMENT_START_RATE_LIMIT_MAX`): each start fans out one
 *    model call per repo of every product in scope, up to the run's cost cap.
 *  - {@link portfolioAssessmentReadRateLimiter} — AFTER `requireAuth` on the
 *    reads, keyed on the user. Default 300 per window
 *    (`PORTFOLIO_ASSESSMENT_RATE_LIMIT_MAX`): a read re-filters every product
 *    and repo of an assessment against the reader's access.
 *
 * Caps are read per request; the window once, at module load
 * (`PORTFOLIO_ASSESSMENT_RATE_LIMIT_WINDOW_MS`, shared). Each limiter is the
 * `rateLimit()` result itself so CodeQL sees it, with its own store prefix.
 */
import rateLimit from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey, runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const PORTFOLIO_ASSESSMENT_START_DEFAULT_MAX = 10;
export const PORTFOLIO_ASSESSMENT_READ_DEFAULT_MAX = 300;
export const PORTFOLIO_ASSESSMENT_PREAUTH_DEFAULT_MAX = 3_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("PORTFOLIO_ASSESSMENT_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited = (message: string): ApiResponse => ({
  success: false,
  error: { code: "PORTFOLIO_ASSESSMENT_RATE_LIMITED", message },
});

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const portfolioAssessmentPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("portfolio-assessment-preauth"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv(
      "PORTFOLIO_ASSESSMENT_PREAUTH_RATE_LIMIT_MAX",
      PORTFOLIO_ASSESSMENT_PREAUTH_DEFAULT_MAX,
    ),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  handler: preAuthLimitReachedHandler(
    runsPreAuthKey,
    limited("Too many portfolio assessment requests — slow down"),
  ),
}) as unknown as RequestHandler;

export const portfolioAssessmentStartRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("portfolio-assessment-start"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv("PORTFOLIO_ASSESSMENT_START_RATE_LIMIT_MAX", PORTFOLIO_ASSESSMENT_START_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited("Too many portfolio assessments started — wait before starting another"),
}) as unknown as RequestHandler;

export const portfolioAssessmentReadRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("portfolio-assessment-read"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv("PORTFOLIO_ASSESSMENT_RATE_LIMIT_MAX", PORTFOLIO_ASSESSMENT_READ_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited("Too many portfolio assessment requests — slow down"),
}) as unknown as RequestHandler;
