/**
 * #789 — the Spec Kit feature-artifact DELETE limiter: caps per client
 * address with the standard envelope, and reads the cap per request. It runs
 * ahead of `requireAuth`, so it never sees a user and always keys by IP. The
 * limiter is module-level (CodeQL must see the `rateLimit()` result), so the
 * budget is shared across tests in this file.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  SPECKIT_DELETE_DEFAULT_MAX,
  specKitDeleteRateLimiter,
} from "./spec-kit-delete-rate-limit.js";

function app() {
  const a = express();
  a.delete("/artifact", specKitDeleteRateLimiter, (_req, res) => {
    res.status(204).end();
  });
  return a;
}

afterEach(() => {
  delete process.env.SPECKIT_DELETE_LIMIT_MAX;
});

describe("specKitDeleteRateLimiter", () => {
  it("caps by client address at SPECKIT_DELETE_LIMIT_MAX, with the standard envelope", async () => {
    process.env.SPECKIT_DELETE_LIMIT_MAX = "2";
    const a = app();
    expect((await request(a).delete("/artifact")).status).toBe(204);
    expect((await request(a).delete("/artifact")).status).toBe(204);
    const limited = await request(a).delete("/artifact");
    expect(limited.status).toBe(429);
    expect(limited.body.success).toBe(false);
    expect(limited.body.error.code).toBe("SPECKIT_DELETE_RATE_LIMITED");
  });

  it("falls back to the default cap for a malformed setting", async () => {
    process.env.SPECKIT_DELETE_LIMIT_MAX = "not-a-number";
    // The prior test left this address at 3 hits; the default cap is far above.
    expect((await request(app()).delete("/artifact")).status).toBe(204);
    expect(SPECKIT_DELETE_DEFAULT_MAX).toBeGreaterThan(4);
  });
});
