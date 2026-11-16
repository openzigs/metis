/**
 * #2595 — rate limiter for the PDF hand-off of an Impact Analysis run:
 * `GET /api/impact-analyses/:id/export?format=pdf`. Each PDF request launches a
 * Chromium instance, so it is capped per user, AFTER `requireAuth` and the
 * permission check, keyed on `req.user.userId` like the clarification dialog's
 * limiter. The Word export builds in-process and is not counted (`skip`).
 * Default 30 per 15 minutes (`HANDOFF_PDF_LIMIT_MAX`), read per request; the
 * window (`HANDOFF_PDF_LIMIT_WINDOW_MS`) is read once.
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const HANDOFF_PDF_USER_DEFAULT_MAX = 30;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("HANDOFF_PDF_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "HANDOFF_EXPORT_RATE_LIMITED",
    message: "Too many PDF hand-off exports — please try again later",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const handoffPdfUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("handoff-pdf-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("HANDOFF_PDF_LIMIT_MAX", HANDOFF_PDF_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.query.format !== "pdf",
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
