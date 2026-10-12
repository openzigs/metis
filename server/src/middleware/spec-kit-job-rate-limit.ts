/**
 * #1059 — rate limiter for the Spec Kit job endpoints
 * (`/api/projects/:id/spec-kit/jobs…` and `POST …/commands/:cmd/jobs`).
 *
 * A page watching a job reads its status every few seconds, and each read is a
 * database query behind an authorization check, so the endpoints are bounded on
 * top of the global limiter.
 *
 * It sits in front of `requireAuth` (CodeQL js/missing-rate-limiting wants the
 * limiter ahead of every auth check, as in `spec-kit-delete-rate-limit.ts`).
 * `req.user` is only set inside `requireAuth`, so it keys by client address.
 * Default 6000 requests per 15 minutes per address: one tab polling every 3
 * seconds makes 300, so 20 tabs behind one NAT address stay inside it. Tunable
 * via `SPECKIT_JOB_LIMIT_MAX` (read per request) and
 * `SPECKIT_JOB_LIMIT_WINDOW_MS` (read once, at module load).
 *
 * Exported as the `rateLimit()` result itself (not wrapped in a function) so
 * CodeQL recognises it as a rate limiter.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const SPECKIT_JOB_DEFAULT_MAX = 6000;

function maxPerWindow(): number {
  const n = Number.parseInt(process.env.SPECKIT_JOB_LIMIT_MAX ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : SPECKIT_JOB_DEFAULT_MAX;
}

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const specKitJobRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-job"),
  windowMs: envMs("SPECKIT_JOB_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => maxPerWindow(),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "SPECKIT_JOB_RATE_LIMITED",
      message: "Too many Spec Kit job requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
