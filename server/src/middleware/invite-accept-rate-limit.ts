/**
 * #941 — rate limiter for `POST /api/workspaces/invites/:token/accept`.
 *
 * The route now authenticates the caller and reads their account before it
 * decides, so it sits behind its own limiter (CodeQL js/missing-rate-limiting).
 * It runs ahead of `requireAuth`, so it is keyed per IP: accepting an invite is
 * rare, and a signed-out click that bounces to /login and back costs two.
 * Default 60 per 15 minutes, tunable via `INVITE_ACCEPT_RATE_LIMIT_MAX` and
 * `INVITE_ACCEPT_RATE_LIMIT_WINDOW_MS`. Backed by the cluster store so the cap
 * holds across replicas (#679).
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
export const INVITE_ACCEPT_DEFAULT_MAX = 60;

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Built at module scope — express-rate-limit@8 refuses creation inside a handler.
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const inviteAcceptRateLimiter = rateLimit({
  store: clusterRateLimitStore("invite-accept"),
  windowMs: positiveEnv("INVITE_ACCEPT_RATE_LIMIT_WINDOW_MS", FIFTEEN_MINUTES_MS),
  // Read per request, so an operator override (or a test) takes effect without a restart.
  limit: () => positiveEnv("INVITE_ACCEPT_RATE_LIMIT_MAX", INVITE_ACCEPT_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: { code: "RATE_LIMIT", message: "Too many invitation attempts. Try again later." },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
