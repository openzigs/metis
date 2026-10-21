/**
 * #1007 — the `/api/runs` limiters: what each one's KEY is. Which limiter sits
 * on which route, and in what order relative to `requireAuth`, is asserted on
 * the REAL router in `tests/runs-chat-turns-route.sqlite.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { Request } from "express";
import { errorHandler } from "./error-handler.js";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "@metis/shared";
import {
  EXPIRED_ACCESS_TOKEN_KEY_GRACE_SECONDS,
  issueTokens,
  signedAccessTokenUserId,
} from "../lib/auth/jwt.js";
import {
  RUNS_PREAUTH_DEFAULT_MAX,
  RUNS_USER_DEFAULT_MAX,
  runsPreAuthKey,
  runsPreAuthRateLimiter,
  runsUserKey,
} from "./runs-rate-limit.js";

/** A request as a key function sees it. `ip` is what a client-supplied header would make it. */
const req = (over: {
  ip?: string;
  authorization?: string;
  cookie?: string;
  userId?: string;
  peer?: string;
}): Request =>
  ({
    ip: over.ip ?? "203.0.113.200",
    headers: {
      ...(over.authorization ? { authorization: over.authorization } : {}),
      "x-forwarded-for": over.ip ?? "203.0.113.200",
    },
    cookies: over.cookie ? { accessToken: over.cookie } : {},
    user: over.userId ? { userId: over.userId } : undefined,
    socket: { remoteAddress: over.peer ?? "10.0.0.5", remoteFamily: "IPv4" },
  }) as unknown as Request;

const tokensFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  });

describe("runsUserKey — the budget is the signed-in user's", () => {
  it("is the user, whatever address the request claims or comes from", () => {
    const key = runsUserKey(req({ userId: "u-alice", ip: "198.51.100.1", peer: "10.0.0.1" }));
    expect(key).toBe("user:u-alice");
    expect(runsUserKey(req({ userId: "u-alice", ip: "198.51.100.2", peer: "10.0.0.2" }))).toBe(key);
    expect(runsUserKey(req({ userId: "u-bob", ip: "198.51.100.1", peer: "10.0.0.1" }))).not.toBe(
      key,
    );
  });

  it("never falls back to the forwarded address: without a user it is the TCP peer", () => {
    const a = runsUserKey(req({ ip: "198.51.100.1", peer: "10.0.0.1" }));
    expect(a).toBe("peer:10.0.0.1");
    expect(runsUserKey(req({ ip: "198.51.100.99", peer: "10.0.0.1" }))).toBe(a);
    expect(runsUserKey(req({ ip: "198.51.100.1", peer: "10.0.0.2" }))).not.toBe(a);
  });
});

