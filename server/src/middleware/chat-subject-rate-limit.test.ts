/**
 * #2350 (PR #2428 review) — the "Ask about this" read's own limiter: per-user
 * keys, an IP fallback, and a cap read per request.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { chatSubjectRateLimiter } from "./chat-subject-rate-limit.js";

function app(userId?: string) {
  const a = express();
  a.use((req, _res, next) => {
    if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(chatSubjectRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.AI_CHAT_SUBJECT_RATE_LIMIT_MAX;
});

describe("chatSubjectRateLimiter", () => {
  it("caps each user separately at AI_CHAT_SUBJECT_RATE_LIMIT_MAX", async () => {
    process.env.AI_CHAT_SUBJECT_RATE_LIMIT_MAX = "1";
    const a = app("u-cs-1");
    expect((await request(a).get("/")).status).toBe(200);
    const limited = await request(a).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("CHAT_SUBJECT_RATE_LIMITED");
    expect((await request(app("u-cs-2")).get("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.AI_CHAT_SUBJECT_RATE_LIMIT_MAX = "1";
    const a = app();
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(429);
  });

  it("ignores an invalid cap and falls back to the default", async () => {
    process.env.AI_CHAT_SUBJECT_RATE_LIMIT_MAX = "nope";
    const res = await request(app("u-cs-invalid")).get("/");
    expect(res.headers["ratelimit-limit"]).toBe("300");
  });

  it("uses the generous test default when no cap is set", async () => {
    const res = await request(app("u-cs-default")).get("/");
    expect(res.headers["ratelimit-limit"]).toBe("10000");
  });
});
