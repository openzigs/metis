/**
 * #1349 — the traceability and analysis-approval pre-auth limiters key on
 * `runsPreAuthKey` (the user id in a token this server signed, else the TCP
 * peer), never on `req.ip`. Under `trust proxy` `req.ip` is the last
 * `X-Forwarded-For` entry, which the client writes: a new value per request
 * used to mint a fresh bucket per request.
 *
 * Each app trusts one proxy hop, as `createApp` does by default, so a spoofed
 * header would move `req.ip`. The limiters are module-level: every test uses
 * its own users.
 */
import { afterEach, describe, expect, it } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens } from "../lib/auth/jwt.js";
import { requireAuth } from "./auth.js";
import { errorHandler } from "./error-handler.js";
import { traceabilityPreAuthRateLimiter } from "./traceability-gaps-rate-limit.js";
import { analysisApprovalPreAuthRateLimiter } from "./analysis-approval-rate-limit.js";

const tokenFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;

/** Production order: the pre-auth limiter, then `requireAuth`, then the handler. */
function guarded(limiter: RequestHandler) {
  const a = express();
  a.set("trust proxy", 1);
  a.post("/", limiter, requireAuth, (_req, res) => {
    res.status(200).json({ success: true });
  });
  a.use(errorHandler);
  return a;
}

/** The limiter alone in front of a handler that would serve anyone. */
function bare(limiter: RequestHandler) {
  const a = express();
  a.set("trust proxy", 1);
  a.post("/", limiter, (_req, res) => {
    res.status(200).json({ success: true });
  });
  a.use(errorHandler);
  return a;
}

const cases = [
  {
    name: "traceabilityPreAuthRateLimiter",
    limiter: traceabilityPreAuthRateLimiter,
    env: "TRACEABILITY_PREAUTH_RATE_LIMIT_MAX",
    code: "TRACEABILITY_GAPS_RATE_LIMITED",
  },
  {
    name: "analysisApprovalPreAuthRateLimiter",
    limiter: analysisApprovalPreAuthRateLimiter,
    env: "ANALYSIS_APPROVAL_PREAUTH_RATE_LIMIT_MAX",
    code: "RATE_LIMITED",
  },
] as const;

afterEach(() => {
  for (const c of cases) delete process.env[c.env];
});

describe.each(cases)("$name (#1349)", ({ name, limiter, env, code }) => {
  it("a signed-in user changing X-Forwarded-For per request gets no fresh bucket", async () => {
    process.env[env] = "1";
    const a = guarded(limiter);
    const auth = `Bearer ${tokenFor(`u-1349-xff-${name}`)}`;
    const first = await request(a)
      .post("/")
      .set("Authorization", auth)
      .set("X-Forwarded-For", "203.0.113.1");
    expect(first.status).toBe(200);
    const second = await request(a)
      .post("/")
      .set("Authorization", auth)
      .set("X-Forwarded-For", "203.0.113.2");
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe(code);
  });

  it("an anonymous caller changing X-Forwarded-For shares the peer bucket and is answered requireAuth's 401", async () => {
    process.env[env] = "1";
    const a = bare(limiter);
    // The first request spends the peer bucket (the handler would serve it).
    await request(a).post("/").set("X-Forwarded-For", "198.51.100.1");
    const spoofed = await request(a).post("/").set("X-Forwarded-For", "198.51.100.2");
    expect(spoofed.status).toBe(401);
    expect(spoofed.body.error.code).toBe("AUTH_REQUIRED");
    expect(spoofed.headers["retry-after"]).toBeUndefined();
  });

  it("two users behind the same peer keep separate budgets", async () => {
    process.env[env] = "1";
    const a = guarded(limiter);
    const one = `Bearer ${tokenFor(`u-1349-one-${name}`)}`;
    const two = `Bearer ${tokenFor(`u-1349-two-${name}`)}`;
    expect((await request(a).post("/").set("Authorization", one)).status).toBe(200);
    expect((await request(a).post("/").set("Authorization", two)).status).toBe(200);
  });
});
