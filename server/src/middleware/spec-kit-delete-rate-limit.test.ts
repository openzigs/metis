/**
 * #789 — rate limiter for the Spec Kit feature-artifact DELETE route.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  specKitDeleteRateLimiter,
  __resetSpecKitDeleteRateLimiter,
} from "./spec-kit-delete-rate-limit.js";

function buildApp(userId: string) {
  const app = express();
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    (req as unknown as { user?: { userId: string } }).user = { userId };
    next();
  });
  app.delete("/artifact", specKitDeleteRateLimiter, (_req, res) => {
    res.status(204).end();
  });
  return app;
}

beforeEach(() => {
  process.env.SPECKIT_DELETE_LIMIT_MAX = "2";
  process.env.SPECKIT_DELETE_LIMIT_WINDOW_MS = "60000";
  __resetSpecKitDeleteRateLimiter();
});

afterEach(() => {
  delete process.env.SPECKIT_DELETE_LIMIT_MAX;
  delete process.env.SPECKIT_DELETE_LIMIT_WINDOW_MS;
  __resetSpecKitDeleteRateLimiter();
});

describe("specKitDeleteRateLimiter", () => {
  it("allows deletes up to the configured max", async () => {
    const app = buildApp("user-a");
    for (let i = 0; i < 2; i++) {
      expect((await request(app).delete("/artifact")).status).toBe(204);
    }
  });

  it("refuses the delete past the max with the standard error envelope", async () => {
    const app = buildApp("user-a");
    for (let i = 0; i < 2; i++) await request(app).delete("/artifact");
    const res = await request(app).delete("/artifact");
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("SPECKIT_DELETE_RATE_LIMITED");
  });

  it("keys by user — another user is not throttled by the first one's deletes", async () => {
    const a = buildApp("user-a");
    for (let i = 0; i < 3; i++) await request(a).delete("/artifact");
    expect((await request(buildApp("user-b")).delete("/artifact")).status).toBe(204);
  });

  it("falls back to the default max for a malformed setting", async () => {
    process.env.SPECKIT_DELETE_LIMIT_MAX = "not-a-number";
    __resetSpecKitDeleteRateLimiter();
    const app = buildApp("user-c");
    for (let i = 0; i < 3; i++) {
      expect((await request(app).delete("/artifact")).status).toBe(204);
    }
  });
});
