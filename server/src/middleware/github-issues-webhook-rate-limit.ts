/**
 * Issue #438 — rate limiter for `POST /api/webhooks/github/issues`.
 *
 * The HMAC failure path returns 401 unthrottled, which means a leaked
 * webhook URL or a deliberate attacker can send arbitrary unsigned
 * payloads at line rate to provoke logging + DB lookups. We cap the
 * number of requests per source IP per window so a sustained burst
 * trips a 429 instead of grinding the dedup table or the spec-kit
 * sync helper.
 *
 * Defaults: 60 requests per minute per IP. Tunable via
 * `GITHUB_ISSUES_WEBHOOK_LIMIT_MAX` and
 * `GITHUB_ISSUES_WEBHOOK_LIMIT_WINDOW_MS`.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";
import type { RequestHandler } from "express";

const ONE_MINUTE_MS = 60_000;

function windowMs(): number {
  const raw = Number(process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_WINDOW_MS ?? ONE_MINUTE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ONE_MINUTE_MS;
}

function maxPerWindow(): number {
  const raw = Number(process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_MAX ?? 60);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

// Duck-typed helper — avoids cross-version Express 4↔5 type conflict.
function keyByDeliveryOrIp(
  req: { ip?: string },
  res: { req?: { socket?: { remoteFamily?: string } } },
): string {
  // Prefer the GitHub source-IP via X-Forwarded-For (we run behind a TLS
  // terminator). Fall back to the direct socket IP normalised by the
  // upstream `ipKeyGenerator` which handles IPv6 prefix collapsing.
  return `ip:${ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32)}`;
}

function build(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("github-issues-webhook"),
    windowMs: windowMs(),
    max: maxPerWindow(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => keyByDeliveryOrIp(req, res),
    message: { ok: false, reason: "RATE_LIMITED" },
  });
}

// Initialised at module scope — express-rate-limit@8 throws ERR_ERL_CREATED_IN_REQUEST_HANDLER
// if rateLimit() is called inside a request handler.
let limiter: RateLimitRequestHandler = build();

// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const githubIssuesWebhookRateLimiter: RequestHandler = (req, res, next) =>
  (limiter as unknown as RequestHandler)(req, res, next);

/** Test-only: re-create limiter so a new env override can take effect. */
export function __resetGithubIssuesWebhookRateLimiter(): void {
  limiter = build();
}
