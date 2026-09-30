/**
 * #423 — the code-search limiter: per-user keys, an IP fallback, and a cap
 * read per request.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  CODE_SEARCH_PREAUTH_DEFAULT_MAX,
  codeSearchPreAuthRateLimiter,
  codeSearchRateLimiter,
} from "./code-search-rate-limit.js";

function app(userId?: string) {
  const a = express();
  a.use((req, _res, next) => {
    if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(codeSearchRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.CODE_SEARCH_RATE_LIMIT_MAX;
});

describe("codeSearchRateLimiter", () => {
  it("caps each user separately at CODE_SEARCH_RATE_LIMIT_MAX", async () => {
    process.env.CODE_SEARCH_RATE_LIMIT_MAX = "2";
    const a = app("cs-user-1");
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(200);
    const limited = await request(a).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("CODE_SEARCH_RATE_LIMITED");
    expect((await request(app("cs-user-2")).get("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.CODE_SEARCH_RATE_LIMIT_MAX = "1";
    const a = app();
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(429);
  });

  it("falls back to the default cap on a malformed override", async () => {
    process.env.CODE_SEARCH_RATE_LIMIT_MAX = "not-a-number";
    expect((await request(app("cs-user-3")).get("/")).status).toBe(200);
  });
});

describe("codeSearchPreAuthRateLimiter", () => {
  function ipApp(userId?: string) {
    const a = express();
    a.set("trust proxy", 1);
    a.use((req, _res, next) => {
      if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
      next();
    });
    a.use(codeSearchPreAuthRateLimiter);
    a.get("/", (_req, res) => res.json({ ok: true }));
    return a;
  }

  afterEach(() => {
    delete process.env.CODE_SEARCH_PREAUTH_RATE_LIMIT_MAX;
  });

  it("caps per IP at CODE_SEARCH_PREAUTH_RATE_LIMIT_MAX, whoever the user is", async () => {
    process.env.CODE_SEARCH_PREAUTH_RATE_LIMIT_MAX = "1";
    const ip = "203.0.113.41";
    expect((await request(ipApp("pre-1")).get("/").set("X-Forwarded-For", ip)).status).toBe(200);
    const limited = await request(ipApp("pre-2")).get("/").set("X-Forwarded-For", ip);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("CODE_SEARCH_RATE_LIMITED");
    // Another IP has its own budget.
    const other = await request(ipApp()).get("/").set("X-Forwarded-For", "203.0.113.42");
    expect(other.status).toBe(200);
  });

  it("falls back to the default ceiling on a malformed override", async () => {
    process.env.CODE_SEARCH_PREAUTH_RATE_LIMIT_MAX = "0";
    const res = await request(ipApp()).get("/").set("X-Forwarded-For", "203.0.113.43");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"] ?? res.headers["ratelimit-policy"]).toBeDefined();
  });

  it("exports a default ceiling above the per-user budget", () => {
    expect(CODE_SEARCH_PREAUTH_DEFAULT_MAX).toBeGreaterThan(300);
  });
});
