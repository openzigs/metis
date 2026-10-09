/**
 * #977 — the per-IP limiter ahead of `GET /finops/usage-totals`.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { finopsUsagePreAuthRateLimiter } from "./finops-usage-rate-limit.js";

function app(userId: string) {
  const a = express();
  a.set("trust proxy", 1);
  a.use((req, _res, next) => {
    (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(finopsUsagePreAuthRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.FINOPS_USAGE_RATE_LIMIT_MAX;
});

describe("finopsUsagePreAuthRateLimiter (#977)", () => {
  it("keys by IP, not by user, at FINOPS_USAGE_RATE_LIMIT_MAX", async () => {
    process.env.FINOPS_USAGE_RATE_LIMIT_MAX = "1";
    const ip = { "X-Forwarded-For": "203.0.113.7" };
    expect((await request(app("fu-1")).get("/").set(ip)).status).toBe(200);
    const limited = await request(app("fu-2")).get("/").set(ip);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("FINOPS_USAGE_RATE_LIMITED");
    // Another IP has its own budget.
    const other = await request(app("fu-2")).get("/").set({ "X-Forwarded-For": "203.0.113.8" });
    expect(other.status).toBe(200);
  });

  it("defaults to a generous per-IP ceiling, and ignores a malformed override", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const ok = await request(app("fu-3")).get("/").set({ "X-Forwarded-For": "203.0.113.9" });
      expect(ok.headers["ratelimit-limit"]).toBe("3600");
      process.env.FINOPS_USAGE_RATE_LIMIT_MAX = "nope";
      const bad = await request(app("fu-3")).get("/").set({ "X-Forwarded-For": "203.0.113.10" });
      expect(bad.headers["ratelimit-limit"]).toBe("3600");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
