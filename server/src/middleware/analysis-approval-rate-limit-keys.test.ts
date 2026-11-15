/**
 * #2171 — each per-user approval limiter counts under its OWN key, an
 * unauthenticated IPv6 caller is keyed by its /64, and the review limiter's
 * window and cap are read from its own env vars.
 *
 * The sibling suite (`analysis-approval-rate-limit.test.ts`) runs on the
 * default `memory` backend, which hands every limiter a private store, so two
 * limiters sharing one store prefix would still count apart there and no test
 * would notice. Here the backend is `shared`: one process-wide store, as the
 * `postgres` and `valkey` backends are cluster-wide, so a prefix collision puts
 * both limiters on one counter. The env is set before the module is imported
 * because the store is resolved on first request and the window at import.
 */
import { afterEach, describe, expect, it } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";

process.env.DISCUSSION_RATE_LIMIT_BACKEND = "shared";
process.env.ANALYSIS_APPROVAL_REVIEW_RATE_LIMIT_WINDOW_MS = "60000";

const limiters = await import("./analysis-approval-rate-limit.js");

const PER_USER: Array<[name: string, env: string, limiter: RequestHandler]> = [
  ["reopen", "ANALYSIS_APPROVAL_REOPEN_RATE_LIMIT_MAX", limiters.analysisApprovalReopenRateLimiter],
  ["edit", "ANALYSIS_APPROVAL_EDIT_RATE_LIMIT_MAX", limiters.analysisApprovalEditRateLimiter],
  ["review", "ANALYSIS_APPROVAL_REVIEW_RATE_LIMIT_MAX", limiters.analysisApprovalReviewRateLimiter],
  [
    "promote",
    "ANALYSIS_APPROVAL_PROMOTE_RATE_LIMIT_MAX",
    limiters.analysisApprovalPromoteRateLimiter,
  ],
];

function app(limiter: RequestHandler, userId: string) {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(limiter);
  a.all("/", (_req, res) => res.json({ ok: true }));
  return a;
}

/**
 * A value unique to this attempt. The store is process-wide and `retry: 2`
 * reruns a case against what the failed attempt already spent, so every user id
 * and every IPv6 /64 below carries one: a retry starts from an empty bucket.
 */
let attempt = 0;
const fresh = () => ++attempt;

afterEach(() => {
  for (const [, env] of PER_USER) delete process.env[env];
});

describe("approval limiters on one shared store (#2171)", () => {
  it.each(PER_USER.map(([name]) => name))(
    "a user who spent the %s limit can still use every other approval limiter",
    async (spent) => {
      for (const [, env] of PER_USER) process.env[env] = "1";
      const userId = `keys-user-${spent}-${fresh()}`;
      const [, , spentLimiter] = PER_USER.find(([name]) => name === spent)!;
      expect((await request(app(spentLimiter, userId)).post("/")).status).toBe(200);
      expect((await request(app(spentLimiter, userId)).post("/")).status).toBe(429);
      // Each other limiter allows one request for this user. Had it shared the
      // spent limiter's counter, that request would be its third and refused.
      for (const [name, , limiter] of PER_USER) {
        if (name === spent) continue;
        const res = await request(app(limiter, userId)).post("/");
        expect({ name, status: res.status }).toEqual({ name, status: 200 });
      }
    },
  );
});

describe("an unauthenticated IPv6 caller is keyed by its /64 (#2171)", () => {
  /** A request with no user, from `ip` over an IPv6 socket. */
  function ipv6App(limiter: RequestHandler, ip: string) {
    const a = express();
    a.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { value: ip });
      Object.defineProperty(req.socket, "remoteFamily", { value: "IPv6", configurable: true });
      next();
    });
    a.use(limiter);
    a.all("/", (_req, res) => res.json({ ok: true }));
    return a;
  }

  it.each(PER_USER.map(([name, env, limiter]) => [name, env, limiter] as const))(
    "%s: one /64 shares a bucket, the next /64 has its own",
    async (_name, env, limiter) => {
      process.env[env] = "1";
      // Two /64s under a /48 of this attempt's own (third group), so no case
      // and no retry shares a bucket with another.
      const n = fresh().toString(16);
      expect((await request(ipv6App(limiter, `2001:db8:${n}:1::1`)).post("/")).status).toBe(200);
      // Same /64, another address: the same caller rotating its interface id.
      expect((await request(ipv6App(limiter, `2001:db8:${n}:1::2`)).post("/")).status).toBe(429);
      // A different /64 in the same /48 is a different caller.
      expect((await request(ipv6App(limiter, `2001:db8:${n}:2::1`)).post("/")).status).toBe(200);
    },
  );
});

describe("ANALYSIS_APPROVAL_REVIEW_RATE_LIMIT_WINDOW_MS (#2171)", () => {
  it("sets the review limiter's window", async () => {
    const res = await request(app(limiters.analysisApprovalReviewRateLimiter, "window-user")).put(
      "/",
    );
    expect(res.status).toBe(200);
    // draft-6 headers: `<limit>;w=<window in seconds>`.
    expect(res.headers["ratelimit-policy"]).toMatch(/;w=60$/);
  });

  it.each(["abc", "0", "-5"])("falls back to the default cap for a max of %j", async (raw) => {
    process.env.ANALYSIS_APPROVAL_REVIEW_RATE_LIMIT_MAX = raw;
    const res = await request(app(limiters.analysisApprovalReviewRateLimiter, `bad-${raw}`)).put(
      "/",
    );
    expect(res.headers["ratelimit-limit"]).toBe(
      String(limiters.ANALYSIS_APPROVAL_REVIEW_DEFAULT_MAX),
    );
  });

  it("leaves the edit limiter on its own 15-minute default", async () => {
    const res = await request(app(limiters.analysisApprovalEditRateLimiter, "window-user")).patch(
      "/",
    );
    expect(res.headers["ratelimit-policy"]).toMatch(/;w=900$/);
  });
});
