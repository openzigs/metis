/**
 * Rate limiter for `POST /api/projects/:projectId/analyses/:id/approvals/:approvalId/reopen`
 * (#723).
 *
 * Reopening a rejected approval is a database write that closes the promotion
 * gate again, so it is bounded like the other state-changing analysis routes
 * (CodeQL `js/missing-rate-limiting`). Keyed by userId; 120 req / 15 min by
 * default — far above a reviewer working through a list by hand. The IP
 * fallback is defensive only: the route's own `requireAuth` runs first. Same
 * shape as `traceability-gaps-rate-limit.ts` (#814).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const ANALYSIS_APPROVAL_REOPEN_DEFAULT_MAX = 120;
const TEST_DEFAULT_MAX = 10_000;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return process.env.NODE_ENV === "test" ? TEST_DEFAULT_MAX : fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Module-scoped and exported as the `rateLimit()` handler itself so CodeQL can
 * see it. The cap is read per request, so `ANALYSIS_APPROVAL_REOPEN_RATE_LIMIT_MAX`
 * takes effect without a restart.
 */
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const analysisApprovalReopenRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("analysis-approval-reopen"),
  windowMs: envMs("ANALYSIS_APPROVAL_REOPEN_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () =>
    intFromEnv("ANALYSIS_APPROVAL_REOPEN_RATE_LIMIT_MAX", ANALYSIS_APPROVAL_REOPEN_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const userId = req.user?.userId;
    if (userId) return `user:${userId}`;
    return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
  },
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many approval reopen requests — please try again later",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;

/**
 * Rate limiter for `POST /api/projects/:projectId/analyses/:id/approvals/promote`
 * (#723). Promotion writes the requirement set, so it is bounded like the
 * reopen route above (CodeQL `js/missing-rate-limiting`), under its own key
 * and cap. A reviewer clicks it once per stranded run; 30 / 15 min is ample.
 */
export const ANALYSIS_APPROVAL_PROMOTE_DEFAULT_MAX = 30;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const analysisApprovalPromoteRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("analysis-approval-promote"),
  windowMs: envMs("ANALYSIS_APPROVAL_PROMOTE_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () =>
    intFromEnv("ANALYSIS_APPROVAL_PROMOTE_RATE_LIMIT_MAX", ANALYSIS_APPROVAL_PROMOTE_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const userId = req.user?.userId;
    if (userId) return `user:${userId}`;
    return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
  },
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many requirement promotion requests — please try again later",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;

/**
 * PR #902 CI — a per-IP ceiling AHEAD of `requireAuth` on the promote and
 * reopen routes only. CodeQL `js/missing-rate-limiting` flags the route's own
 * `requireAuth` ("performs authorization, but is not rate-limited") unless an
 * `express-rate-limit` handler precedes it; the per-user limiters above then
 * run after the permission check, unchanged. Keyed by IP alone, and generous
 * because one IP may front many users (a NAT or proxy). Same shape as
 * `traceabilityPreAuthRateLimiter` (#815) and `importsPreAuthRateLimiter` (#850).
 */
export const ANALYSIS_APPROVAL_PREAUTH_DEFAULT_MAX = 3_600;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const analysisApprovalPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("analysis-approval-preauth"),
  windowMs: envMs("ANALYSIS_APPROVAL_PREAUTH_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () =>
    intFromEnv("ANALYSIS_APPROVAL_PREAUTH_RATE_LIMIT_MAX", ANALYSIS_APPROVAL_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many approval requests — please try again later",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
