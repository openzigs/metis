/**
 * #723 — the approval-reopen limiter: per-user keys, an IP fallback, and a cap
 * read per request.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { analysisApprovalReopenRateLimiter } from "./analysis-approval-rate-limit.js";

function app(userId?: string) {
  const a = express();
  a.use((req, _res, next) => {
    if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(analysisApprovalReopenRateLimiter);
  a.post("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.ANALYSIS_APPROVAL_REOPEN_RATE_LIMIT_MAX;
});

describe("analysisApprovalReopenRateLimiter", () => {
  it("caps each user separately at ANALYSIS_APPROVAL_REOPEN_RATE_LIMIT_MAX", async () => {
    process.env.ANALYSIS_APPROVAL_REOPEN_RATE_LIMIT_MAX = "2";
    const a = app("reopen-user-1");
    expect((await request(a).post("/")).status).toBe(200);
    expect((await request(a).post("/")).status).toBe(200);
    const limited = await request(a).post("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect((await request(app("reopen-user-2")).post("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.ANALYSIS_APPROVAL_REOPEN_RATE_LIMIT_MAX = "1";
    const a = app();
    expect((await request(a).post("/")).status).toBe(200);
    expect((await request(a).post("/")).status).toBe(429);
  });

  it("defaults to 120 per window outside tests", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(app("reopen-user-3")).post("/");
      expect(res.headers["ratelimit-limit"]).toBe("120");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
