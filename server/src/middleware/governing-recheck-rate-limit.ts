/**
 * #2281 — rate limiters for **Re-check this requirement**:
 * `POST /api/projects/:projectId/analyses/:id/governing-findings/recheck`.
 * One re-check is several model calls (applicability's screen and judge, then
 * the findings), so it is capped like the finding deep-dive (#178), not like a
 * read. Same shape as `withheld-replacement-rate-limit.ts` (#780):
 *
 *  - {@link governingRecheckUserRateLimiter} — AFTER `requireAuth` and the
 *    permission check, keyed on `req.user.userId`. Default 30 per 15 minutes
 *    (`GOVERNING_RECHECK_LIMIT_MAX`).
 *  - {@link governingRecheckPreAuthRateLimiter} — in FRONT of `requireAuth`,
 *    keyed on the user id in an access token this server signed, else the TCP
 *    peer, never `req.ip`. Default 20000 per 15 minutes
 *    (`GOVERNING_RECHECK_PREAUTH_LIMIT_MAX`). A spent peer bucket answers
 *    `requireAuth`'s 401, not 429 (#1117).
 *
 * Caps are read per request; the window once (`GOVERNING_RECHECK_LIMIT_WINDOW_MS`).
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey, runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const GOVERNING_RECHECK_USER_DEFAULT_MAX = 30;
export const GOVERNING_RECHECK_PREAUTH_DEFAULT_MAX = 20_000;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("GOVERNING_RECHECK_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "GOVERNING_RECHECK_RATE_LIMITED",
    message: "Too many governing re-checks — please try again later",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const governingRecheckPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("governing-recheck-preauth"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv("GOVERNING_RECHECK_PREAUTH_LIMIT_MAX", GOVERNING_RECHECK_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  handler: preAuthLimitReachedHandler(runsPreAuthKey, limited),
}) as unknown as RequestHandler;

export const governingRecheckUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("governing-recheck-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("GOVERNING_RECHECK_LIMIT_MAX", GOVERNING_RECHECK_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
