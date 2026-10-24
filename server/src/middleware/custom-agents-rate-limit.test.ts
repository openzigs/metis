/**
 * #1445 review — the custom-agent pre-auth guard: what a spent guard answers
 * and whose bucket a request spends. Which routes mount it, ahead of
 * `requireAuth`, is asserted on the real router in
 * `tests/custom-agents-routes.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "@metis/shared";
import { errorHandler } from "./error-handler.js";
import { EXPIRED_ACCESS_TOKEN_KEY_GRACE_SECONDS, issueTokens } from "../lib/auth/jwt.js";
import {
  CUSTOM_AGENTS_PREAUTH_DEFAULT_MAX,
  customAgentsPreAuthRateLimiter,
} from "./custom-agents-rate-limit.js";

const tokensFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  });

/** An access token for `userId` that expired `secondsAgo` seconds ago. */
const expiredFor = (userId: string, secondsAgo: number) => {
  const payload = jwt.decode(tokensFor(userId).accessToken) as Record<string, unknown>;
  const exp = Math.floor(Date.now() / 1000) - secondsAgo;
  return jwt.sign({ ...payload, iat: exp - 3600, exp }, process.env.JWT_SECRET as string);
};

describe("#1445 customAgentsPreAuthRateLimiter — what a spent guard answers", () => {
  const app = express();
  app.get("/x", customAgentsPreAuthRateLimiter, (_req, res) => {
    res.json({ served: true });
  });
  app.use(errorHandler);
  const call = (authorization?: string) => {
    const r = request(app).get("/x");
    return authorization ? r.set("Authorization", authorization) : r;
  };

  beforeAll(() => {
    process.env.CUSTOM_AGENTS_PREAUTH_LIMIT_MAX = "1";
  });
  // Spend the loopback peer's bucket per test (see runs-rate-limit.test.ts for
  // why never in `beforeAll`).
  beforeEach(async () => {
    await call();
  });
  afterAll(() => {
    delete process.env.CUSTOM_AGENTS_PREAUTH_LIMIT_MAX;
  });

  it("is a coarse guard by default", () => {
    expect(CUSTOM_AGENTS_PREAUTH_DEFAULT_MAX).toBe(20_000);
  });

  it("the spent peer bucket hands each request requireAuth's own 401, with no Retry-After", async () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, "AUTH_REQUIRED"],
      ["Bearer not-ours", "TOKEN_INVALID"],
      [`Bearer ${tokensFor("u-alice").refreshToken}`, "TOKEN_INVALID"],
    ];
    for (const [authorization, code] of cases) {
      const res = await call(authorization);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(code);
      expect(res.headers["retry-after"]).toBeUndefined();
    }
  });

  it("a signed-in user's spent bucket is 429 CUSTOM_AGENTS_RATE_LIMITED", async () => {
    const auth = `Bearer ${tokensFor("u-spent").accessToken}`;
    expect((await call(auth)).status).toBe(200);
    const res = await call(auth);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("CUSTOM_AGENTS_RATE_LIMITED");
  });

  it("a token that has JUST expired spends its user's bucket, not the spent peer's", async () => {
    const expired = expiredFor(
      "u-just-expired",
      Math.min(60, EXPIRED_ACCESS_TOKEN_KEY_GRACE_SECONDS - 5),
    );
    // Its own (fresh) bucket: served, though the peer bucket is spent.
    expect((await call(`Bearer ${expired}`)).status).toBe(200);
  });

  it("a token expired longer ago than the grace is the peer: it gets the spent peer's 401", async () => {
    const stale = expiredFor("u-stale", EXPIRED_ACCESS_TOKEN_KEY_GRACE_SECONDS + 5);
    const res = await call(`Bearer ${stale}`);
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty("served");
  });
});
