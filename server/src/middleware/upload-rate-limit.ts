/**
 * Per-feature rate limiters used by Phase 5 routes (uploads + retrieval).
 *
 * Configurable via env so deployments can tune for their reverse-proxy
 * topology. Defaults are deliberately conservative for an internal tool.
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const intEnv = (raw: string | undefined, fallback: number, min = 1): number => {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

const denied = (code: string, message: string): ApiResponse => ({
  success: false,
  error: { code, message },
});

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const uploadRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("upload"),
  windowMs: intEnv(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max: intEnv(process.env.UPLOAD_RATE_LIMIT_MAX, 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: denied("RATE_LIMITED", "Too many uploads — please slow down"),
}) as unknown as RequestHandler;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const retrieveRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("retrieve"),
  windowMs: intEnv(process.env.RETRIEVE_RATE_LIMIT_WINDOW_MS, 60 * 1000),
  max: intEnv(process.env.RETRIEVE_RATE_LIMIT_MAX, 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: denied("RATE_LIMITED", "Too many retrieval requests — please slow down"),
}) as unknown as RequestHandler;
