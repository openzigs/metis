/**
 * #1007 — the `/api/runs` limiters: what each one's KEY is. Which limiter sits
 * on which route, and in what order relative to `requireAuth`, is asserted on
 * the REAL router in `tests/runs-chat-turns-route.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens, signedAccessTokenUserId } from "../lib/auth/jwt.js";
import {
  RUNS_PREAUTH_DEFAULT_MAX,
  RUNS_USER_DEFAULT_MAX,
  runsPreAuthKey,
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
    expect(runsPreAuthKey(req({ authorization: `Bearer ${accessToken}` }))).toBe("user:u-alice");
    expect(runsPreAuthKey(req({ cookie: accessToken, peer: "10.9.9.9" }))).toBe("user:u-alice");
  });

  it("an EXPIRED token we signed is still its user's, so it reaches the 401 it refreshes on", () => {
    const { accessToken } = tokensFor("u-alice");
    const payload = jwt.decode(accessToken) as Record<string, unknown>;
    const expired = jwt.sign(
      { ...payload, iat: 1_000, exp: 2_000 },
      // The same key `issueTokens` signs with under NODE_ENV=test.
      process.env.JWT_SECRET as string,
    );
    expect(() => jwt.verify(expired, process.env.JWT_SECRET as string)).toThrow(/expired/);
    expect(runsPreAuthKey(req({ authorization: `Bearer ${expired}` }))).toBe("user:u-alice");
  });

  it("a token we did NOT sign is no key of its own: every one of them is the peer", () => {
    const forged = jwt.sign({ userId: "u-alice", role: "admin" }, "x".repeat(40));
    const peer = runsPreAuthKey(req({ peer: "10.0.0.1" }));
    expect(peer).toBe("peer:10.0.0.1");
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
      "peer:10.0.0.1",
    );
  });
});

describe("defaults", () => {
  it("the pre-auth guard is coarser than the user budget", () => {
    expect(RUNS_USER_DEFAULT_MAX).toBe(3_000);
    expect(RUNS_PREAUTH_DEFAULT_MAX).toBeGreaterThan(RUNS_USER_DEFAULT_MAX);
  });
});
