/**
 * Rate limiter for `POST /api/scheduler/:id/run` (review finding M4).
 *
 * Manual triggers are cheap to fire but each one enqueues a Task that may
 * spin up an HTTP webhook, ingest a repo, or run an analysis. Without a cap
 * a compromised account can heap-grow the queue until the process OOMs.
 *
 * Default: 10 manual runs per minute per user. Tunable via
 * `SCHEDULER_RUN_LIMIT_MAX` and `SCHEDULER_RUN_LIMIT_WINDOW_MS`.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const ONE_MINUTE_MS = 60_000;

function windowMs(): number {
  const raw = Number(process.env.SCHEDULER_RUN_LIMIT_WINDOW_MS ?? ONE_MINUTE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ONE_MINUTE_MS;
}

function maxPerWindow(): number {
  const raw = Number(process.env.SCHEDULER_RUN_LIMIT_MAX ?? 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
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
    error: { code: "SCHEDULER_RUN_RATE_LIMITED", message: "Too many manual runs — slow down" },
  } satisfies ApiResponse;
}

function build(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("scheduler-run"),
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
export const runNowRateLimiter: RequestHandler = (req, res, next) =>
  (limiter as unknown as RequestHandler)(req, res, next);

export function __resetRunNowRateLimiter(): void {
  limiter = build();
}
