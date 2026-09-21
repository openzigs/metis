/**
 * Rate limiter for /api/products (Epic #544).
 *
 * Follows the same pattern as mcp-admin-rate-limit.ts — keyed by userId if
 * authenticated, IP otherwise. Defaults to 120 req / 15 min (products are
 * moderate-volume CRUD, not high-freq streaming).
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

function buildProductsLimiter(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("products"),
    windowMs: intFromEnv("PRODUCTS_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS),
    max: intFromEnv("PRODUCTS_RATE_LIMIT_MAX", DEFAULT_MAX),
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
        code: "PRODUCTS_RATE_LIMITED",
        message: "Too many product requests — slow down",
      },
    } satisfies ApiResponse,
  });
}

// Initialised at module scope — express-rate-limit@8 throws ERR_ERL_CREATED_IN_REQUEST_HANDLER
// if rateLimit() is called inside a request handler.
let limiter: RateLimitRequestHandler = buildProductsLimiter();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const productsRateLimiter: RequestHandler = (req, res, next) =>
  (limiter as unknown as RequestHandler)(req, res, next);

/** Test seam — re-create limiter so env overrides set before this call take effect. */
export function __resetProductsRateLimiter(): void {
  limiter = buildProductsLimiter();
}
