/**
 * #789 — rate limiter for `DELETE /api/projects/:id/spec-kit/features/:slug/artifacts/*key`.
 *
 * Each call deletes a stored artifact and writes an audit row, so an
 * unbounded loop could empty a feature and flood the audit log. Layered on
 * top of the global limiter.
 *
 * It sits in front of `requireAuth` (CodeQL js/missing-rate-limiting wants the
 * limiter ahead of every auth check, as in `traceability-gaps-rate-limit.ts`).
 * `req.user` is only set inside `requireAuth`, so at this point the only
 * identity is the client address: it always keys by IP. Default 120 deletes
 * per minute per IP, generous enough for users sharing one NAT address.
 * Tunable via `SPECKIT_DELETE_LIMIT_MAX` (read per request) and
 * `SPECKIT_DELETE_LIMIT_WINDOW_MS` (read once, at module load).
 *
 * Exported as the `rateLimit()` result itself (not wrapped in a function) so
 * CodeQL recognises it as a rate limiter.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const ONE_MINUTE_MS = 60_000;
export const SPECKIT_DELETE_DEFAULT_MAX = 120;

function maxPerWindow(): number {
  const n = Number.parseInt(process.env.SPECKIT_DELETE_LIMIT_MAX ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : SPECKIT_DELETE_DEFAULT_MAX;
}

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const specKitDeleteRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-delete"),
  windowMs: envMs("SPECKIT_DELETE_LIMIT_WINDOW_MS", ONE_MINUTE_MS, { min: 1 }),
  limit: () => maxPerWindow(),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: { code: "SPECKIT_DELETE_RATE_LIMITED", message: "Too many deletes — slow down" },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
