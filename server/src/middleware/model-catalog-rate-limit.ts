/**
 * Rate limiter for `GET /api/ai/models` (#135).
 *
 * The catalog route can reach out to a local runtime (model discovery, bounded
 * and cached), so it is rate-limited even though it is a read. Follows the
 * products-rate-limit.ts pattern — keyed by userId when authenticated, IP
 * otherwise; 120 req / 15 min by default (a picker loads it once per open).
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
const DEFAULT_MAX = 120;
const TEST_DEFAULT_MAX = 10_000;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return process.env.NODE_ENV === "test" && fallback === DEFAULT_MAX
      ? TEST_DEFAULT_MAX
      : fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildModelCatalogLimiter(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("model-catalog"),
    windowMs: intFromEnv("MODEL_CATALOG_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS),
    max: intFromEnv("MODEL_CATALOG_RATE_LIMIT_MAX", DEFAULT_MAX),
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
        code: "MODEL_CATALOG_RATE_LIMITED",
        message: "Too many model catalog requests — slow down",
      },
    } satisfies ApiResponse,
  });
}

// Initialised at module scope — express-rate-limit@8 throws if rateLimit() is
// called inside a request handler.
let limiter: RateLimitRequestHandler = buildModelCatalogLimiter();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const modelCatalogRateLimiter: RequestHandler = (req, res, next) =>
  (limiter as unknown as RequestHandler)(req, res, next);

/** Test seam — re-create the limiter so env overrides set before this call take effect. */
export function __resetModelCatalogRateLimiter(): void {
  limiter = buildModelCatalogLimiter();
}
