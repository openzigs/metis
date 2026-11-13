/**
 * Issue #2347 — a per-IP ceiling ahead of the `requireAuth` and
 * `requireProjectAccess()` on `GET /projects/:projectId/requirements`.
 *
 * Each call reads a page of the project's requirements with their change
 * requests and reviews, so it is limited before authentication like the other
 * project routers (CodeQL `js/missing-rate-limiting`). The UI debounces its
 * search at 300 ms; the cap bounds abuse, not that. Same shape as
 * `requirementSimilarityPreAuthRateLimiter`.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
/** Per-IP requests per window, ahead of authentication. */
export const PROJECT_REQUIREMENTS_PREAUTH_DEFAULT_MAX = 3_600;
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
export const projectRequirementsPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("project-requirements-preauth"),
  windowMs: envMs("PROJECT_REQUIREMENTS_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () =>
    intFromEnv("PROJECT_REQUIREMENTS_RATE_LIMIT_MAX", PROJECT_REQUIREMENTS_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "PROJECT_REQUIREMENTS_RATE_LIMITED",
      message: "Too many requirement list requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
