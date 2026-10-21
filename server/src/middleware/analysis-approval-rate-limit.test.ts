/**
 * #723 — the approval-reopen limiter: per-user keys, an IP fallback, and a cap
 * read per request.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "./error-handler.js";
import {
  ANALYSIS_APPROVAL_PREAUTH_DEFAULT_MAX,
  analysisApprovalPreAuthRateLimiter,
  analysisApprovalPromoteRateLimiter,
  analysisApprovalReopenRateLimiter,
} from "./analysis-approval-rate-limit.js";

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

describe("analysisApprovalPromoteRateLimiter (#723)", () => {
  function promoteApp(userId?: string) {
    const a = express();
    a.use((req, _res, next) => {
      if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
      next();
    });
    a.use(analysisApprovalPromoteRateLimiter);
    a.post("/", (_req, res) => res.json({ ok: true }));
    return a;
  }

  afterEach(() => {
    delete process.env.ANALYSIS_APPROVAL_PROMOTE_RATE_LIMIT_MAX;
  });

  it("caps each user separately, under its own key and env var", async () => {
    process.env.ANALYSIS_APPROVAL_PROMOTE_RATE_LIMIT_MAX = "1";
    const a = promoteApp("promote-user-1");
    expect((await request(a).post("/")).status).toBe(200);
    const limited = await request(a).post("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error.message).toContain("promotion");
    expect((await request(promoteApp("promote-user-2")).post("/")).status).toBe(200);
  });

  it("keys an unauthenticated caller by IP", async () => {
    process.env.ANALYSIS_APPROVAL_PROMOTE_RATE_LIMIT_MAX = "1";
    const a = promoteApp();
    expect((await request(a).post("/")).status).toBe(200);
    expect((await request(a).post("/")).status).toBe(429);
  });

  it("defaults to 30 per window outside tests", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(promoteApp("promote-user-3")).post("/");
      expect(res.headers["ratelimit-limit"]).toBe("30");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("analysisApprovalPreAuthRateLimiter (PR #902)", () => {
  function preAuthApp(userId: string, authRan: { n: number }) {
    const a = express();
    a.use((req, _res, next) => {
      (req as unknown as { user: { userId: string } }).user = { userId };
      next();
    });
    a.use(analysisApprovalPreAuthRateLimiter);
    // Stand-in for `requireAuth`: records that it ran, and would refuse.
    a.use((_req, res) => {
      authRan.n += 1;
      res.status(401).json({ success: false });
    });
    a.use(errorHandler);
    return a;
  }

  afterEach(() => {
    delete process.env.ANALYSIS_APPROVAL_PREAUTH_RATE_LIMIT_MAX;
  });

  it("stops a request with no signed token at the spent peer bucket, before the route's auth runs (#1349)", async () => {
    process.env.ANALYSIS_APPROVAL_PREAUTH_RATE_LIMIT_MAX = "1";
    const authRan = { n: 0 };
    expect((await request(preAuthApp("pre-user-1", authRan)).post("/")).status).toBe(401);
    expect(authRan.n).toBe(1);
    // `req.user` set upstream is not a token, so both share the peer bucket;
    // the limiter answers with requireAuth's own 401, not 429 (#1117).
    const limited = await request(preAuthApp("pre-user-2", authRan)).post("/");
    expect(limited.status).toBe(401);
    expect(limited.body.error.code).toBe("AUTH_REQUIRED");
    expect(authRan.n).toBe(1);
  });

  it("defaults to a generous per-IP ceiling outside tests", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(preAuthApp("pre-user-3", { n: 0 })).post("/");
      expect(ANALYSIS_APPROVAL_PREAUTH_DEFAULT_MAX).toBe(3_600);
      expect(res.headers["ratelimit-limit"]).toBe("3600");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
