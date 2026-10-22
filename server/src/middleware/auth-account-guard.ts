/**
 * #1385 — the per-account sign-in cap: at most `AUTH_ACCOUNT_RATE_LIMIT_MAX`
 * (default 10) FAILED sign-ins per username per `RATE_LIMIT_WINDOW_MS`
 * (15 minutes), from any number of addresses.
 *
 * The address limiter (`rate-limit.ts`) stops one client trying many accounts;
 * this stops many clients (a botnet, or everyone behind one NAT) trying one.
 *
 * WHY NOT express-rate-limit. Counting only failures there means
 * `skipSuccessfulRequests`, which un-counts a success through
 * `Store.decrement` — and the cluster-safe Postgres and Valkey stores are
 * append-only window counters with no decrement. So this guard reads the
 * failure count BEFORE authenticating (`RateLimitStore.count`, which records
 * nothing) and the login handler records a hit only AFTER a failed bind
 * ({@link AuthAccountGuard.recordFailure}). A user who signs in successfully is
 * never counted; someone who knows a username can still hold that account's
 * sign-in back for one window with `max` wrong passwords, as any account
 * lockout can.
 *
 * WHY ON THE ROUTE. It is mounted on `POST /login` itself (`routes/auth.ts`),
 * not matched against `req.path`: Express routes `/login/`, `/LOGIN` and
 * `/Login` to the same handler, and an exact path match skipped all three.
 */
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@metis/shared";
import { resolveRateLimitStore, type RateLimitStore } from "../lib/discussions/rate-limit-store.js";

export const AUTH_ACCOUNT_DEFAULT_MAX = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const KEY_PREFIX = "auth-account:";
/** A cap `hit` never reaches: the guard compares against the real cap itself. */
const NEVER_EXCEEDED = Number.MAX_SAFE_INTEGER;

/**
 * The store key for the account a login names, or null when it names no usable
 * account (the route's own validation answers that). NFKC-normalised, trimmed
 * and lower-cased, so `Alice `, `alice` and `Klice`-style compatibility
 * forms share one budget; hashed, so the store never holds a username.
 */
export function authAccountKey(username: unknown): string | null {
  if (typeof username !== "string") return null;
  const folded = username.normalize("NFKC").trim().toLowerCase();
  if (!folded || folded.length > 256) return null;
  return `${KEY_PREFIX}${createHash("sha256").update(folded).digest("hex")}`;
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Overrides for {@link createAuthAccountGuard}; every field is test-only. */
export interface AuthAccountGuardOptions {
  store?: RateLimitStore;
  max?: number;
  windowMs?: number;
  now?: () => number;
}

export interface AuthAccountGuard {
  /** Middleware for `POST /login`: 429 once the account's failures reach the cap. */
  check(req: Request, res: Response, next: NextFunction): void;
  /** Record one failed sign-in for `username`. Never throws. */
  recordFailure(username: unknown): Promise<void>;
}

const limited: ApiResponse = {
  success: false,
  error: {
    code: "RATE_LIMITED",
    message: "Too many failed sign-in attempts for this account — please try again later",
  },
};

export function createAuthAccountGuard(options: AuthAccountGuardOptions = {}): AuthAccountGuard {
  // Resolved on first use: the Postgres factory is registered after import.
  let store: RateLimitStore | undefined = options.store;
  const backing = () => (store ??= resolveRateLimitStore());
  const now = options.now ?? Date.now;
  const windowMs = () => options.windowMs ?? intFromEnv("RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS);
  const max = () =>
    options.max ?? intFromEnv("AUTH_ACCOUNT_RATE_LIMIT_MAX", AUTH_ACCOUNT_DEFAULT_MAX);

  return {
    check(req, res, next) {
      const key = authAccountKey((req.body as { username?: unknown } | undefined)?.username);
      if (!key) {
        next();
        return;
      }
      const s = backing();
      // A backend without `count` (a test double) degrades to counting every
      // attempt, which is stricter, never looser.
      const failures = s.count
        ? s.count(key, windowMs(), now())
        : s.hit(key, NEVER_EXCEEDED, windowMs(), now()).then((r) => r.recentCount - 1);
      failures.then(
        (n) => {
          if (n >= max()) res.status(429).json(limited);
          else next();
        },
        (err: unknown) => next(err),
      );
    },
    async recordFailure(username) {
      const key = authAccountKey(username);
      if (!key) return;
      try {
        await backing().hit(key, NEVER_EXCEEDED, windowMs(), now());
      } catch {
        // A store outage must not turn a wrong password into a 500; the
        // address limiter still applies.
      }
    },
  };
}

export const authAccountGuard: AuthAccountGuard = createAuthAccountGuard();
