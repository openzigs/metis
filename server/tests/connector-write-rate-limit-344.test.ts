/**
 * #344 — connector create/update routes carry a per-user limiter that static
 * analysis can see (`connectorWriteRateLimiter`); its cap is read per request.
 */
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { connectorWriteRateLimiter } from "../src/middleware/connector-rate-limit.js";

describe("#344 connectorWriteRateLimiter", () => {
  afterEach(() => {
    delete process.env.CONNECTOR_WRITE_LIMIT_MAX;
  });

  it("answers 429 CONNECTOR_WRITE_RATE_LIMITED past CONNECTOR_WRITE_LIMIT_MAX per user", async () => {
    process.env.CONNECTOR_WRITE_LIMIT_MAX = "2";
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { user: { userId: string } }).user = {
        userId: String(req.headers["x-user"]),
      };
      next();
    });
    app.post("/w", connectorWriteRateLimiter, (_req, res) => {
      res.json({ ok: true });
    });
    const as = (user: string) => request(app).post("/w").set("x-user", user);
    expect((await as("u-344-a")).status).toBe(200);
    expect((await as("u-344-a")).status).toBe(200);
    const limited = await as("u-344-a");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("CONNECTOR_WRITE_RATE_LIMITED");
    // Keyed per user: another caller is unaffected.
    expect((await as("u-344-b")).status).toBe(200);
  });
});
