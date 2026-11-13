/**
 * Issue #2341 — rate limiters for renaming a change request,
 * `PATCH /api/projects/:projectId/analyses/:id`.
 *
 * A rename is a cheap single-row write, but it is a state-changing route with
 * its own authorization decision, so it is bounded like its sibling
 * `PATCH …/approvals/:approvalId/requirement` (#1580): a coarse per-peer
 * ceiling AHEAD of `requireAuth` (CodeQL `js/missing-rate-limiting` flags an
 * authorizing route with none), then a per-user cap after the permission
 * check. Same shapes as `analysis-approval-rate-limit.ts`.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { runsPreAuthKey } from "./runs-rate-limit.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
const TEST_DEFAULT_MAX = 10_000;

/** Far above an analyst renaming change requests by hand. */
export const ANALYSIS_RENAME_DEFAULT_MAX = 120;
/** The per-peer ceiling ahead of auth; a shared NAT holds many analysts. */
export const ANALYSIS_RENAME_PREAUTH_DEFAULT_MAX = 1_200;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return process.env.NODE_ENV === "test" ? TEST_DEFAULT_MAX : fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const analysisRenameRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("analysis-rename"),
  windowMs: envMs("ANALYSIS_RENAME_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("ANALYSIS_RENAME_RATE_LIMIT_MAX", ANALYSIS_RENAME_DEFAULT_MAX),
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
      message: "Too many rename requests — please try again later",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;

// Keyed like the runs guard (#1349): the user id in a token this server signed,
// else the TCP peer — never the client-written `X-Forwarded-For`.
export const analysisRenamePreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("analysis-rename-preauth"),
  windowMs: envMs("ANALYSIS_RENAME_PREAUTH_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () =>
    intFromEnv("ANALYSIS_RENAME_PREAUTH_RATE_LIMIT_MAX", ANALYSIS_RENAME_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsPreAuthKey(req as unknown as Request),
  handler: preAuthLimitReachedHandler(runsPreAuthKey, {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many rename requests — please try again later",
    },
  }),
}) as unknown as RequestHandler;
