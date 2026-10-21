/**
 * #1117 — every pre-auth limiter keyed on `signedAccessTokenUserId` answers a
 * spent PEER bucket with `requireAuth`'s own 401, and a spent USER bucket (or a
 * request `requireAuth` would accept) with its own 429.
 *
 * The 15-minute grace moved long-expired tokens onto the peer bucket of all
 * three limiters, not only the `/api/runs` one, so each is pinned here through
 * the real exported limiter in front of a handler that would serve anything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens } from "../lib/auth/jwt.js";
import { errorHandler } from "./error-handler.js";
import { runsPreAuthRateLimiter } from "./runs-rate-limit.js";
import { discussionMessageChangePreAuthRateLimiter } from "./discussion-message-change-rate-limit.js";
import { sourceDivergencePreAuthRateLimiter } from "./source-divergence-rate-limit.js";

const secret = () => process.env.JWT_SECRET as string;

const tokensFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  });

/** An access token this server signed for `userId`, which ran out a week ago. */
const longExpired = (userId: string) => {
  const payload = jwt.decode(tokensFor(userId).accessToken) as Record<string, unknown>;
  const exp = Math.floor(Date.now() / 1000) - 7 * 86_400;
  return jwt.sign({ ...payload, iat: exp - 3600, exp }, secret());
};

const LIMITERS: Array<{ name: string; limiter: RequestHandler; env: string; code: string }> = [
  {
    name: "runsPreAuthRateLimiter",
    limiter: runsPreAuthRateLimiter,
    env: "RUNS_PREAUTH_LIMIT_MAX",
    code: "RUNS_RATE_LIMITED",
  },
  {
    name: "discussionMessageChangePreAuthRateLimiter",
    limiter: discussionMessageChangePreAuthRateLimiter,
    env: "DISCUSSION_MESSAGE_CHANGE_PREAUTH_LIMIT_MAX",
    code: "DISCUSSION_MESSAGE_CHANGE_RATE_LIMITED",
  },
  {
    name: "sourceDivergencePreAuthRateLimiter",
    limiter: sourceDivergencePreAuthRateLimiter,
    env: "SOURCE_DIVERGENCE_PREAUTH_LIMIT_MAX",
    code: "SOURCE_DIVERGENCE_RATE_LIMITED",
  },
];

describe.each(LIMITERS)("#1117 $name — what a spent bucket answers", ({ limiter, env, code }) => {
  const app = express();
  app.get("/x", limiter, (_req, res) => {
    res.json({ served: true });
  });
  app.use(errorHandler);
  const call = (authorization?: string) => {
    const r = request(app).get("/x");
    return authorization ? r.set("Authorization", authorization) : r;
  };

  beforeAll(() => {
    process.env[env] = "1";
  });
  afterAll(() => {
    delete process.env[env];
  });
  // Spend the loopback peer's bucket per test: `tests/setup.ts` installs the
  // supertest loopback spy per test, so a `beforeAll` request is another peer.
  beforeEach(async () => {
    await call();
  });

  it("a spent peer bucket answers requireAuth's own 401, with no Retry-After", async () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, "AUTH_REQUIRED"],
      ["Bearer not-a-token-we-signed", "TOKEN_INVALID"],
      // Past the 15-minute grace: keyed on the peer, and told it has expired.
      [`Bearer ${longExpired(`u-old-${env}`)}`, "TOKEN_EXPIRED"],
    ];
    for (const [authorization, want] of cases) {
      const res = await call(authorization);
      expect(res.status, want).toBe(401);
      expect(res.body.error.code).toBe(want);
      expect(res.headers["ratelimit-remaining"]).toBe("0");
      expect(res.headers["retry-after"]).toBeUndefined();
    }
  });

  it("a request requireAuth would accept is still 429 on the spent peer bucket", async () => {
    // Signed by this server and unexpired, but no `userId`: the key is the
    // peer, and `requireAuth` accepts it.
    const odd = jwt.sign({ role: "developer" }, secret(), { expiresIn: 60 });
    const res = await call(`Bearer ${odd}`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe(code);
    expect(res.body).not.toHaveProperty("served");
  });

  it("a signed-in user's spent bucket is 429", async () => {
    const auth = `Bearer ${tokensFor(`u-spent-${env}`).accessToken}`;
    expect((await call(auth)).status).toBe(200);
    const res = await call(auth);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe(code);
  });
});
