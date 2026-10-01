/**
 * #632 — router-level limiters for the generated-docs router (CodeQL
 * `js/missing-rate-limiting` #202): a per-IP ceiling in front of `requireAuth`
 * and a per-user budget in front of the DB-reading `refreshAuthenticatedUser`.
 */
import { afterEach, describe, expect, it } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";
import {
  GENERATED_DOCS_DEFAULT_MAX,
  GENERATED_DOCS_PREAUTH_DEFAULT_MAX,
  generatedDocsPreAuthRateLimiter,
  generatedDocsRateLimiter,
} from "./generated-docs-rate-limit.js";

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
  delete process.env.GENERATED_DOCS_RATE_LIMIT_MAX;
  delete process.env.GENERATED_DOCS_PREAUTH_RATE_LIMIT_MAX;
});

describe("generatedDocsRateLimiter (per user)", () => {
  it("caps each user separately and answers 429 with the standard envelope", async () => {
    process.env.GENERATED_DOCS_RATE_LIMIT_MAX = "2";
    const a = app(generatedDocsRateLimiter, "gd-cap-1");
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(200);
    const limited = await request(a).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      error: {
        code: "GENERATED_DOCS_RATE_LIMITED",
        message: "Too many documentation requests — slow down",
      },
    });
    // Another user keeps their own budget.
    expect((await request(app(generatedDocsRateLimiter, "gd-cap-2")).get("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.GENERATED_DOCS_RATE_LIMIT_MAX = "1";
    const a = app(generatedDocsRateLimiter);
    const first = "198.51.100.10";
    expect((await request(a).get("/").set("X-Forwarded-For", first)).status).toBe(200);
    expect((await request(a).get("/").set("X-Forwarded-For", first)).status).toBe(429);
    // A second source IP keeps its own budget — the fallback key is the IP, not a constant.
    expect((await request(a).get("/").set("X-Forwarded-For", "198.51.100.11")).status).toBe(200);
  });

  it("ignores an invalid cap and falls back to the production default", async () => {
    process.env.GENERATED_DOCS_RATE_LIMIT_MAX = "nope";
    const res = await request(app(generatedDocsRateLimiter, "gd-invalid")).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe(String(GENERATED_DOCS_DEFAULT_MAX));
  });

  it("uses the generous test default when no cap is set", async () => {
    const res = await request(app(generatedDocsRateLimiter, "gd-default")).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("10000");
  });

  it("production default leaves room for the docs pages' 5 s polling (180 / 15 min)", () => {
    expect(GENERATED_DOCS_DEFAULT_MAX).toBeGreaterThanOrEqual(4 * 180);
  });
});

describe("generatedDocsPreAuthRateLimiter (per IP)", () => {
  it("caps by IP regardless of user and answers 429 with the standard envelope", async () => {
    process.env.GENERATED_DOCS_PREAUTH_RATE_LIMIT_MAX = "1";
    // Distinct users from one IP share the pre-auth budget.
    expect((await request(app(generatedDocsPreAuthRateLimiter, "gd-pre-1")).get("/")).status).toBe(
      200,
    );
    const limited = await request(app(generatedDocsPreAuthRateLimiter, "gd-pre-2")).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body.success).toBe(false);
    expect(limited.body.error.code).toBe("GENERATED_DOCS_RATE_LIMITED");
  });

  it("ignores an invalid cap and falls back to the production default", async () => {
    process.env.GENERATED_DOCS_PREAUTH_RATE_LIMIT_MAX = "-3";
    const res = await request(app(generatedDocsPreAuthRateLimiter)).get("/");
    expect(res.headers["ratelimit-limit"]).toBe(String(GENERATED_DOCS_PREAUTH_DEFAULT_MAX));
  });

  it("uses the generous test default when no cap is set", async () => {
    const res = await request(app(generatedDocsPreAuthRateLimiter)).get("/");
    expect(res.headers["ratelimit-limit"]).toBe("10000");
  });

  it("is looser than the per-user budget, since every user behind one NAT shares it", () => {
    expect(GENERATED_DOCS_PREAUTH_DEFAULT_MAX).toBeGreaterThan(GENERATED_DOCS_DEFAULT_MAX);
  });
});
