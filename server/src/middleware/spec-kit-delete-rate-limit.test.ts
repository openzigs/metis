/**
 * #789 — the Spec Kit feature-artifact DELETE limiter: per-user keys when a
 * user is known, an IP key otherwise, and a cap read per request. The limiter
 * is module-level (CodeQL must see the `rateLimit()` result), so every test
 * uses its own key.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  SPECKIT_DELETE_DEFAULT_MAX,
  specKitDeleteRateLimiter,
} from "./spec-kit-delete-rate-limit.js";

function app(userId?: string) {
  const a = express();
  a.use((req, _res, next) => {
    if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.delete("/artifact", specKitDeleteRateLimiter, (_req, res) => {
    res.status(204).end();
  });
  return a;
}

afterEach(() => {
  delete process.env.SPECKIT_DELETE_LIMIT_MAX;
});

describe("specKitDeleteRateLimiter", () => {
  it("caps each user separately at SPECKIT_DELETE_LIMIT_MAX, with the standard envelope", async () => {
    process.env.SPECKIT_DELETE_LIMIT_MAX = "2";
    const a = app("skd-user-1");
    expect((await request(a).delete("/artifact")).status).toBe(204);
    expect((await request(a).delete("/artifact")).status).toBe(204);
    const limited = await request(a).delete("/artifact");
    expect(limited.status).toBe(429);
    expect(limited.body.success).toBe(false);
    expect(limited.body.error.code).toBe("SPECKIT_DELETE_RATE_LIMITED");
    // Another user is not throttled by the first one's deletes.
    expect((await request(app("skd-user-2")).delete("/artifact")).status).toBe(204);
  });

  it("keys an anonymous request by IP", async () => {
    process.env.SPECKIT_DELETE_LIMIT_MAX = "1";
    const anon = app();
    expect((await request(anon).delete("/artifact")).status).toBe(204);
    expect((await request(anon).delete("/artifact")).status).toBe(429);
    // A signed-in user on the same address has their own budget.
    expect((await request(app("skd-user-3")).delete("/artifact")).status).toBe(204);
  });

  it("falls back to the default cap for a malformed setting", async () => {
    process.env.SPECKIT_DELETE_LIMIT_MAX = "not-a-number";
    const a = app("skd-user-4");
    for (let i = 0; i < 3; i++) {
      expect((await request(a).delete("/artifact")).status).toBe(204);
    }
    expect(SPECKIT_DELETE_DEFAULT_MAX).toBeGreaterThan(3);
  });
});
