/**
 * PR #850 review — a per-IP ceiling ahead of `publishingRouter()`'s router-level
 * `requireAuth` and `requireProjectAccess()`.
 *
 * The router now resolves the path project's workspace on every request (a
 * database read) before any route runs. CodeQL `js/missing-rate-limiting`
 * flags router-level auth with no limiter in front of it (#815, #836), so this
 * limiter runs first. The cap is generous because one IP may front many users
 * (a NAT or proxy); it bounds abuse, not ordinary use. Same shape as
 * `traceabilityPreAuthRateLimiter` and the generated-docs pair (#632).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
/** Per-IP requests per window, ahead of authentication. */
export const PUBLISHING_PREAUTH_DEFAULT_MAX = 3_600;
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
 * see it. The cap is read per request, so `PUBLISHING_PREAUTH_RATE_LIMIT_MAX`
 * takes effect without a restart.
 */
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const publishingPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("publishing-preauth"),
  windowMs: envMs("PUBLISHING_PREAUTH_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("PUBLISHING_PREAUTH_RATE_LIMIT_MAX", PUBLISHING_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "PUBLISHING_RATE_LIMITED",
      message: "Too many publishing requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
