/**
 * AI-route rate limiter (Phase 4).
 *
 * Layered on top of `authRateLimiter` so credential-stuffing remains
 * separately gated. Defaults to 60 requests / 15 min per authenticated user
 * (falls back to IP for unauthenticated probes). Thresholds are tunable via
 * `AI_RATE_LIMIT_MAX` / `AI_RATE_LIMIT_WINDOW_MS`.
 *
 * The limiter MUST be constructed at module scope (not lazily inside a request
 * handler) — express-rate-limit v7+ creates a new MemoryStore per call,
 * so lazy construction silently disables rate-limiting (fix for #238).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { loadAIConfig } from "../lib/ai/config.js";

const cfg = loadAIConfig();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const aiRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("ai"),
  windowMs: cfg.rateLimit.windowMs,
  max: cfg.rateLimit.max,
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
      code: "AI_RATE_LIMITED",
      message: "Too many AI requests — please slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;

/**
 * Test helper — no-op. The limiter is now module-scoped so there is no lazy
 * singleton to drop. Kept for backward compatibility with existing test
 * imports.
 */
export function __resetAIRateLimiter(): void {
  // Intentional no-op — limiter is module-scoped (fix for #238).
}
