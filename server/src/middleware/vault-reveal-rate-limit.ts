/**
 * #324 — rate limiter for `GET /api/vault/:id/reveal`, the one route that hands
 * a vault secret's plaintext to a client.
 *
 * Mounted BEFORE `requireAuth`, so it is keyed by client IP and also bounds
 * unauthenticated floods against JWT verification — the shape CodeQL's
 * `js/missing-rate-limiting` asks for. Layered on top of the global limiter.
 * Default 30 requests/min/IP, tunable via `VAULT_REVEAL_LIMIT_MAX` and
 * `VAULT_REVEAL_RATE_LIMIT_WINDOW_MS`.
 */
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { RequestHandler } from "express";
import type { ApiResponse } from "@metis/shared";
import { clusterRateLimitStore } from "./cluster-rate-limit-store.js";

const ONE_MINUTE_MS = 60_000;

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function build(): RateLimitRequestHandler {
  return rateLimit({
    store: clusterRateLimitStore("vault-reveal"),
    windowMs: positiveEnv("VAULT_REVEAL_RATE_LIMIT_WINDOW_MS", ONE_MINUTE_MS),
    max: positiveEnv("VAULT_REVEAL_LIMIT_MAX", 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: "VAULT_REVEAL_RATE_LIMITED", message: "Too many reveal requests" },
    } satisfies ApiResponse,
  });
}

// Built at module scope — express-rate-limit@8 refuses creation inside a handler.
let limiter: RateLimitRequestHandler = build();

// The wrapper reads the module variable so the test seam below can swap it.
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
export const vaultRevealRateLimiter: RequestHandler = (req, res, next) =>
  (limiter as unknown as RequestHandler)(req, res, next);

/** Test seam — rebuild so env overrides set before this call take effect. */
export function __resetVaultRevealRateLimiter(): void {
  limiter = build();
}
