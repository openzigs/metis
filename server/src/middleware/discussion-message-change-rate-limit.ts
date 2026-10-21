/**
 * #734 — rate limiters for `PATCH` / `DELETE /api/discussions/threads/:id/messages/:messageId`.
 *
 * Each call writes a message row and an audit row and fans out to the thread
 * room, and an edit can dispatch mention notifications, so an unbounded loop
 * could flood a thread, the audit log and teammates' notifications.
 *
 * Both routes require a signed-in user, so THE BUDGET IS THE USER'S. This
 * mirrors `runs-rate-limit.ts` (#1007), not the IP-keyed Spec Kit limiters:
 *
 *  - {@link discussionMessageChangeUserRateLimiter} — AFTER `requireAuth`,
 *    keyed on `req.user.userId`. Default 120 per minute per user
 *    (`DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX`). Nobody but the user can spend it.
 *
 *  - {@link discussionMessageChangePreAuthRateLimiter} — in FRONT of
 *    `requireAuth`, because CodeQL `js/missing-rate-limiting` counts only a
 *    limiter that runs before the authorization step. A coarser guard, default
 *    600 per minute (`DISCUSSION_MESSAGE_CHANGE_PREAUTH_LIMIT_MAX`). Its key is
 *    never a value the caller chooses: a request carrying an access token THIS
 *    server signed is keyed on the user id inside it (`signedAccessTokenUserId`,
 *    a signature check, no database read); every other request is keyed on the
 *    TCP peer, never a header. Those are requests `requireAuth` refuses anyway,
 *    so a spent peer bucket answers `requireAuth`'s own 401, not 429 (#1117,
 *    `preauth-limit-handler.ts`).
 *
 * WHY NOT THE CLIENT ADDRESS. `req.ip` under `trust proxy = 1` is the last
 * entry of `X-Forwarded-For`, which the Next UI server passes through from the
 * client (#1105). A budget keyed on it can be dodged with a new value per
 * request, and, ahead of `requireAuth`, spent by anyone on a victim's behalf.
 *
 * Caps are read per request; the window once, at module load
 * (`DISCUSSION_MESSAGE_CHANGE_LIMIT_WINDOW_MS`, shared). Each limiter is
 * exported as the `rateLimit()` result itself so CodeQL recognises it.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import { preAuthLimitReachedHandler } from "./preauth-limit-handler.js";
import { envMs } from "../lib/config/env-ms.js";
import { signedAccessTokenUserId } from "../lib/auth/jwt.js";
import type { Request, RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";

const ONE_MINUTE_MS = 60_000;
export const DISCUSSION_MESSAGE_CHANGE_DEFAULT_MAX = 120;
export const DISCUSSION_MESSAGE_CHANGE_PREAUTH_DEFAULT_MAX = 600;

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The TCP peer: the UI server or the proxy in front of the API. Never a header. */
function peerKey(req: Request): string {
  const socket = req.socket;
  return `peer:${ipKeyGenerator(socket?.remoteAddress ?? "", socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

/** The access token a request presents, read where `requireAuth` reads it. */
function presentedAccessToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const cookie = (req as unknown as { cookies?: Record<string, unknown> }).cookies?.accessToken;
  return typeof cookie === "string" && cookie ? cookie : undefined;
}

/**
 * The pre-auth limiter's key. Always under `preauth:`, so it is never the key
 * the user limiter gives the same request (express-rate-limit would otherwise
 * log `ERR_ERL_DOUBLE_COUNT`). Exported for its test.
 */
export function discussionMessageChangePreAuthKey(req: Request): string {
  const token = presentedAccessToken(req);
  const userId = token ? signedAccessTokenUserId(token) : null;
  return `preauth:${userId ? `user:${userId}` : peerKey(req)}`;
}

/** The user limiter's key. Exported for its test. */
export function discussionMessageChangeUserKey(req: Request): string {
  // `requireAuth` runs first; the fallback is for a route wired wrongly and
  // still never reads a client-supplied header.
  return req.user?.userId ? `user:${req.user.userId}` : peerKey(req);
}

const WINDOW_MS = envMs("DISCUSSION_MESSAGE_CHANGE_LIMIT_WINDOW_MS", ONE_MINUTE_MS, { min: 1 });

const limited: ApiResponse = {
  success: false,
  error: {
    code: "DISCUSSION_MESSAGE_CHANGE_RATE_LIMITED",
    message: "Too many message edits or deletes — slow down",
  },
};

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const discussionMessageChangePreAuthRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("discussion-message-change-preauth"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv(
      "DISCUSSION_MESSAGE_CHANGE_PREAUTH_LIMIT_MAX",
      DISCUSSION_MESSAGE_CHANGE_PREAUTH_DEFAULT_MAX,
    ),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => discussionMessageChangePreAuthKey(req as unknown as Request),
  // #1117 — a spent user bucket is 429; a spent peer bucket is requireAuth's 401.
  handler: preAuthLimitReachedHandler(discussionMessageChangePreAuthKey, limited),
}) as unknown as RequestHandler;

export const discussionMessageChangeUserRateLimiter: RequestHandler = rateLimit({
  store: clusterRateLimitStore("discussion-message-change-user"),
  windowMs: WINDOW_MS,
  limit: () =>
    intFromEnv("DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX", DISCUSSION_MESSAGE_CHANGE_DEFAULT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => discussionMessageChangeUserKey(req as unknown as Request),
  message: limited,
}) as unknown as RequestHandler;
