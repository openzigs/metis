/**
 * PR #850 CI — a per-IP ceiling ahead of `importsRouter()`'s router-level
 * `requireAuth` and `requireProjectAccess()`.
 *
 * Since #763 the preview and create routes authorise a vault secret reference,
 * and CodeQL `js/missing-rate-limiting` flagged them (alerts 541, 542) as
 * authorising handlers with no limiter in front. This limiter runs first, the
 * same as `importsPreAuthRateLimiter`. The cap is generous because one IP may front many users
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
export const IMPORTS_PREAUTH_DEFAULT_MAX = 3_600;
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
 * see it. The cap is read per request, so `IMPORTS_PREAUTH_RATE_LIMIT_MAX`
 * takes effect without a restart.
 */
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const importsPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("imports-preauth"),
  windowMs: envMs("IMPORTS_PREAUTH_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("IMPORTS_PREAUTH_RATE_LIMIT_MAX", IMPORTS_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "IMPORTS_RATE_LIMITED",
      message: "Too many import requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
