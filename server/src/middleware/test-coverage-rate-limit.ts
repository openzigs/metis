/**
 * Router-level rate limiters for the test-coverage router (#795):
 * `/api/projects/:projectId/test-coverage/…`.
 *
 * #795 mounted `requireProjectAccess()` on this router, which reads the project
 * row on every request, and CodeQL `js/missing-rate-limiting` flags a DB-reading
 * middleware with no limiter in front. This file follows the
 * generated-docs-rate-limit.ts (#632) pattern:
 *
 * - {@link testCoveragePreAuthRateLimiter} — per IP, mounted IN FRONT of
 *   `requireAuth`, so an anonymous flood is refused before any JWT is verified.
 * - {@link testCoverageRateLimiter} — per authenticated user (IP fallback),
 *   mounted after `requireAuth` and IN FRONT of `requireProjectAccess()`.
 *
 * Both are generous: the test-coverage page polls every 4 s while a run is in
 * flight (225 requests / 15 min), so the per-user default is 900 / 15 min, and
 * the per-IP ceiling, shared by every user behind one NAT, is four times that.
 *
 * Both are built at module scope and export the `rateLimit()` handler itself:
 * express-rate-limit@8 throws ERR_ERL_CREATED_IN_REQUEST_HANDLER if
 * `rateLimit()` runs inside a handler, and static analysis has to be able to see
 * the limiter. Caps are read on each request, so `TEST_COVERAGE_RATE_LIMIT_MAX`
 * and `TEST_COVERAGE_PREAUTH_RATE_LIMIT_MAX` take effect without a restart; the
 * window (`TEST_COVERAGE_RATE_LIMIT_WINDOW_MS`) is fixed when the limiter is built.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler, Response } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
const TEST_DEFAULT_MAX = 10_000;

/** Per-user requests per window. */
export const TEST_COVERAGE_DEFAULT_MAX = 900;
/** Per-IP requests per window, ahead of authentication. */
export const TEST_COVERAGE_PREAUTH_DEFAULT_MAX = 3_600;

function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return process.env.NODE_ENV === "test" ? TEST_DEFAULT_MAX : fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ipKey(req: Request, res: Response): string {
  return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

const windowMs = envMs("TEST_COVERAGE_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const message = {
  success: false,
  error: {
    code: "TEST_COVERAGE_RATE_LIMITED",
    message: "Too many test-coverage requests — slow down",
  },
} satisfies ApiResponse;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const testCoverageRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("test-coverage"),
  windowMs,
  limit: () => capFromEnv("TEST_COVERAGE_RATE_LIMIT_MAX", TEST_COVERAGE_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const userId = req.user?.userId;
    return userId ? `user:${userId}` : ipKey(req, res);
  },
  message,
}) as unknown as RequestHandler;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const testCoveragePreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("test-coverage-preauth"),
  windowMs,
  limit: () =>
    capFromEnv("TEST_COVERAGE_PREAUTH_RATE_LIMIT_MAX", TEST_COVERAGE_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message,
}) as unknown as RequestHandler;
