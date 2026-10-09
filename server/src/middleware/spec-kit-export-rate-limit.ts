/**
 * #953 — rate limiters for `POST /api/projects/:id/spec-kit/commands/speckit.taskstoissues`.
 *
 * A live export reads a vault secret and files real GitHub issues, so it is
 * bounded twice, on the shared commands route (both limiters `skip` every
 * other command, which keep their existing limits):
 *
 *  - {@link specKitExportPreAuthRateLimiter} sits in front of `requireAuth`
 *    (CodeQL js/missing-rate-limiting wants the limiter ahead of every auth
 *    check, as in `spec-kit-delete-rate-limit.ts`). `req.user` is not set yet,
 *    so it keys by client address. Generous (default 600 per 15 minutes),
 *    because one address may front many users; it bounds abuse, dry runs
 *    included. `SPECKIT_EXPORT_PREAUTH_LIMIT_MAX` is read per request.
 *  - {@link specKitExportLiveRateLimiter} sits after `requireAuth` and keys by
 *    user: default 10 live exports per 15 minutes
 *    (`SPECKIT_EXPORT_LIVE_LIMIT_MAX`). A dry run (`dryRun: true`) is not
 *    counted here — it writes nothing.
 *
 * Window lengths are read once, at module load
 * (`SPECKIT_EXPORT_*_LIMIT_WINDOW_MS`). Both are exported as the `rateLimit()`
 * result itself (not wrapped in a function) so CodeQL recognises them.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { normalizeSpecKitCommand, type ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const SPECKIT_EXPORT_PREAUTH_DEFAULT_MAX = 600;
export const SPECKIT_EXPORT_LIVE_DEFAULT_MAX = 10;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True for `speckit.taskstoissues` (any spelling the route accepts). */
export function isTasksExportRequest(req: Request): boolean {
  const cmd = (req.params as { cmd?: unknown }).cmd;
  return (
    typeof cmd === "string" && normalizeSpecKitCommand(cmd)?.canonical === "speckit.taskstoissues"
  );
}

/** A live export: the runner treats anything but `dryRun: true` as live. */
function isLiveExport(req: Request): boolean {
  const body = (req.body ?? {}) as { dryRun?: unknown };
  return isTasksExportRequest(req) && body.dryRun !== true;
}

function ipKey(req: Request, remoteFamily: string | undefined): string {
  return `ip:${ipKeyGenerator(req.ip ?? "", remoteFamily === "IPv6" ? 64 : 32)}`;
}

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const specKitExportPreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-export-preauth"),
  windowMs: envMs("SPECKIT_EXPORT_PREAUTH_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("SPECKIT_EXPORT_PREAUTH_LIMIT_MAX", SPECKIT_EXPORT_PREAUTH_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !isTasksExportRequest(req),
  keyGenerator: (req, res) => ipKey(req, res.req?.socket?.remoteFamily),
  message: {
    success: false,
    error: {
      code: "SPECKIT_EXPORT_RATE_LIMITED",
      message: "Too many issue export requests — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;

export const specKitExportLiveRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("speckit-export-live"),
  windowMs: envMs("SPECKIT_EXPORT_LIVE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => intFromEnv("SPECKIT_EXPORT_LIVE_LIMIT_MAX", SPECKIT_EXPORT_LIVE_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !isLiveExport(req),
  keyGenerator: (req, res) =>
    req.user?.userId ? `user:${req.user.userId}` : ipKey(req, res.req?.socket?.remoteFamily),
  message: {
    success: false,
    error: {
      code: "SPECKIT_EXPORT_RATE_LIMITED",
      message: "Too many issue exports — wait a few minutes before publishing again",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
