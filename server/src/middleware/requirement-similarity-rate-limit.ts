/**
 * Issue #1837 — a per-IP ceiling ahead of `requirementSimilarityRouter()`'s
 * router-level `requireAuth` and `requireProjectAccess()`.
 *
 * Each similarity call embeds text and reads a project's requirements (and, with
 * `REQ_SIMILARITY_VERIFIER` on, makes a model call), so it is limited before
 * authentication like the other project routers (CodeQL `js/missing-rate-limiting`).
 * The UI debounces its draft lookups at 500 ms; the cap bounds abuse, not that.
 * Same shape as `importsPreAuthRateLimiter`.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
/** Per-IP requests per window, ahead of authentication. */
export const REQUIREMENT_SIMILARITY_PREAUTH_DEFAULT_MAX = 3_600;
const TEST_DEFAULT_MAX = 10_000;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return process.env.NODE_ENV === "test" ? TEST_DEFAULT_MAX : fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const requirementSimilarityPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("requirement-similarity-preauth"),
  windowMs: envMs("REQUIREMENT_SIMILARITY_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () =>
    intFromEnv("REQUIREMENT_SIMILARITY_RATE_LIMIT_MAX", REQUIREMENT_SIMILARITY_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "REQUIREMENT_SIMILARITY_RATE_LIMITED",
      message: "Too many similar-requirement requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
