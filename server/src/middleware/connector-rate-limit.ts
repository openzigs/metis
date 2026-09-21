/**
 * Connector-route rate limiters (Phase 8 SEC L2).
 *
 * Layered ON TOP of the global limiter. Bounds the impact of a misbehaving
 * client (or a compromised account) on expensive connector operations:
 *
 *   - /query    : real database execution → 30/min/user
 *   - /test     : opens a new pool        → 10/min/user
 *   - /metadata : Octokit fan-out         → 60/min/user
 *
 * Limiter keys default to the authenticated `userId` (falls back to IP for
 * unauthenticated requests, which RBAC will reject anyway). Tunable via env
 * vars `CONNECTOR_*_LIMIT_MAX` and `CONNECTOR_RATE_LIMIT_WINDOW_MS`.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const ONE_MINUTE_MS = 60_000;

function windowMs(): number {
  const raw = Number(process.env.CONNECTOR_RATE_LIMIT_WINDOW_MS ?? ONE_MINUTE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ONE_MINUTE_MS;
}

function envMax(envVar: string, fallback: number): number {
  const raw = Number(process.env[envVar] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function limitedResponse(code: string, message: string): ApiResponse {
  return { success: false, error: { code, message } } satisfies ApiResponse;
}

/**
 * Build the per-user (fallback: IP) key for this limiter.
 * Duck-typed so it's compatible with both @types/express@4 and @types/express@5
 * which pnpm may resolve to different versions in the same project.
 */
function userOrIpKey(
  req: { user?: { userId?: string }; ip?: string },
  res: { req?: { socket?: { remoteFamily?: string } } },
): string {
  const userId = req.user?.userId;
  if (userId) return `user:${userId}`;
  return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

function buildQuery(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("connector-query"),
    windowMs: windowMs(),
    max: envMax("CONNECTOR_QUERY_LIMIT_MAX", 30),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userOrIpKey,
    message: limitedResponse("CONNECTOR_QUERY_RATE_LIMITED", "Too many queries — slow down"),
  });
}
function buildTest(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("connector-test"),
    windowMs: windowMs(),
    max: envMax("CONNECTOR_TEST_LIMIT_MAX", 10),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userOrIpKey,
    message: limitedResponse("CONNECTOR_TEST_RATE_LIMITED", "Too many test requests"),
  });
}
function buildMetadata(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("connector-metadata"),
    windowMs: windowMs(),
    max: envMax("CONNECTOR_METADATA_LIMIT_MAX", 60),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userOrIpKey,
    message: limitedResponse("CONNECTOR_METADATA_RATE_LIMITED", "Too many metadata requests"),
  });
}

/**
 * Suggested-connector credential read limiter (Epic #701 / Issue #704).
 *
 * The GET /suggested-connectors/:id route returns a one-shot decrypted
 * dev password. `:id` is the only thing standing between a compromised
 * session and a sweep of every stored dev credential the user can reach.
 * A tight per-user rate limit makes bulk enumeration noisy in audit
 * instead of silent. Default 10/min/user, tunable via
 * `CONNECTOR_SUGGESTED_CRED_READ_LIMIT_MAX`.
 */
function buildSuggestedCredentialRead(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("connector-cred-read"),
    windowMs: windowMs(),
    max: envMax("CONNECTOR_SUGGESTED_CRED_READ_LIMIT_MAX", 10),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userOrIpKey,
    message: limitedResponse(
      "SUGGESTED_CONNECTOR_CRED_READ_RATE_LIMITED",
      "Too many credential read requests",
    ),
  });
}

// Initialised at module scope — express-rate-limit@8 throws ERR_ERL_CREATED_IN_REQUEST_HANDLER
// if rateLimit() is called inside a request handler.
let queryLimiter: RateLimitRequestHandler = buildQuery();
let testLimiter: RateLimitRequestHandler = buildTest();
let metadataLimiter: RateLimitRequestHandler = buildMetadata();
let suggestedCredentialReadLimiter: RateLimitRequestHandler = buildSuggestedCredentialRead();

// Wrappers capture the module-level variable by reference so __reset (below)
// can swap the instance and the exported handler picks up the new one.
// The `as unknown as RequestHandler` cast bridges the Express 4↔5 type split
// that pnpm may produce when resolving @types/express for different packages.
export const connectorQueryRateLimiter: RequestHandler = (req, res, next) =>
  (queryLimiter as unknown as RequestHandler)(req, res, next);

export const connectorTestRateLimiter: RequestHandler = (req, res, next) =>
  (testLimiter as unknown as RequestHandler)(req, res, next);

export const connectorMetadataRateLimiter: RequestHandler = (req, res, next) =>
  (metadataLimiter as unknown as RequestHandler)(req, res, next);

export const suggestedConnectorCredentialReadRateLimiter: RequestHandler = (req, res, next) =>
  (suggestedCredentialReadLimiter as unknown as RequestHandler)(req, res, next);

/** Test seam — re-create limiters so env overrides set before this call take effect. */
export function __resetConnectorRateLimiters(): void {
  queryLimiter = buildQuery();
  testLimiter = buildTest();
  metadataLimiter = buildMetadata();
  suggestedCredentialReadLimiter = buildSuggestedCredentialRead();
}
