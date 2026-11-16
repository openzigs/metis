/**
 * #2595 — rate limiter for the Word and PDF hand-off of an Impact Analysis run:
 * `GET /api/impact-analyses/:id/export?format=docx|pdf`. A PDF launches a
 * Chromium instance, and so does a Word export whose text holds a Mermaid
 * diagram (`exportToDocx` renders it through `renderMermaidDiagrams`), so both
 * formats are counted. Capped per user, AFTER `requireAuth` and the permission
 * check, keyed on `req.user.userId` like the clarification dialog's limiter.
 * Default 30 per 15 minutes (`HANDOFF_EXPORT_LIMIT_MAX`), read per request; the
 * window (`HANDOFF_EXPORT_LIMIT_WINDOW_MS`) is read once.
 */
import rateLimit from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { runsUserKey } from "./runs-rate-limit.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const HANDOFF_EXPORT_USER_DEFAULT_MAX = 30;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MS = envMs("HANDOFF_EXPORT_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "HANDOFF_EXPORT_RATE_LIMITED",
    message: "Too many hand-off exports — please try again later",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const handoffExportUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("handoff-export-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("HANDOFF_EXPORT_LIMIT_MAX", HANDOFF_EXPORT_USER_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => runsUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
