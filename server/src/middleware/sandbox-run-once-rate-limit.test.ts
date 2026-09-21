/**
 * Issue #16 — rate limiter for POST /api/sandbox/run-once.
 *
 * An authenticated developer must not be able to burn project budget by
 * looping the run-once endpoint. The limiter caps per-user requests and
 * returns the project's standard error envelope on overflow.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  sandboxRunOnceRateLimiter,
  __resetSandboxRunOnceRateLimiter,
} from "./sandbox-run-once-rate-limit.js";

function buildApp(userId: string) {
  const app = express();
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    (req as unknown as { user?: { userId: string } }).user = { userId };
    next();
  });
  app.post("/run-once", sandboxRunOnceRateLimiter, (_req, res) => {
    res.json({ success: true, data: { ok: true } });
  });
  return app;
}

beforeEach(() => {
  process.env.SANDBOX_RUN_ONCE_LIMIT_MAX = "3";
  process.env.SANDBOX_RUN_ONCE_LIMIT_WINDOW_MS = "60000";
  __resetSandboxRunOnceRateLimiter();
});

afterEach(() => {
  delete process.env.SANDBOX_RUN_ONCE_LIMIT_MAX;
  delete process.env.SANDBOX_RUN_ONCE_LIMIT_WINDOW_MS;
  __resetSandboxRunOnceRateLimiter();
});

describe("sandboxRunOnceRateLimiter", () => {
  it("allows requests up to the configured max", async () => {
    const app = buildApp("user-a");
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/run-once");
      expect(res.status).toBe(200);
    }
  });

  it("rejects the request that exceeds the max with the standard error shape", async () => {
    const app = buildApp("user-a");
    for (let i = 0; i < 3; i++) await request(app).post("/run-once");
    const res = await request(app).post("/run-once");
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("SANDBOX_RUN_ONCE_RATE_LIMITED");
    expect(typeof res.body.error.message).toBe("string");
  });

  it("keys by user — a different user is not throttled by another's usage", async () => {
    const appA = buildApp("user-a");
    for (let i = 0; i < 3; i++) await request(appA).post("/run-once");
    const blocked = await request(appA).post("/run-once");
    expect(blocked.status).toBe(429);

    const appB = buildApp("user-b");
    const fresh = await request(appB).post("/run-once");
    expect(fresh.status).toBe(200);
  });
});
