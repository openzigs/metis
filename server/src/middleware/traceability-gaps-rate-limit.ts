/**
 * Rate limiter for `GET /api/projects/:projectId/traceability/test-gaps` (#814)
 * and `GET /api/workspaces/:workspaceId/traceability/summary` (#815).
 *
 * Each call loads every requirement in scope plus the project's mapped code
 * graph to decide which requirements have a test, so it is bounded like the
 * other compute-backed reads (CodeQL `js/missing-rate-limiting`). Keyed by
 * userId; 300 req / 15 min by default. The IP fallback is defensive only: the
 * routers' own `requireAuth` runs first, so every request that reaches this
 * limiter carries a user. Same shape as `code-search-rate-limit.ts` (#423).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const TRACEABILITY_GAPS_DEFAULT_MAX = 300;
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
 * see it. The cap is read per request, so `TRACEABILITY_GAPS_RATE_LIMIT_MAX`
 * takes effect without a restart.
 */
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const traceabilityGapsRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("traceability-gaps"),
  windowMs: envMs("TRACEABILITY_GAPS_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("TRACEABILITY_GAPS_RATE_LIMIT_MAX", TRACEABILITY_GAPS_DEFAULT_MAX),
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
      code: "TRACEABILITY_GAPS_RATE_LIMITED",
      message: "Too many traceability coverage requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
