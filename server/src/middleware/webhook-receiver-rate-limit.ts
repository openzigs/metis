/**
 * #680 (epic #672) — IP-keyed rate limiter for the UNAUTHENTICATED webhook
 * receivers: the trigger receivers (`triggersWebhookRouter`: POST /api/webhooks/
 * github, /slack, and /api/triggers/:id/fire) and the issue-sync receivers
 * (`syncWebhookRouter`: POST /github/issues, /jira/issues).
 *
 * These endpoints are unauthenticated (verified by signature) and some run a
 * per-request trigger-table scan; without a limiter an attacker can flood them at
 * line rate to amplify DB load (OWASP A04/A05). Mirrors the #438 limiter and is
 * backed by the cluster-safe store (#679) so the cap holds across replicas.
 *
 * Defaults: 60 requests / minute / IP. Tunable via `WEBHOOK_RECEIVER_LIMIT_MAX`
 * and `WEBHOOK_RECEIVER_LIMIT_WINDOW_MS`.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";

const ONE_MINUTE_MS = 60_000;

function windowMs(): number {
  const raw = Number(process.env.WEBHOOK_RECEIVER_LIMIT_WINDOW_MS ?? ONE_MINUTE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ONE_MINUTE_MS;
}

function maxPerWindow(): number {
  const raw = Number(process.env.WEBHOOK_RECEIVER_LIMIT_MAX ?? 60);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

// Duck-typed key helper — avoids the cross-version Express 4↔5 type conflict.
function keyByIp(
  req: { ip?: string },
  res: { req?: { socket?: { remoteFamily?: string } } },
): string {
  return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

function build(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("webhook-receiver"),
    windowMs: windowMs(),
    max: maxPerWindow(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => keyByIp(req, res),
    message: { ok: false, reason: "RATE_LIMITED" },
  });
}

// Initialised at module scope — express-rate-limit@8 throws
// ERR_ERL_CREATED_IN_REQUEST_HANDLER if rateLimit() runs inside a request handler.
let limiter: RateLimitRequestHandler = build();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const webhookReceiverRateLimiter: RequestHandler = (req, res, next) =>
  (limiter as unknown as RequestHandler)(req, res, next);

/** Test-only: re-create the limiter so a new env override can take effect. */
export function __resetWebhookReceiverRateLimiter(): void {
  limiter = build();
}
