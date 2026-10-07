/**
 * PR #850 review — the per-IP ceiling ahead of `publishingRouter()`'s auth:
 * keyed by IP even when a user is present, a cap read per request, a default.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  PUBLISHING_PREAUTH_DEFAULT_MAX,
  publishingPreAuthRateLimiter,
} from "./publishing-rate-limit.js";

function app(userId: string) {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(publishingPreAuthRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.PUBLISHING_PREAUTH_RATE_LIMIT_MAX;
});

describe("publishingPreAuthRateLimiter", () => {
  it("keys by IP even when a user is present, at PUBLISHING_PREAUTH_RATE_LIMIT_MAX", async () => {
    process.env.PUBLISHING_PREAUTH_RATE_LIMIT_MAX = "1";
    expect((await request(app("pub-user-1")).get("/")).status).toBe(200);
    // A different user from the same IP shares the budget.
    const res = await request(app("pub-user-2")).get("/");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("PUBLISHING_RATE_LIMITED");
  });

  it("defaults to a generous per-IP ceiling outside tests", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(app("pub-user-3")).get("/");
      expect(PUBLISHING_PREAUTH_DEFAULT_MAX).toBe(3_600);
      expect(res.headers["ratelimit-limit"]).toBe("3600");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("falls back to the default cap on a malformed override", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.PUBLISHING_PREAUTH_RATE_LIMIT_MAX = "not-a-number";
    try {
      const res = await request(app("pub-user-4")).get("/");
      expect(res.headers["ratelimit-limit"]).toBe("3600");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
