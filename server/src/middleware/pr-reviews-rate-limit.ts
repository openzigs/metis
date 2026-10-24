/**
 * #1472 — rate limiters for `prReviewsRouter()` (`/api/projects/:projectId/pr-reviews`:
 * the list, the detail and re-review). Every role reads it since #1472, and its
 * router-level `requireProjectAccess()` reads the project row on every request.
 * Same shape as `baseline-scope-rate-limit.ts`:
 *  - {@link prReviewsUserRateLimiter} — AFTER `requireAuth`, keyed on
 *    `req.user.userId`. Default 600 per 15 minutes (`PR_REVIEWS_LIMIT_MAX`): the
 *    pull requests page and a detail page each read once per load.
 *  - {@link prReviewsPreAuthRateLimiter} — in FRONT of `requireAuth`, keyed on
 *    the user id in an access token this server signed, else the TCP peer, never
 *    `req.ip`. Default 20000 per 15 minutes (`PR_REVIEWS_PREAUTH_LIMIT_MAX`). A
 *    spent peer bucket answers `requireAuth`'s 401, not 429 (#1117).
 * Caps are read per request; the window once (`PR_REVIEWS_LIMIT_WINDOW_MS`).
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey, runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const PR_REVIEWS_USER_DEFAULT_MAX = 600;
export const PR_REVIEWS_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("PR_REVIEWS_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: { code: "PR_REVIEWS_RATE_LIMITED", message: "Too many PR review requests — slow down" },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const prReviewsPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("pr-reviews-preauth"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("PR_REVIEWS_PREAUTH_LIMIT_MAX", PR_REVIEWS_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  handler: preAuthLimitReachedHandler(runsPreAuthKey, limited),
}) as unknown as RequestHandler;

export const prReviewsUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("pr-reviews-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("PR_REVIEWS_LIMIT_MAX", PR_REVIEWS_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
