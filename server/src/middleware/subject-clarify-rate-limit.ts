/**
 * #2270 — rate limiter for the clarification dialog of an Impact Analysis run
 * and of a portfolio check: `POST /api/impact-analyses/:id/clarify` and
 * `POST /api/portfolio-assessments/:id/clarify`. A start is a question call
 * and a grounding call per question; a submit a resolution call per
 * requirement answered. Capped per user like the governing re-check (#2281),
 * AFTER `requireAuth` and the permission check, keyed on `req.user.userId`.
 * Default 60 per 15 minutes (`SUBJECT_CLARIFY_LIMIT_MAX`): three rounds of a
 * dialog are six requests. The window is read once
 * (`SUBJECT_CLARIFY_LIMIT_WINDOW_MS`), the cap per request.
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const SUBJECT_CLARIFY_USER_DEFAULT_MAX = 60;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("SUBJECT_CLARIFY_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "CLARIFY_RATE_LIMITED",
    message: "Too many clarification requests — please try again later",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const subjectClarifyUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("subject-clarify-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("SUBJECT_CLARIFY_LIMIT_MAX", SUBJECT_CLARIFY_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
