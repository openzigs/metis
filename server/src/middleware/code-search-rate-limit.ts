/**
 * Rate limiter for `POST /api/projects/:id/code-search` (#423).
 *
 * Each call embeds the query with the local embedder and scores the project's
 * whole symbol set, so it is bounded like the other compute-backed routes.
 * Keyed by userId; 300 req / 15 min by default. The IP fallback is defensive
 * only: the router's `/:id/:sub` chokepoint authenticates first, so every
 * request that reaches this limiter carries a user (PR #454 review).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
const DEFAULT_MAX = 300;
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

/**
 * Module-scoped and exported as the `rateLimit()` handler itself so CodeQL
 * `js/missing-rate-limiting` can see it. The cap is read per request, so
 * `CODE_SEARCH_RATE_LIMIT_MAX` takes effect without a restart.
 */
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const codeSearchRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("code-search"),
  windowMs: envMs("CODE_SEARCH_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("CODE_SEARCH_RATE_LIMIT_MAX", DEFAULT_MAX),
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
      code: "CODE_SEARCH_RATE_LIMITED",
      message: "Too many code-search requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
