/**
 * #734 — rate limiter for `PATCH` / `DELETE /api/discussions/threads/:id/messages/:messageId`.
 *
 * Each call writes a message row and an audit row and fans out to the thread
 * room, and an edit can dispatch mention notifications, so an unbounded loop
 * could flood a thread, the audit log and teammates' notifications. Layered on
 * top of the global limiter.
 *
 * It sits in front of `requireAuth` (CodeQL js/missing-rate-limiting wants the
 * limiter ahead of every auth check, as in `spec-kit-delete-rate-limit.ts`), so
 * the only identity is the client address: it always keys by IP. Default 120
 * changes per minute per IP, generous for users sharing one NAT address.
 * Tunable via `DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX` (read per request) and
 * `DISCUSSION_MESSAGE_CHANGE_LIMIT_WINDOW_MS` (read once, at module load).
 *
 * Exported as the `rateLimit()` result itself (not wrapped in a function) so
 * CodeQL recognises it as a rate limiter.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const ONE_MINUTE_MS = 60_000;
export const DISCUSSION_MESSAGE_CHANGE_DEFAULT_MAX = 120;

function maxPerWindow(): number {
  const n = Number.parseInt(process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DISCUSSION_MESSAGE_CHANGE_DEFAULT_MAX;
}

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const discussionMessageChangeRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("discussion-message-change"),
  windowMs: envMs("DISCUSSION_MESSAGE_CHANGE_LIMIT_WINDOW_MS", ONE_MINUTE_MS, { min: 1 }),
  limit: () => maxPerWindow(),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`,
  message: {
    success: false,
    error: {
      code: "DISCUSSION_MESSAGE_CHANGE_RATE_LIMITED",
      message: "Too many message edits or deletes — slow down",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
