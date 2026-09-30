/**
 * Rate limiter for `POST /api/projects/:id/code-search` (#423).
 *
 * Each call embeds the query with the local embedder and scores the project's
 * whole symbol set, so it is bounded like the other compute-backed routes.
 * Keyed by userId when authenticated, IP otherwise; 300 req / 15 min by default.
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

/**
 * Pre-auth, per-IP ceiling for the same route. `projectsRouter` authenticates
 * and scopes every `/:id/:sub` path in one router-level `.use`, which CodeQL
 * reads as the authorization step — so a limiter on the route itself sits
 * AFTER it and does not satisfy `js/missing-rate-limiting`. This one is mounted
 * ahead of that chokepoint. Generous (4× the per-user budget) because every
 * user behind one NAT shares an IP; `CODE_SEARCH_PREAUTH_RATE_LIMIT_MAX`
 * overrides it, read per request.
 */
export const CODE_SEARCH_PREAUTH_DEFAULT_MAX = 1_200;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const codeSearchPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("code-search-preauth"),
  windowMs: envMs("CODE_SEARCH_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => {
    const raw = process.env.CODE_SEARCH_PREAUTH_RATE_LIMIT_MAX;
    if (raw == null || raw === "") {
      return process.env.NODE_ENV === "test" ? TEST_DEFAULT_MAX : CODE_SEARCH_PREAUTH_DEFAULT_MAX;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : CODE_SEARCH_PREAUTH_DEFAULT_MAX;
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "CODE_SEARCH_RATE_LIMITED",
      message: "Too many code-search requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
