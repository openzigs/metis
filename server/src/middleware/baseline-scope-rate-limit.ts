/**
 * #1137 — rate limiters for `GET /api/projects/:projectId/baselines/scope`, the
 * count New baseline shows before it is created. Same shape and defaults as
 * `withheld-replacement-rate-limit.ts` (#780):
 *  - {@link baselineScopeUserRateLimiter} — AFTER `requireAuth`, keyed on
 *    `req.user.userId`. Default 300 per 15 minutes (`BASELINE_SCOPE_LIMIT_MAX`).
 *  - {@link baselineScopePreAuthRateLimiter} — in FRONT of `requireAuth`,
 *    keyed on the user id in an access token this server signed, else the TCP
 *    peer, never `req.ip`. Default 20000 per 15 minutes
 *    (`BASELINE_SCOPE_PREAUTH_LIMIT_MAX`). A spent peer bucket answers
 *    `requireAuth`'s 401, not 429 (#1117).
 * Caps are read per request; the window once (`BASELINE_SCOPE_LIMIT_WINDOW_MS`).
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey, runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const BASELINE_SCOPE_USER_DEFAULT_MAX = 300;
export const BASELINE_SCOPE_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("BASELINE_SCOPE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "BASELINE_SCOPE_RATE_LIMITED",
    message: "Too many baseline scope requests — slow down",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const baselineScopePreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("baseline-scope-preauth"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("BASELINE_SCOPE_PREAUTH_LIMIT_MAX", BASELINE_SCOPE_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  handler: preAuthLimitReachedHandler(runsPreAuthKey, limited),
}) as unknown as RequestHandler;

export const baselineScopeUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("baseline-scope-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("BASELINE_SCOPE_LIMIT_MAX", BASELINE_SCOPE_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
