/**
 * #2350 (PR #2428 review) — the per-user limiter for
 * `GET /api/ai/chat-subjects/:kind/:id`, the read behind an "Ask about this"
 * link. Its own budget, so opening chat from an item never spends the
 * conversation budget (transcript reads, resume, fork, compaction) and a busy
 * conversation never blocks the link.
 *
 * One read per link opened: 300 / 15 min per user by default,
 * `AI_CHAT_SUBJECT_RATE_LIMIT_MAX` overrides it, read per request. Mounted after
 * `requireAuth`; the per-IP `conversationPreAuthRateLimiter` still runs ahead
 * of it.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { envMs } from "../lib/config/env-ms.js";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const FIFTEEN_MIN_MS = 15 * 60_000;
export const CHAT_SUBJECT_DEFAULT_MAX = 300;
const TEST_DEFAULT_MAX = 10_000;

function capFromEnv(): number {
  const raw = process.env.AI_CHAT_SUBJECT_RATE_LIMIT_MAX;
  if (raw == null || raw === "") {
    return process.env.NODE_ENV === "test" ? TEST_DEFAULT_MAX : CHAT_SUBJECT_DEFAULT_MAX;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHAT_SUBJECT_DEFAULT_MAX;
}

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const chatSubjectRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("ai-chat-subject"),
  windowMs: envMs("AI_CHAT_SUBJECT_RATE_LIMIT_WINDOW_MS", FIFTEEN_MIN_MS, { min: 1 }),
  limit: () => capFromEnv(),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const userId = req.user?.userId;
    if (userId) return `user:${userId}`;
    return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
  },
  message: {
    success: false,
    error: {
      code: "CHAT_SUBJECT_RATE_LIMITED",
      message: "Too many requests to open chat from an item — wait a moment and try again",
    },
  } satisfies ApiResponse,
}) as unknown as RequestHandler;
