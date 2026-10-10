/**
 * Rate limiter for `GET /api/projects/:projectId/analyses/imported-requirements`
 * (#1006).
 *
 * The read returns up to 500 of a project's imported requirements, so it is
 * bounded like the other database-backed reads (CodeQL
 * `js/missing-rate-limiting`). It runs AHEAD of `requireAuth`, which is where
 * CodeQL looks for it, so it is keyed per IP; the cap is generous because one
 * IP may front many users (a NAT or proxy). The start form calls this route once
 * per open, so the default sits far above any human use. Same shape as
 * `analysisApprovalPreAuthRateLimiter` (PR #902).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const IMPORTED_REQUIREMENTS_DEFAULT_MAX = 900;
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
 * see it. The cap is read per request, so `IMPORTED_REQUIREMENTS_RATE_LIMIT_MAX`
 * takes effect without a restart.
 */
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const importedRequirementsRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("imported-requirements"),
  windowMs: envMs("IMPORTED_REQUIREMENTS_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () =>
    intFromEnv("IMPORTED_REQUIREMENTS_RATE_LIMIT_MAX", IMPORTED_REQUIREMENTS_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many imported-requirement requests — please try again later",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
