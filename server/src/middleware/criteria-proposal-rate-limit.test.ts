/**
 * #1389 — the limiters for answering suggested acceptance criteria. The budget
 * is the signed-in user's: a rotated `X-Forwarded-For` neither resets it nor
 * spends another user's. The limiters are module-level (CodeQL must see the
 * `rateLimit()` result), so each test uses its own users.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens, signedAccessTokenUserId } from "../lib/auth/jwt.js";
import {
  CRITERIA_PROPOSAL_USER_DEFAULT_MAX,
  criteriaProposalPreAuthRateLimiter,
  criteriaProposalUserRateLimiter,
} from "./criteria-proposal-rate-limit.js";

const tokenFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "coordinator",
    permissions: getPermissionsForRole("coordinator"),
  }).accessToken;

/** Production order: pre-auth limiter, auth, user limiter, handler. */
function app() {
  const a = express();
  a.set("trust proxy", 1);
  a.post(
    "/answer",
    criteriaProposalPreAuthRateLimiter,
    (req, res, next) => {
      const token = req.headers.authorization?.slice("Bearer ".length) ?? "";
      const userId = token ? signedAccessTokenUserId(token) : null;
      if (!userId) {
        res.status(401).json({ success: false });
        return;
      }
      (req as unknown as { user: { userId: string } }).user = { userId };
      next();
    },
    criteriaProposalUserRateLimiter,
    (_req, res) => {
      res.status(200).json({ success: true });
    },
  );
  return a;
}

afterEach(() => {
  delete process.env.CRITERIA_PROPOSAL_LIMIT_MAX;
  delete process.env.CRITERIA_PROPOSAL_PREAUTH_LIMIT_MAX;
});

describe("criteria-proposal limiters (#1389)", () => {
  it("caps a user at CRITERIA_PROPOSAL_LIMIT_MAX with its own code and wording", async () => {
    process.env.CRITERIA_PROPOSAL_LIMIT_MAX = "2";
    const a = app();
    const auth = `Bearer ${tokenFor("u-1389-cap")}`;
    expect((await request(a).post("/answer").set("Authorization", auth)).status).toBe(200);
    expect((await request(a).post("/answer").set("Authorization", auth)).status).toBe(200);
    const limited = await request(a).post("/answer").set("Authorization", auth);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("CRITERIA_PROPOSAL_RATE_LIMITED");
    expect(limited.body.error.message).toMatch(/suggested acceptance criteria/);
  });

  it("a rotated X-Forwarded-For does not reset the budget, and another user keeps theirs", async () => {
    process.env.CRITERIA_PROPOSAL_LIMIT_MAX = "1";
    const a = app();
    const auth = `Bearer ${tokenFor("u-1389-rot")}`;
    expect(
      (
        await request(a)
          .post("/answer")
          .set("Authorization", auth)
          .set("X-Forwarded-For", "1.1.1.1")
      ).status,
    ).toBe(200);
    expect(
      (
        await request(a)
          .post("/answer")
          .set("Authorization", auth)
          .set("X-Forwarded-For", "2.2.2.2")
      ).status,
    ).toBe(429);
    const other = `Bearer ${tokenFor("u-1389-other")}`;
    expect((await request(a).post("/answer").set("Authorization", other)).status).toBe(200);
  });

  it("the pre-auth guard caps unauthenticated callers by peer, and a malformed cap falls back", async () => {
    process.env.CRITERIA_PROPOSAL_PREAUTH_LIMIT_MAX = "1";
    const a = app();
    expect((await request(a).post("/answer")).status).toBe(401);
    // #1117 — the peer bucket is spent, and a forwarded address does not make a
    // new one; the caller is told requireAuth's 401, not 429.
    const spent = await request(a).post("/answer").set("X-Forwarded-For", "9.9.9.9");
    expect(spent.status).toBe(401);
    expect(spent.headers["ratelimit-remaining"]).toBe("0");

    process.env.CRITERIA_PROPOSAL_LIMIT_MAX = "not-a-number";
    const auth = `Bearer ${tokenFor("u-1389-fallback")}`;
    const ok = await request(app()).post("/answer").set("Authorization", auth);
    expect(ok.status).toBe(200);
    expect(ok.headers["ratelimit-limit"] ?? ok.headers.ratelimit).toBeDefined();
    expect(CRITERIA_PROPOSAL_USER_DEFAULT_MAX).toBe(300);
  });
});
