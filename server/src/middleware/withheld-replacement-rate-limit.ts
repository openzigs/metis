/**
 * Issue #780 — rate limiters for reviewing, applying and dismissing a withheld
 * re-synthesis: `GET|POST /api/projects/:projectId/analyses/:id/withheld-replacement[/apply|/dismiss]`.
 * Same shape and defaults as `criteria-proposal-rate-limit.ts` (#1389):
 *
 *  - {@link withheldReplacementUserRateLimiter} — AFTER `requireAuth`, keyed on
 *    `req.user.userId`. Default 300 per 15 minutes (`WITHHELD_REPLACEMENT_LIMIT_MAX`).
 *  - {@link withheldReplacementPreAuthRateLimiter} — in FRONT of `requireAuth`,
 *    keyed on the user id in an access token this server signed, else the TCP
 *    peer, never `req.ip`. Default 20000 per 15 minutes
 *    (`WITHHELD_REPLACEMENT_PREAUTH_LIMIT_MAX`). A spent peer bucket answers
 *    `requireAuth`'s 401, not 429 (#1117).
 *
 * Caps are read per request; the window once (`WITHHELD_REPLACEMENT_LIMIT_WINDOW_MS`).
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey, runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const WITHHELD_REPLACEMENT_USER_DEFAULT_MAX = 300;
export const WITHHELD_REPLACEMENT_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("WITHHELD_REPLACEMENT_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "WITHHELD_REPLACEMENT_RATE_LIMITED",
    message: "Too many requests about a withheld re-synthesis — slow down",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const withheldReplacementPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("withheld-replacement-preauth"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv("WITHHELD_REPLACEMENT_PREAUTH_LIMIT_MAX", WITHHELD_REPLACEMENT_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  handler: preAuthLimitReachedHandler(runsPreAuthKey, limited),
}) as unknown as RequestHandler;

export const withheldReplacementUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("withheld-replacement-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("WITHHELD_REPLACEMENT_LIMIT_MAX", WITHHELD_REPLACEMENT_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
