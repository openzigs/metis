/**
 * Issue #1220 — rate limiters for `POST /api/requirements/:requirementId/source-divergence`
 * ("Take the source version" / "Keep mine" on an imported requirement that is
 * diverged from its source). Same shape as `runs-rate-limit.ts` (#1007), whose
 * header explains the reasoning in full:
 *
 *  - {@link sourceDivergenceUserRateLimiter} — AFTER `requireAuth`, keyed on
 *    `req.user.userId`. The budget is the user's; nobody else can spend it.
 *    Default 300 per 15 minutes (`SOURCE_DIVERGENCE_LIMIT_MAX`): each answer is
 *    one click on one requirement.
 *  - {@link sourceDivergencePreAuthRateLimiter} — in FRONT of `requireAuth`
 *    (CodeQL `js/missing-rate-limiting` counts only a limiter before the
 *    authorization step). Keyed on the user id inside an access token this
 *    server signed, otherwise on the TCP peer — never on `req.ip`, which under
 *    `trust proxy` is a value the client can choose. Default 20000 per 15
 *    minutes (`SOURCE_DIVERGENCE_PREAUTH_LIMIT_MAX`). A spent peer bucket answers
 *    `requireAuth`'s own 401, not 429 (#1117, `preauth-limit-handler.ts`).
 *
 * The keys are `runs-rate-limit.ts`'s own key functions, so the two never drift
 * apart; the stores are separate (`source-divergence-*` prefixes).
 *
 * Caps are read per request; the window once, at module load
 * (`SOURCE_DIVERGENCE_LIMIT_WINDOW_MS`). Each limiter is exported as the
 * `rateLimit()` result itself so CodeQL sees it.
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey, runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const SOURCE_DIVERGENCE_USER_DEFAULT_MAX = 300;
export const SOURCE_DIVERGENCE_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("SOURCE_DIVERGENCE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "SOURCE_DIVERGENCE_RATE_LIMITED",
    message: "Too many requests to resolve source divergence — slow down",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const sourceDivergencePreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("source-divergence-preauth"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv("SOURCE_DIVERGENCE_PREAUTH_LIMIT_MAX", SOURCE_DIVERGENCE_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  // #1117 — a spent user bucket is 429; a spent peer bucket is requireAuth's 401.
  handler: preAuthLimitReachedHandler(runsPreAuthKey, limited),
}) as unknown as RequestHandler;

export const sourceDivergenceUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("source-divergence-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("SOURCE_DIVERGENCE_LIMIT_MAX", SOURCE_DIVERGENCE_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
