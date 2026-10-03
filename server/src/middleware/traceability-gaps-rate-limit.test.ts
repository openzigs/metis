/**
 * #814 — the test-gaps limiter: per-user keys, an IP fallback, and a cap read
 * per request.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { traceabilityGapsRateLimiter } from "./traceability-gaps-rate-limit.js";

function app(userId?: string) {
  const a = express();
  a.use((req, _res, next) => {
    if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(traceabilityGapsRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.TRACEABILITY_GAPS_RATE_LIMIT_MAX;
});

describe("traceabilityGapsRateLimiter", () => {
  it("caps each user separately at TRACEABILITY_GAPS_RATE_LIMIT_MAX", async () => {
    process.env.TRACEABILITY_GAPS_RATE_LIMIT_MAX = "2";
    const a = app("tg-user-1");
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(200);
    const limited = await request(a).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("TRACEABILITY_GAPS_RATE_LIMITED");
    expect((await request(app("tg-user-2")).get("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.TRACEABILITY_GAPS_RATE_LIMIT_MAX = "1";
    const a = app();
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(429);
  });

  it("falls back to the default cap on a malformed override", async () => {
    process.env.TRACEABILITY_GAPS_RATE_LIMIT_MAX = "not-a-number";
    const res = await request(app("tg-user-3")).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("300");
  });
});
