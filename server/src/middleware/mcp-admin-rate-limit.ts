/**
 * Issue #316 (OWASP A04) — rate limiters for `/api/admin/*` and `/api/mcp/*`.
 *
 * The auth router already had `authRateLimiter`. The most powerful registry-
 * write and runtime-config endpoints had no per-IP/per-user throttle. A
 * compromised admin token could be used to spam `POST /api/mcp` or
 * `PUT /api/admin/config/...` until the host fell over.
 *
 * Two limiters are exported, both keyed by `userId` if authenticated and IP
 * otherwise:
 *
 *   - `mcpAdminRateLimiter`   — mounted on `/api/admin`
 *   - `mcpServerRateLimiter`  — mounted on `/api/mcp`
 *
 * Defaults (60 req / 15 min — admin endpoints are NOT high-volume) are
 * tunable via env. `/healthz` and `/readyz` live OUTSIDE `/api/*` so they
 * are never rate-limited by these middlewares.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
const DEFAULT_MAX = 60;
// In the test runner, suite files share the in-memory limiter state across
// hundreds of `mcp-routes.test.ts`-style requests. We bump the default ceiling
// to a value high enough that no existing test trips the limiter
// inadvertently. The dedicated `mcp-admin-rate-limit.test.ts` overrides
// `ADMIN_RATE_LIMIT_MAX` / `MCP_RATE_LIMIT_MAX` to small values to actually
// assert 429 behaviour.
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

function limitedBody(code: string, message: string): ApiResponse {
  return { success: false, error: { code, message } } satisfies ApiResponse;
}

function buildAdminLimiter(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("mcp-admin"),
    windowMs: intFromEnv("ADMIN_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS),
    max: intFromEnv("ADMIN_RATE_LIMIT_MAX", DEFAULT_MAX),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => {
      const userId = req.user?.userId;
      if (userId) return `user:${userId}`;
      return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
    },
    message: limitedBody(
      "ADMIN_RATE_LIMITED",
      "Too many admin requests — slow down or contact your operator",
    ),
  });
}

function buildMcpLimiter(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("mcp-server"),
    windowMs: intFromEnv("MCP_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS),
    max: intFromEnv("MCP_RATE_LIMIT_MAX", DEFAULT_MAX),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => {
      const userId = req.user?.userId;
      if (userId) return `user:${userId}`;
      return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
    },
    message: limitedBody("MCP_RATE_LIMITED", "Too many MCP registry requests — slow down"),
  });
}

// Initialised at module scope — express-rate-limit@8 throws ERR_ERL_CREATED_IN_REQUEST_HANDLER
// if rateLimit() is called inside a request handler. Test seam resets via __reset below.
let adminLimiter: RateLimitRequestHandler = buildAdminLimiter();
let mcpLimiter: RateLimitRequestHandler = buildMcpLimiter();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split that pnpm
// may produce when resolving @types/express for different packages at once.
export const mcpAdminRateLimiter: RequestHandler = (req, res, next) =>
  (adminLimiter as unknown as RequestHandler)(req, res, next);

export const mcpServerRateLimiter: RequestHandler = (req, res, next) =>
  (mcpLimiter as unknown as RequestHandler)(req, res, next);

/** Test seam — re-create limiters so env overrides set before this call take effect. */
export function __resetMcpAdminRateLimiters(): void {
  adminLimiter = buildAdminLimiter();
  mcpLimiter = buildMcpLimiter();
}
