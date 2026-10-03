/**
 * #795 — router-level limiters for the test-coverage router (CodeQL
 * `js/missing-rate-limiting`): a per-IP ceiling in front of `requireAuth`
 * and a per-user budget in front of the DB-reading `requireProjectAccess()`.
 */
import { afterEach, describe, expect, it } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";
import {
  TEST_COVERAGE_DEFAULT_MAX,
  TEST_COVERAGE_PREAUTH_DEFAULT_MAX,
  testCoveragePreAuthRateLimiter,
  testCoverageRateLimiter,
} from "./test-coverage-rate-limit.js";

function app(limiter: RequestHandler, userId?: string) {
  const a = express();
  // Lets a test pick its source IP via X-Forwarded-For.
  a.set("trust proxy", true);
  a.use((req, _res, next) => {
    if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(limiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.TEST_COVERAGE_RATE_LIMIT_MAX;
  delete process.env.TEST_COVERAGE_PREAUTH_RATE_LIMIT_MAX;
});

describe("testCoverageRateLimiter (per user)", () => {
  it("caps each user separately and answers 429 with the standard envelope", async () => {
    process.env.TEST_COVERAGE_RATE_LIMIT_MAX = "2";
    const a = app(testCoverageRateLimiter, "tc-cap-1");
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(200);
    const limited = await request(a).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      error: {
        code: "TEST_COVERAGE_RATE_LIMITED",
        message: "Too many test-coverage requests — slow down",
      },
    });
    // Another user keeps their own budget.
    expect((await request(app(testCoverageRateLimiter, "tc-cap-2")).get("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.TEST_COVERAGE_RATE_LIMIT_MAX = "1";
    const a = app(testCoverageRateLimiter);
    const first = "198.51.100.10";
    expect((await request(a).get("/").set("X-Forwarded-For", first)).status).toBe(200);
    expect((await request(a).get("/").set("X-Forwarded-For", first)).status).toBe(429);
    // A second source IP keeps its own budget — the fallback key is the IP, not a constant.
    expect((await request(a).get("/").set("X-Forwarded-For", "198.51.100.11")).status).toBe(200);
  });

  it("ignores an invalid cap and falls back to the production default", async () => {
    process.env.TEST_COVERAGE_RATE_LIMIT_MAX = "nope";
    const res = await request(app(testCoverageRateLimiter, "tc-invalid")).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe(String(TEST_COVERAGE_DEFAULT_MAX));
  });

  it("uses the generous test default when no cap is set", async () => {
    const res = await request(app(testCoverageRateLimiter, "tc-default")).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("10000");
  });

  it("production default leaves room for the test-coverage page's 4 s polling (225 / 15 min)", () => {
    expect(TEST_COVERAGE_DEFAULT_MAX).toBeGreaterThanOrEqual(4 * 225);
  });
});

describe("testCoveragePreAuthRateLimiter (per IP)", () => {
  it("caps by IP regardless of user and answers 429 with the standard envelope", async () => {
    process.env.TEST_COVERAGE_PREAUTH_RATE_LIMIT_MAX = "1";
    // Distinct users from one IP share the pre-auth budget.
    expect((await request(app(testCoveragePreAuthRateLimiter, "tc-pre-1")).get("/")).status).toBe(
      200,
    );
    const limited = await request(app(testCoveragePreAuthRateLimiter, "tc-pre-2")).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body.success).toBe(false);
    expect(limited.body.error.code).toBe("TEST_COVERAGE_RATE_LIMITED");
  });

  it("ignores an invalid cap and falls back to the production default", async () => {
    process.env.TEST_COVERAGE_PREAUTH_RATE_LIMIT_MAX = "-3";
    const res = await request(app(testCoveragePreAuthRateLimiter)).get("/");
    expect(res.headers["ratelimit-limit"]).toBe(String(TEST_COVERAGE_PREAUTH_DEFAULT_MAX));
  });

  it("uses the generous test default when no cap is set", async () => {
    const res = await request(app(testCoveragePreAuthRateLimiter)).get("/");
    expect(res.headers["ratelimit-limit"]).toBe("10000");
  });

  it("is looser than the per-user budget, since every user behind one NAT shares it", () => {
    expect(TEST_COVERAGE_PREAUTH_DEFAULT_MAX).toBeGreaterThan(TEST_COVERAGE_DEFAULT_MAX);
  });
});
