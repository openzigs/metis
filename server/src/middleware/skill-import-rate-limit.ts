/**
 * #237 — per-IP ceiling for the repository skills import
 * (`POST /api/skills/import/repository`). One import lists up to
 * `REPO_MAX_LISTINGS` directories and reads every skill file through the
 * connector's API, so it is bounded before auth, like the conversation
 * routes' pre-auth limiter. 30 / 15 min by default
 * (`SKILL_REPO_IMPORT_RATE_LIMIT_MAX`, read per request).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

export const SKILL_REPO_IMPORT_DEFAULT_MAX = 30;

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const skillRepoImportRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("skill-repo-import"),
  windowMs: 15 * 60_000,
  limit: () => {
    const n = Number.parseInt(process.env.SKILL_REPO_IMPORT_RATE_LIMIT_MAX ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : SKILL_REPO_IMPORT_DEFAULT_MAX;
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: { code: "SKILL_IMPORT_RATE_LIMITED", message: "Too many repository imports" },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
