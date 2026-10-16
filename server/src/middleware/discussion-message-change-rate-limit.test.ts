/**
 * #734 — the discussion message edit/delete limiters. The budget is the
 * signed-in user's: nothing a caller writes into a header (`X-Forwarded-For`,
 * a forged token) can dodge it or spend someone else's. Mirrors
 * `runs-rate-limit.ts` (#1007). The limiters are module-level (CodeQL must see
 * the `rateLimit()` result), so each test uses its own users.
 */
import { afterEach, describe, expect, it } from "vitest";
import express, { type Request } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens, signedAccessTokenUserId } from "../lib/auth/jwt.js";
import {
  DISCUSSION_MESSAGE_CHANGE_DEFAULT_MAX,
  DISCUSSION_MESSAGE_CHANGE_PREAUTH_DEFAULT_MAX,
  discussionMessageChangePreAuthKey,
  discussionMessageChangePreAuthRateLimiter,
  discussionMessageChangeUserKey,
  discussionMessageChangeUserRateLimiter,
} from "./discussion-message-change-rate-limit.js";

const tokenFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;

/**
 * The production order: pre-auth limiter, auth, user limiter, handler — behind
 * `trust proxy = 1`, so `req.ip` IS the client-supplied `X-Forwarded-For`.
 * The stand-in auth admits only a token this server signed.
 */
function app() {
  const a = express();
  a.set("trust proxy", 1);
  a.patch(
    "/message",
    discussionMessageChangePreAuthRateLimiter,
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
    discussionMessageChangeUserRateLimiter,
    (_req, res) => {
      res.status(200).json({ success: true });
    },
  );
  return a;
}

afterEach(() => {
  delete process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX;
  delete process.env.DISCUSSION_MESSAGE_CHANGE_PREAUTH_LIMIT_MAX;
});

describe("discussion message change limiters — end to end", () => {
  it("caps a user at DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX with the standard envelope", async () => {
    process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX = "2";
    const a = app();
    const auth = `Bearer ${tokenFor("u-cap")}`;
    expect((await request(a).patch("/message").set("Authorization", auth)).status).toBe(200);
    expect((await request(a).patch("/message").set("Authorization", auth)).status).toBe(200);
    const limited = await request(a).patch("/message").set("Authorization", auth);
    expect(limited.status).toBe(429);
    expect(limited.body.success).toBe(false);
    expect(limited.body.error.code).toBe("DISCUSSION_MESSAGE_CHANGE_RATE_LIMITED");
  });

  it("rotating X-Forwarded-For does not reset a user's budget", async () => {
    process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX = "3";
    const a = app();
    const auth = `Bearer ${tokenFor("u-rotate")}`;
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await request(a)
        .patch("/message")
        .set("Authorization", auth)
        .set("X-Forwarded-For", `198.51.100.${i}`);
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("a forged header cannot exhaust another user's budget", async () => {
    process.env.DISCUSSION_MESSAGE_CHANGE_PREAUTH_LIMIT_MAX = "3";
    process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX = "3";
    const a = app();
    const forged = jwt.sign({ userId: "u-victim", role: "admin" }, "x".repeat(40));
    // The attacker claims the victim's address and presents a token naming them.
    for (let i = 0; i < 10; i++) {
      await request(a)
        .patch("/message")
        .set("Authorization", `Bearer ${forged}`)
        .set("X-Forwarded-For", "203.0.113.9");
    }
    const victim = await request(a)
      .patch("/message")
      .set("Authorization", `Bearer ${tokenFor("u-victim")}`)
      .set("X-Forwarded-For", "203.0.113.9");
    expect(victim.status).toBe(200);
  });

  it("falls back to the default caps for a malformed setting", async () => {
    process.env.DISCUSSION_MESSAGE_CHANGE_LIMIT_MAX = "not-a-number";
    process.env.DISCUSSION_MESSAGE_CHANGE_PREAUTH_LIMIT_MAX = "-4";
    const res = await request(app())
      .patch("/message")
      .set("Authorization", `Bearer ${tokenFor("u-default")}`);
    expect(res.status).toBe(200);
    expect(DISCUSSION_MESSAGE_CHANGE_PREAUTH_DEFAULT_MAX).toBeGreaterThan(
      DISCUSSION_MESSAGE_CHANGE_DEFAULT_MAX,
    );
  });
});

/** A request as a key function sees it; `ip` is what a forwarded header would make it. */
const req = (over: {
  ip?: string;
  authorization?: string;
  cookie?: string;
  userId?: string;
  peer?: string;
}): Request =>
  ({
    ip: over.ip ?? "203.0.113.200",
    headers: over.authorization ? { authorization: over.authorization } : {},
    cookies: over.cookie ? { accessToken: over.cookie } : {},
    user: over.userId ? { userId: over.userId } : undefined,
    socket: { remoteAddress: over.peer ?? "10.0.0.5", remoteFamily: "IPv4" },
  }) as unknown as Request;

describe("keys — nothing a caller chooses", () => {
  it("the user key is the signed-in user, else the TCP peer, never the forwarded address", () => {
    expect(discussionMessageChangeUserKey(req({ userId: "u1", ip: "198.51.100.1" }))).toBe(
      "user:u1",
    );
    expect(discussionMessageChangeUserKey(req({ ip: "198.51.100.1", peer: "10.0.0.1" }))).toBe(
      "peer:10.0.0.1",
    );
    expect(discussionMessageChangeUserKey(req({ ip: "198.51.100.99", peer: "10.0.0.1" }))).toBe(
      "peer:10.0.0.1",
    );
  });

  it("the pre-auth key is a signed token's user (header or cookie), else the peer", () => {
    const token = tokenFor("u-key");
    expect(discussionMessageChangePreAuthKey(req({ authorization: `Bearer ${token}` }))).toBe(
      "preauth:user:u-key",
    );
    expect(discussionMessageChangePreAuthKey(req({ cookie: token }))).toBe("preauth:user:u-key");
    const forged = jwt.sign({ userId: "u-key" }, "y".repeat(40));
    expect(
      discussionMessageChangePreAuthKey(
        req({ authorization: `Bearer ${forged}`, peer: "10.0.0.1" }),
      ),
    ).toBe("preauth:peer:10.0.0.1");
    expect(
      discussionMessageChangePreAuthKey(req({ authorization: "Bearer ", peer: "10.0.0.1" })),
    ).toBe("preauth:peer:10.0.0.1");
  });

  it("never gives both limiters the same key for one request", () => {
    const signedIn = req({ authorization: `Bearer ${tokenFor("u-dc")}`, userId: "u-dc" });
    expect(discussionMessageChangePreAuthKey(signedIn)).not.toBe(
      discussionMessageChangeUserKey(signedIn),
    );
  });
});
