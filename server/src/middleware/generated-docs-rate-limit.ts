/**
 * Router-level rate limiters for the generated-docs router (#632, CodeQL
 * `js/missing-rate-limiting` #202): `/api/projects/:projectId/docs/…`.
 *
 * Two limiters, mirroring conversation-rate-limit.ts:
 *
 * - {@link generatedDocsPreAuthRateLimiter} — per IP, mounted IN FRONT of
 *   `requireAuth`, so an anonymous flood is refused before any JWT is verified.
 * - {@link generatedDocsRateLimiter} — per authenticated user (IP fallback),
 *   mounted after `requireAuth` and IN FRONT of `refreshAuthenticatedUser`,
 *   whose DB read every request otherwise pays for.
 *
 * Both are generous: the docs pages poll `GET /docs` every 5 s while a document
 * generates (180 requests / 15 min), so the per-user default is 900 / 15 min and
 * the per-IP ceiling, shared by every user behind one NAT, is four times that.
 * The stricter per-route `/generate` limiter in generated-docs.ts still applies.
 *
 * Both are built at module scope and exported as the `rateLimit()` handler
 * itself (not wrapped): express-rate-limit@8 throws
 * ERR_ERL_CREATED_IN_REQUEST_HANDLER if `rateLimit()` runs inside a handler,
 * and static analysis must be able to see the limiter. Caps are read per
 * request, so `GENERATED_DOCS_RATE_LIMIT_MAX` and
 * `GENERATED_DOCS_PREAUTH_RATE_LIMIT_MAX` take effect without a restart; the
 * window (`GENERATED_DOCS_RATE_LIMIT_WINDOW_MS`) is fixed at construction.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler, Response } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
const TEST_DEFAULT_MAX = 10_000;

/** Per-user requests per window. */
export const GENERATED_DOCS_DEFAULT_MAX = 900;
/** Per-IP requests per window, ahead of authentication. */
export const GENERATED_DOCS_PREAUTH_DEFAULT_MAX = 3_600;

function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return process.env.NODE_ENV === "test" ? TEST_DEFAULT_MAX : fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ipKey(req: Request, res: Response): string {
  return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

const windowMs = envMs("GENERATED_DOCS_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const message = {
  success: false,
  error: {
    code: "GENERATED_DOCS_RATE_LIMITED",
    message: "Too many documentation requests — slow down",
  },
} satisfies ApiResponse;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const generatedDocsRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("generated-docs"),
  windowMs,
  limit: () => capFromEnv("GENERATED_DOCS_RATE_LIMIT_MAX", GENERATED_DOCS_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const userId = req.user?.userId;
    return userId ? `user:${userId}` : ipKey(req, res);
  },
  message,
}) as unknown as RequestHandler;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const generatedDocsPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("generated-docs-preauth"),
  windowMs,
  limit: () =>
    capFromEnv("GENERATED_DOCS_PREAUTH_RATE_LIMIT_MAX", GENERATED_DOCS_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message,
}) as unknown as RequestHandler;
