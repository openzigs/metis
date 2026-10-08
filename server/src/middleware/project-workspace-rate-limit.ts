/**
 * #731 — rate limiter for `PUT /api/projects/:id/workspace`, a rare,
 * irreversible write. Keyed per user (falling back to IP); default 30 per
 * 15 minutes, tunable via `PROJECT_WORKSPACE_LIMIT_MAX` and
 * `PROJECT_WORKSPACE_RATE_LIMIT_WINDOW_MS`. Backed by the cluster store so the
 * cap holds across replicas (#679).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Built at module scope — express-rate-limit@8 refuses creation inside a handler.
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const projectWorkspaceRateLimiter = rateLimit({
  store: clusterRateLimitStore("project-workspace"),
  windowMs: positiveEnv("PROJECT_WORKSPACE_RATE_LIMIT_WINDOW_MS", FIFTEEN_MINUTES_MS),
  max: process.env.NODE_ENV === "test" ? 10_000 : positiveEnv("PROJECT_WORKSPACE_LIMIT_MAX", 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    req.user?.userId ??
    ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32),
  message: {
    success: false,
    error: { code: "RATE_LIMIT", message: "Too many workspace changes. Try again later." },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
