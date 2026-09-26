/**
 * #127 — the conversation-route limiter: per-user keys, an IP fallback, and a
 * cap read per request (PR #205 review: coverage below the 80% floor).
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { conversationRateLimiter } from "./conversation-rate-limit.js";

function app(userId?: string) {
  const a = express();
  a.use((req, _res, next) => {
    if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(conversationRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.AI_CONVERSATION_RATE_LIMIT_MAX;
});

describe("conversationRateLimiter", () => {
  it("caps each user separately at AI_CONVERSATION_RATE_LIMIT_MAX", async () => {
    process.env.AI_CONVERSATION_RATE_LIMIT_MAX = "2";
    const a = app("u-cap-1");
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(200);
    const limited = await request(a).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("AI_CONVERSATION_RATE_LIMITED");
    // Another user has their own budget.
    expect((await request(app("u-cap-2")).get("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.AI_CONVERSATION_RATE_LIMIT_MAX = "1";
    const a = app();
    expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).status).toBe(429);
  });

  it("ignores an invalid cap and falls back to the default", async () => {
    process.env.AI_CONVERSATION_RATE_LIMIT_MAX = "nope";
    const a = app("u-invalid");
    for (let i = 0; i < 3; i++) expect((await request(a).get("/")).status).toBe(200);
    expect((await request(a).get("/")).headers["ratelimit-limit"]).toBe("300");
  });

  it("uses the generous test default when no cap is set", async () => {
    const res = await request(app("u-default")).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("10000");
  });
});
