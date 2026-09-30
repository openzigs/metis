/**
 * #423 — the code-search limiter: per-user keys, an IP fallback, and a cap
 * read per request.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { codeSearchRateLimiter } from "./code-search-rate-limit.js";

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
