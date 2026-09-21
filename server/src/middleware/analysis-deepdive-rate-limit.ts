/**
 * Rate limiter for the analysis finding deep-dive endpoint (Epic #176 / #178).
 *
 * The deep-dive route triggers an LLM call per request, so it is more expensive
 * than a plain read. We cap it tighter than the generic API limiter. Keyed by
 * userId when authenticated, IP otherwise. Defaults to 30 req / 15 min.
 *
 * Mirrors jira-rate-limit.ts — the limiter is built at module scope because
 * express-rate-limit@8 throws ERR_ERL_CREATED_IN_REQUEST_HANDLER if rateLimit()
 * is invoked inside a handler.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
const DEFAULT_MAX = 30;
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

function buildDeepDiveLimiter(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("analysis-deepdive"),
    windowMs: intFromEnv("ANALYSIS_DEEPDIVE_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS),
    max: intFromEnv("ANALYSIS_DEEPDIVE_RATE_LIMIT_MAX", DEFAULT_MAX),
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
        message: "Too many deep-dive requests — please try again later",
      },
    } satisfies ApiResponse,
  });
}

const _limiter: RateLimitRequestHandler = buildDeepDiveLimiter();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const analysisDeepDiveRateLimiter: RequestHandler = (req, res, next) =>
  (_limiter as unknown as RequestHandler)(req, res, next);
