/**
 * #1169 — rate limiter for `GET /api/projects/:id/pr-review-budget`, which
 * sums the month's PR-review ledger rows on every call.
 *
 * The route sits under the projects router's `/:id/:sub` chokepoint, which has
 * already run `requireAuth` and the project-access check, so the budget is the
 * signed-in user's (`req.user.userId`). The fallback is the TCP peer — never
 * `req.ip`, which under `trust proxy` is a client-writable `X-Forwarded-For`
 * entry. Default 600 per 15 minutes (`PR_REVIEW_BUDGET_LIMIT_MAX`): the
 * settings card and the PR-review page each read it once per load.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const PR_REVIEW_BUDGET_DEFAULT_MAX = 600;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The limiter's key. Exported for its test. */
export function prReviewBudgetKey(req: Request): string {
  if (req.user?.userId) return `user:${req.user.userId}`;
  const socket = req.socket;
  return `peer:${ipKeyGenerator(socket?.remoteAddress ?? "", socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

// Module-scoped `rateLimit()` result so CodeQL sees it. `as unknown as
// RequestHandler` bridges the Express 4↔5 type split.
export const prReviewBudgetRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("pr-review-budget"),
  windowMs: envMs("PR_REVIEW_BUDGET_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("PR_REVIEW_BUDGET_LIMIT_MAX", PR_REVIEW_BUDGET_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => prReviewBudgetKey(req as unknown as Request),
  message: {
    success: false,
    error: { code: "RATE_LIMIT", message: "Too many requests. Try again later." },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
