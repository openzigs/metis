/**
 * #789 — rate limiter for `DELETE /api/projects/:id/spec-kit/features/:slug/artifacts/*key`.
 *
 * Each call deletes a stored artifact and writes an audit row, so an
 * unbounded loop from a compromised account could empty a feature and flood
 * the audit log. Layered on top of the global limiter, like the
 * `scheduler-run-rate-limit.ts` / `sandbox-run-once-rate-limit.ts` limiters.
 *
 * Default: 30 deletes per minute per user. Tunable via
 * `SPECKIT_DELETE_LIMIT_MAX` and `SPECKIT_DELETE_LIMIT_WINDOW_MS`.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const ONE_MINUTE_MS = 60_000;
const DEFAULT_MAX = 30;

function windowMs(): number {
  const raw = Number(process.env.SPECKIT_DELETE_LIMIT_WINDOW_MS ?? ONE_MINUTE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ONE_MINUTE_MS;
}

function maxPerWindow(): number {
  const raw = Number(process.env.SPECKIT_DELETE_LIMIT_MAX ?? DEFAULT_MAX);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX;
}

// Duck-typed helper — avoids cross-version Express 4↔5 type conflict.
function keyByUser(
  req: { user?: { userId?: string }; ip?: string },
  res: { req?: { socket?: { remoteFamily?: string } } },
): string {
  const userId = req.user?.userId;
  if (userId) return `user:${userId}`;
  return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

function limitedResponse(): ApiResponse {
  return {
    success: false,
    error: { code: "SPECKIT_DELETE_RATE_LIMITED", message: "Too many deletes — slow down" },
  } satisfies ApiResponse;
}

function build(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("speckit-delete"),
    windowMs: windowMs(),
    max: maxPerWindow(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => keyByUser(req, res),
    message: limitedResponse(),
  });
}

// Initialised at module scope — express-rate-limit@8 throws ERR_ERL_CREATED_IN_REQUEST_HANDLER
// if rateLimit() is called inside a request handler.
let limiter: RateLimitRequestHandler = build();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const specKitDeleteRateLimiter: RequestHandler = (req, res, next) =>
  (limiter as unknown as RequestHandler)(req, res, next);

export function __resetSpecKitDeleteRateLimiter(): void {
  limiter = build();
}
