/**
 * Rate limiter for `GET /api/workspaces/:workspaceId/finops/usage-totals`
 * (#977), which runs three aggregates over the workspace's ledger rows on
 * every call.
 *
 * Per IP and AHEAD of `requireAuth`: CodeQL `js/missing-rate-limiting` treats
 * `requireAuth` as the authorization step, so a limiter after it does not
 * count, and an anonymous flood would otherwise pay a JWT verify each. The cap
 * is generous because one IP may front many users (a NAT or proxy). Same
 * shape as `traceabilityPreAuthRateLimiter` (#815).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const FINOPS_USAGE_PREAUTH_DEFAULT_MAX = 3_600;
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
 * see it. The cap is read per request, so `FINOPS_USAGE_RATE_LIMIT_MAX` takes
 * effect without a restart.
 */
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const finopsUsagePreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("finops-usage-preauth"),
  windowMs: envMs("FINOPS_USAGE_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("FINOPS_USAGE_RATE_LIMIT_MAX", FINOPS_USAGE_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "FINOPS_USAGE_RATE_LIMITED",
      message: "Too many usage requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