describe("runsPreAuthKey — nothing a caller chooses", () => {
  it("a token this server signed is its user, from the header or the cookie", () => {
    const { accessToken } = tokensFor("u-alice");
    expect(runsPreAuthKey(req({ authorization: `Bearer ${accessToken}` }))).toBe(
      "preauth:user:u-alice",
    );
    expect(runsPreAuthKey(req({ cookie: accessToken, peer: "10.9.9.9" }))).toBe(
      "preauth:user:u-alice",
    );
  });

  /** An access token this server signed for `userId`, which ran out `secondsAgo` ago. */
  const expiredFor = (userId: string, secondsAgo: number) => {
    const { accessToken } = tokensFor(userId);
    const payload = jwt.decode(accessToken) as Record<string, unknown>;
    const exp = Math.floor(Date.now() / 1000) - secondsAgo;
    // The same key `issueTokens` signs with under NODE_ENV=test.
    return jwt.sign({ ...payload, iat: exp - 3600, exp }, process.env.JWT_SECRET as string);
  };

  it("a token that has JUST expired is still its user's, so it reaches the 401 it refreshes on", () => {
    for (const secondsAgo of [1, 60, EXPIRED_ACCESS_TOKEN_KEY_GRACE_SECONDS - 5]) {
      const expired = expiredFor("u-alice", secondsAgo);
      expect(() => jwt.verify(expired, process.env.JWT_SECRET as string)).toThrow(/expired/);
      expect(runsPreAuthKey(req({ authorization: `Bearer ${expired}` }))).toBe(
        "preauth:user:u-alice",
      );
    }
  });

  it("#1117 — a token expired longer ago than the grace is no key of its own: it is the peer", () => {
    for (const secondsAgo of [EXPIRED_ACCESS_TOKEN_KEY_GRACE_SECONDS + 5, 86_400, 90 * 86_400]) {
      const stale = expiredFor("u-alice", secondsAgo);
      expect(signedAccessTokenUserId(stale)).toBeNull();
      expect(runsPreAuthKey(req({ authorization: `Bearer ${stale}`, peer: "10.0.0.1" }))).toBe(
        "preauth:peer:10.0.0.1",
      );
    }
    // A token from 1970 too — the old fixture of this test.
    const { accessToken } = tokensFor("u-alice");
    const ancient = jwt.sign(
      { ...(jwt.decode(accessToken) as Record<string, unknown>), iat: 1_000, exp: 2_000 },
      process.env.JWT_SECRET as string,
    );
    expect(signedAccessTokenUserId(ancient)).toBeNull();
  });

  it("the grace is long enough for the refresh round trip and no longer than one window", () => {
    expect(EXPIRED_ACCESS_TOKEN_KEY_GRACE_SECONDS).toBeGreaterThanOrEqual(60);
    expect(EXPIRED_ACCESS_TOKEN_KEY_GRACE_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it("a token we did NOT sign is no key of its own: every one of them is the peer", () => {
    const forged = jwt.sign({ userId: "u-alice", role: "admin" }, "x".repeat(40));
    const peer = runsPreAuthKey(req({ peer: "10.0.0.1" }));
    expect(peer).toBe("preauth:peer:10.0.0.1");
    for (const presented of [forged, "garbage", "a.b.c", `${forged}x`]) {
      expect(runsPreAuthKey(req({ authorization: `Bearer ${presented}`, peer: "10.0.0.1" }))).toBe(
        peer,
      );
    }
    // Nor can it be aimed with a forwarded address.
    expect(runsPreAuthKey(req({ ip: "198.51.100.7", peer: "10.0.0.1" }))).toBe(peer);
  });

  it("a refresh token is not an access token", () => {
    const { refreshToken } = tokensFor("u-alice");
    expect(signedAccessTokenUserId(refreshToken)).toBeNull();
    expect(runsPreAuthKey(req({ authorization: `Bearer ${refreshToken}`, peer: "10.0.0.1" }))).toBe(
      "preauth:peer:10.0.0.1",
    );
  });

  it("is never the user limiter's key for the same request (ERR_ERL_DOUBLE_COUNT)", () => {
    const { accessToken } = tokensFor("u-alice");
    const signedIn = req({ authorization: `Bearer ${accessToken}`, userId: "u-alice" });
    expect(runsPreAuthKey(signedIn)).not.toBe(runsUserKey(signedIn));
    const anonymous = req({ peer: "10.0.0.1" });
    expect(runsPreAuthKey(anonymous)).not.toBe(runsUserKey(anonymous));
  });
});

describe("defaults", () => {
  it("the pre-auth guard is coarser than the user budget", () => {
    expect(RUNS_USER_DEFAULT_MAX).toBe(3_000);
    expect(RUNS_PREAUTH_DEFAULT_MAX).toBeGreaterThan(RUNS_USER_DEFAULT_MAX);
  });
});

describe("#1117 runsPreAuthRateLimiter — what a spent guard answers", () => {
  // The limiter in front of a handler that would serve anything: whatever is
  // refused here is refused by the guard itself. supertest's peer is loopback.
  const app = express();
  app.get("/x", runsPreAuthRateLimiter, (_req, res) => {
    res.json({ served: true });
  });
  app.use(errorHandler);
  const call = (authorization?: string) => {
    const r = request(app).get("/x");
    return authorization ? r.set("Authorization", authorization) : r;
  };

  beforeAll(() => {
    process.env.RUNS_PREAUTH_LIMIT_MAX = "1";
  });
  // Spend the loopback peer's bucket in a per-test hook, never in `beforeAll`:
  // `tests/setup.ts` installs the supertest loopback spy in `beforeEach` and
  // `vi.restoreAllMocks()` drops it after each test, so a `beforeAll` request
  // leaves from 127.0.0.1 and a test's from ::1 — two different peers, and the
  // spend never counted (the first version passed only on retry).
  beforeEach(async () => {
    await call();
  });
  afterAll(() => {
    delete process.env.RUNS_PREAUTH_LIMIT_MAX;
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
      expect(res.headers["ratelimit-remaining"]).toBe("0");
    }
  });

  it("a signed-in user's spent bucket is 429 RUNS_RATE_LIMITED", async () => {
    const auth = `Bearer ${tokensFor("u-spent").accessToken}`;
    expect((await call(auth)).status).toBe(200);
    const res = await call(auth);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RUNS_RATE_LIMITED");
  });

  it("is never a way past the budget: a token requireAuth accepts but that names no user is 429", async () => {
    // Signed by this server, unexpired, but no `userId` claim: the key is the
    // peer, and `requireAuth` would accept it.
    const odd = jwt.sign({ role: "developer" }, process.env.JWT_SECRET as string, {
      expiresIn: 60,
    });
    expect(runsPreAuthKey(req({ authorization: `Bearer ${odd}`, peer: "10.0.0.1" }))).toBe(
      "preauth:peer:10.0.0.1",
    );
    const res = await call(`Bearer ${odd}`);
    expect(res.status).toBe(429);
    expect(res.body).not.toHaveProperty("served");
  });
});
