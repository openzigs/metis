/**
 * Rate-limit middleware for the manual-trigger endpoint
 * (`POST /api/scheduler/:id/run`). Review fix M4.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  runNowRateLimiter,
  __resetRunNowRateLimiter,
} from "../src/middleware/scheduler-run-rate-limit.js";

function makeApp(): ReturnType<typeof express> {
  const app = express();
  // Inject a fake user so the limiter keys per-user, not per-IP.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { userId: string } }).user = {
      userId: req.headers["x-uid"] as string,
    };
    next();
  });
  app.post("/run", runNowRateLimiter, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

afterEach(() => {
  __resetRunNowRateLimiter();
  delete process.env.SCHEDULER_RUN_LIMIT_MAX;
  delete process.env.SCHEDULER_RUN_LIMIT_WINDOW_MS;
  vi.clearAllMocks();
});

describe("runNowRateLimiter", () => {
  it("allows up to the configured maximum then rejects with 429", async () => {
    process.env.SCHEDULER_RUN_LIMIT_MAX = "3";
    process.env.SCHEDULER_RUN_LIMIT_WINDOW_MS = "60000";
    __resetRunNowRateLimiter();
    const app = makeApp();
    for (let i = 0; i < 3; i += 1) {
      const r = await request(app).post("/run").set("x-uid", "alice");
      expect(r.status).toBe(200);
    }
    const blocked = await request(app).post("/run").set("x-uid", "alice");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      error: expect.objectContaining({ code: "SCHEDULER_RUN_RATE_LIMITED" }),
    });
  });

  it("scopes the bucket per user (different uids are independent)", async () => {
    process.env.SCHEDULER_RUN_LIMIT_MAX = "1";
    process.env.SCHEDULER_RUN_LIMIT_WINDOW_MS = "60000";
    __resetRunNowRateLimiter();
    const app = makeApp();
    expect((await request(app).post("/run").set("x-uid", "alice")).status).toBe(200);
    expect((await request(app).post("/run").set("x-uid", "alice")).status).toBe(429);
    // Different user — fresh bucket.
    expect((await request(app).post("/run").set("x-uid", "bob")).status).toBe(200);
  });
});
