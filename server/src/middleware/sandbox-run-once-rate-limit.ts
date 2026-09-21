/**
 * Rate limiter for `POST /api/sandbox/run-once` (Issue #16, PR #440 follow-up).
 *
 * Each run-once spins up a real sandbox and executes user-supplied code, which
 * costs provider time/budget. Without a cap an authenticated developer (or a
 * compromised account) could loop the endpoint and burn a project's budget.
 *
 * Default: 20 runs per minute per user (falls back to IP for unauthenticated
 * callers, which RBAC rejects anyway). Tunable via `SANDBOX_RUN_ONCE_LIMIT_MAX`
 * and `SANDBOX_RUN_ONCE_LIMIT_WINDOW_MS`. Mirrors the existing limiter pattern
 * in `scheduler-run-rate-limit.ts` / `connector-rate-limit.ts`.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const ONE_MINUTE_MS = 60_000;

function windowMs(): number {
  const raw = Number(process.env.SANDBOX_RUN_ONCE_LIMIT_WINDOW_MS ?? ONE_MINUTE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ONE_MINUTE_MS;
}

function maxPerWindow(): number {
  const raw = Number(process.env.SANDBOX_RUN_ONCE_LIMIT_MAX ?? 20);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

// Duck-typed helper — avoids the Express 4↔5 type conflict pnpm may produce.
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
    error: {
      code: "SANDBOX_RUN_ONCE_RATE_LIMITED",
      message: "Too many sandbox runs — slow down",
    },
  } satisfies ApiResponse;
}

function build(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("sandbox-run-once"),
    windowMs: windowMs(),
    max: maxPerWindow(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => keyByUser(req, res),
    message: limitedResponse(),
  });
}

// Initialised at module scope — express-rate-limit@8 throws
// ERR_ERL_CREATED_IN_REQUEST_HANDLER if rateLimit() runs inside a handler.
let limiter: RateLimitRequestHandler = build();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const sandboxRunOnceRateLimiter: RequestHandler = (req, res, next) =>
  (limiter as unknown as RequestHandler)(req, res, next);

/** Test seam — re-create the limiter so env overrides set before this call take effect. */
export function __resetSandboxRunOnceRateLimiter(): void {
  limiter = build();
}
