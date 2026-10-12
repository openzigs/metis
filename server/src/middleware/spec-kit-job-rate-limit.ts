/**
 * #1059 — rate limiters for the Spec Kit job endpoints
 * (`/api/projects/:id/spec-kit/jobs…` and `POST …/commands/:cmd/jobs`).
 *
 * READS and WRITES have separate budgets, so a page (or twenty) polling a job
 * can never make `cancel` or a new start answer 429:
 *
 *  - {@link specKitJobReadRateLimiter} — `GET /jobs` and `GET /jobs/:jobId`.
 *    Default 6000 per 15 minutes: one tab polling every 3 seconds makes 300.
 *    `SPECKIT_JOB_LIMIT_MAX`.
 *  - {@link specKitJobWriteRateLimiter} — start and cancel. Default 600 per 15
 *    minutes. `SPECKIT_JOB_WRITE_LIMIT_MAX`.
 *  - {@link specKitJobUserWriteRateLimiter} — start and cancel again, AFTER
 *    `requireAuth`, per authenticated user. Default 120 per 15 minutes.
 *    `SPECKIT_JOB_USER_WRITE_LIMIT_MAX`.
 *
 * WHAT THE KEY IS. The first two sit in front of `requireAuth` (CodeQL
 * js/missing-rate-limiting wants a limiter ahead of every auth check, as in
 * `spec-kit-delete-rate-limit.ts`), where `req.user` is not set yet, so they
 * key by client address: `req.ip`, which under the default `trust proxy = 1`
 * (`app.ts`) is the LAST entry of `X-Forwarded-For`.
 *
 * Through the UI that entry is the browser's address, not the UI server's:
 * Next sets `x-forwarded-for` to the socket's remote address when the header
 * is absent (`next/dist/server/base-server.js`), and the UI's API proxy
 * (`ui/src/app/api/[...path]/route.ts`) forwards request headers as they are.
 * So users behind the Next proxy do NOT share one bucket — unless a proxy in
 * front of the UI appends its own hop, in which case the last entry is that
 * proxy for everyone and `TRUST_PROXY` must count the extra hop. Users behind
 * one NAT address always share the address buckets; that is why the write
 * budget that matters is the per-user one, which no neighbour can spend.
 *
 * Caps are read per request; window lengths once, at module load
 * (`SPECKIT_JOB_LIMIT_WINDOW_MS`, one window for all three). Each limiter is
 * exported as the `rateLimit()` result itself (not wrapped in a function) so
 * CodeQL recognises it.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const SPECKIT_JOB_DEFAULT_MAX = 6000;
export const SPECKIT_JOB_WRITE_DEFAULT_MAX = 600;
export const SPECKIT_JOB_USER_WRITE_DEFAULT_MAX = 120;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ipKey(req: Request, remoteFamily: string | undefined): string {
  return `ip:${ipKeyGenerator(req.ip ?? "", remoteFamily === "IPv6" ? 64 : 32)}`;
}

const WINDOW_MS = envMs("SPECKIT_JOB_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 });

const limited = (message: string): ApiResponse => ({
  success: false,
  error: { code: "SPECKIT_JOB_RATE_LIMITED", message },
});

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const specKitJobReadRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-job"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("SPECKIT_JOB_LIMIT_MAX", SPECKIT_JOB_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKey(req, res.req?.socket?.remoteFamily),
  message: limited("Too many Spec Kit job requests — slow down"),
}) as unknown as RequestHandler;

export const specKitJobWriteRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-job-write"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("SPECKIT_JOB_WRITE_LIMIT_MAX", SPECKIT_JOB_WRITE_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKey(req, res.req?.socket?.remoteFamily),
  message: limited("Too many Spec Kit commands started or cancelled — slow down"),
}) as unknown as RequestHandler;

export const specKitJobUserWriteRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-job-write-user"),
  windowMs: WINDOW_MS,
  limit: () => intFromEnv("SPECKIT_JOB_USER_WRITE_LIMIT_MAX", SPECKIT_JOB_USER_WRITE_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    req.user?.userId ? `user:${req.user.userId}` : ipKey(req, res.req?.socket?.remoteFamily),
  message: limited("You have started or cancelled too many Spec Kit commands — wait a few minutes"),
}) as unknown as RequestHandler;
