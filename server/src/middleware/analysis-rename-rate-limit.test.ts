/**
 * #2341 — the change-request rename limiters: a per-user cap after auth and a
 * per-peer ceiling ahead of it, each under its own key and env var.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "./error-handler.js";
import {
  ANALYSIS_RENAME_DEFAULT_MAX,
  ANALYSIS_RENAME_PREAUTH_DEFAULT_MAX,
  analysisRenamePreAuthRateLimiter,
  analysisRenameRateLimiter,
} from "./analysis-rename-rate-limit.js";

afterEach(() => {
  delete process.env.ANALYSIS_RENAME_RATE_LIMIT_MAX;
  delete process.env.ANALYSIS_RENAME_PREAUTH_RATE_LIMIT_MAX;
});

describe("analysisRenameRateLimiter", () => {
  function app(userId?: string) {
    const a = express();
    a.use((req, _res, next) => {
      if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
      next();
    });
    a.use(analysisRenameRateLimiter);
    a.patch("/", (_req, res) => res.json({ ok: true }));
    return a;
  }

  it("caps each user separately at ANALYSIS_RENAME_RATE_LIMIT_MAX", async () => {
    process.env.ANALYSIS_RENAME_RATE_LIMIT_MAX = "1";
    const a = app("rename-user-1");
    expect((await request(a).patch("/")).status).toBe(200);
    const limited = await request(a).patch("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: "RATE_LIMITED" });
    expect(limited.body.error.message).toContain("rename");
    expect((await request(app("rename-user-2")).patch("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.ANALYSIS_RENAME_RATE_LIMIT_MAX = "1";
    const a = app();
    expect((await request(a).patch("/")).status).toBe(200);
    expect((await request(a).patch("/")).status).toBe(429);
  });

  it("defaults to 120 per window outside tests, and ignores a malformed cap", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.ANALYSIS_RENAME_RATE_LIMIT_MAX = "not-a-number";
    try {
      const res = await request(app("rename-user-3")).patch("/");
      expect(ANALYSIS_RENAME_DEFAULT_MAX).toBe(120);
      expect(res.headers["ratelimit-limit"]).toBe("120");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("analysisRenamePreAuthRateLimiter", () => {
  function preAuthApp(userId: string, authRan: { n: number }) {
    const a = express();
    a.use((req, _res, next) => {
      (req as unknown as { user: { userId: string } }).user = { userId };
      next();
    });
    a.use(analysisRenamePreAuthRateLimiter);
    // Stand-in for `requireAuth`: records that it ran, and would refuse.
    a.use((_req, res) => {
      authRan.n += 1;
      res.status(401).json({ success: false });
    });
    a.use(errorHandler);
    return a;
  }

  it("stops a request with no signed token at the spent peer bucket, before auth runs", async () => {
    process.env.ANALYSIS_RENAME_PREAUTH_RATE_LIMIT_MAX = "1";
    const authRan = { n: 0 };
    expect((await request(preAuthApp("rename-pre-1", authRan)).patch("/")).status).toBe(401);
    expect(authRan.n).toBe(1);
    const limited = await request(preAuthApp("rename-pre-2", authRan)).patch("/");
    expect(limited.status).toBe(401);
    expect(limited.body.error.code).toBe("AUTH_REQUIRED");
    expect(authRan.n).toBe(1);
  });

  it("defaults to a generous per-peer ceiling outside tests", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(preAuthApp("rename-pre-3", { n: 0 })).patch("/");
      expect(res.headers["ratelimit-limit"]).toBe(String(ANALYSIS_RENAME_PREAUTH_DEFAULT_MAX));
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
