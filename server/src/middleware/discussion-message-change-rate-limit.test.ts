/**
 * #734 — the discussion message edit/delete limiter: caps per client address
 * with the standard envelope, and reads the cap per request. It runs ahead of
 * `requireAuth`, so it always keys by IP. The limiter is module-level (CodeQL
 * must see the `rateLimit()` result), so the budget is shared across tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  DISCUSSION_MESSAGE_CHANGE_DEFAULT_MAX,
  discussionMessageChangeRateLimiter,
} from "./discussion-message-change-rate-limit.js";

function app() {
  const a = express();
  a.patch("/message", discussionMessageChangeRateLimiter, (_req, res) => {
    res.status(200).json({ success: true });
  });
  return a;
}

afterEach(() => {
  delete process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX;
});

describe("discussionMessageChangeRateLimiter", () => {
  it("caps by client address at DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX, with the standard envelope", async () => {
    process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX = "2";
    const a = app();
    expect((await request(a).patch("/message")).status).toBe(200);
    expect((await request(a).patch("/message")).status).toBe(200);
    const limited = await request(a).patch("/message");
    expect(limited.status).toBe(429);
    expect(limited.body.success).toBe(false);
    expect(limited.body.error.code).toBe("DISCUSSION_MESSAGE_CHANGE_RATE_LIMITED");
  });

  it("falls back to the default cap for a malformed setting", async () => {
    process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX = "not-a-number";
    // The prior test left this address at 3 hits; the default cap is far above.
    expect((await request(app()).patch("/message")).status).toBe(200);
    expect(DISCUSSION_MESSAGE_CHANGE_DEFAULT_MAX).toBeGreaterThan(4);
  });
});
