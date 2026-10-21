/**
 * #838 — the analysis matrix limiters, driven through a real request chain in
 * production order. That they sit on the matrix and export routes is asserted
 * on the real router in `routes/analysis-traceability.test.ts`. The keys are
 * `runs-rate-limit.ts`'s (tested there); here: the budgets, the 15-minute
 * expiry bound on the pre-auth user key (#1117), and the peer bucket's 401.
 * The limiters are module-level, so each test uses its own users.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens } from "../lib/auth/jwt.js";
import { requireAuth } from "./auth.js";
import { errorHandler } from "./error-handler.js";
import {
  ANALYSIS_MATRIX_DEFAULT_MAX,
  ANALYSIS_MATRIX_PREAUTH_DEFAULT_MAX,
  analysisMatrixPreAuthRateLimiter,
  analysisMatrixUserRateLimiter,
} from "./analysis-matrix-rate-limit.js";

const tokenFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;

/** The same user's token, re-signed to have expired `agoSeconds` ago. */
function expiredFor(userId: string, agoSeconds: number): string {
  const payload = jwt.decode(tokenFor(userId)) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { ...payload, iat: now - agoSeconds - 3600, exp: now - agoSeconds },
    // The same key `issueTokens` signs with under NODE_ENV=test.
    process.env.JWT_SECRET as string,
  );
}

/** Production order: pre-auth limiter, requireAuth, user limiter, handler. */
function app() {
  const a = express();
  a.get(
    "/matrix",
    analysisMatrixPreAuthRateLimiter,
    requireAuth,
    analysisMatrixUserRateLimiter,
    (_req, res) => {
      res.status(200).json({ success: true });
    },
  );
  a.use(errorHandler);
  return a;
}

afterEach(() => {
  delete process.env.ANALYSIS_MATRIX_RATE_LIMIT_MAX;
  delete process.env.ANALYSIS_MATRIX_PREAUTH_RATE_LIMIT_MAX;
});

describe("analysis matrix limiters", () => {
  it("caps a signed-in user at ANALYSIS_MATRIX_RATE_LIMIT_MAX with its own code", async () => {
    process.env.ANALYSIS_MATRIX_RATE_LIMIT_MAX = "2";
    const a = app();
    const auth = `Bearer ${tokenFor("u-838-cap")}`;
    expect((await request(a).get("/matrix").set("Authorization", auth)).status).toBe(200);
    expect((await request(a).get("/matrix").set("Authorization", auth)).status).toBe(200);
    const limited = await request(a).get("/matrix").set("Authorization", auth);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("ANALYSIS_MATRIX_RATE_LIMITED");
    // Another user's budget is untouched.
    const other = `Bearer ${tokenFor("u-838-other")}`;
    expect((await request(a).get("/matrix").set("Authorization", other)).status).toBe(200);
  });

  it("a token expired a minute ago is still its user's pre-auth bucket: 429, not the peer's 401", async () => {
    process.env.ANALYSIS_MATRIX_PREAUTH_RATE_LIMIT_MAX = "1";
    const a = app();
    const auth = `Bearer ${expiredFor("u-838-recent", 60)}`;
    // Within budget: requireAuth answers the 401 the browser refreshes on.
    const first = await request(a).get("/matrix").set("Authorization", auth);
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe("TOKEN_EXPIRED");
    const second = await request(a).get("/matrix").set("Authorization", auth);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("ANALYSIS_MATRIX_RATE_LIMITED");
  });

  it("a token expired over 15 minutes ago is the peer's, and a spent peer bucket answers requireAuth's 401", async () => {
    process.env.ANALYSIS_MATRIX_PREAUTH_RATE_LIMIT_MAX = "1";
    const a = app();
    const stale = `Bearer ${expiredFor("u-838-stale", 16 * 60)}`;
    await request(a).get("/matrix").set("Authorization", stale);
    const res = await request(a).get("/matrix").set("Authorization", stale);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_EXPIRED");
    expect(res.headers["retry-after"]).toBeUndefined();
    const anonymous = await request(a).get("/matrix");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("the pre-auth guard is coarser than the user budget", () => {
    expect(ANALYSIS_MATRIX_DEFAULT_MAX).toBe(300);
    expect(ANALYSIS_MATRIX_PREAUTH_DEFAULT_MAX).toBeGreaterThan(ANALYSIS_MATRIX_DEFAULT_MAX);
  });
});
