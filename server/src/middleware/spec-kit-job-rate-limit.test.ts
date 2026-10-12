/**
 * #1059 — the Spec Kit job-endpoint limiters: what each one's KEY is, and that
 * no two of them share a counter.
 *
 * Which limiter sits on which endpoint, and in what order relative to
 * `requireAuth`, is asserted on the REAL router in
 * `tests/spec-kit-jobs-1059.sqlite.test.ts` — not on a copy of the wiring here.
 *
 * The limiters are module-level (CodeQL must see the `rateLimit()` result), so
 * each budget is shared across the tests of this file: every test uses its own
 * user or token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// As with more than one replica: every limiter counts on ONE shared backend,
// where only a limiter's own store prefix keeps its counters from another's.
// (The default backend gives each limiter a private store, which would hide two
// limiters sharing a prefix.) Set before the first request resolves the backend.
vi.hoisted(() => {
  process.env.DISCUSSION_RATE_LIMIT_BACKEND = "shared";
});
import express, { type Request } from "express";
import request from "supertest";

import {
  SPECKIT_JOB_DEFAULT_MAX,
  SPECKIT_JOB_PREAUTH_DEFAULT_MAX,
  SPECKIT_JOB_USER_WRITE_DEFAULT_MAX,
  specKitJobPreAuthKey,
  specKitJobPreAuthRateLimiter,
  specKitJobUserKey,
  specKitJobUserReadRateLimiter,
  specKitJobUserWriteRateLimiter,
} from "./spec-kit-job-rate-limit.js";

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

afterEach(() => {
  delete process.env.SPECKIT_JOB_LIMIT_MAX;
  delete process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX;
  delete process.env.SPECKIT_JOB_PREAUTH_LIMIT_MAX;
});

describe("specKitJobUserKey — the budgets are the signed-in user's", () => {
  it("is the user, whatever address the request claims or comes from", () => {
    const key = specKitJobUserKey(req({ userId: "u-alice", ip: "198.51.100.1", peer: "10.0.0.1" }));
    expect(key).toBe("user:u-alice");
    expect(
      specKitJobUserKey(req({ userId: "u-alice", ip: "198.51.100.2", peer: "10.0.0.2" })),
    ).toBe(key);
    expect(
      specKitJobUserKey(req({ userId: "u-bob", ip: "198.51.100.1", peer: "10.0.0.1" })),
    ).not.toBe(key);
  });

  it("never falls back to the forwarded address: without a user it is the TCP peer", () => {
    const a = specKitJobUserKey(req({ ip: "198.51.100.1", peer: "10.0.0.1" }));
    expect(a).toBe("peer:10.0.0.1");
    // A different claimed address is the same key; a different peer is another.
    expect(specKitJobUserKey(req({ ip: "198.51.100.99", peer: "10.0.0.1" }))).toBe(a);
    expect(specKitJobUserKey(req({ ip: "198.51.100.1", peer: "10.0.0.2" }))).not.toBe(a);
  });
});

describe("specKitJobPreAuthKey — nothing a caller can aim at somebody else", () => {
  it("is a digest of the presented token, from the header or the cookie, never the token", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const fromHeader = specKitJobPreAuthKey(req({ authorization: `Bearer ${token}` }));
    expect(fromHeader).toMatch(/^cred:[0-9a-f]{32}$/);
    expect(fromHeader).not.toContain("payload");
    expect(specKitJobPreAuthKey(req({ cookie: token }))).toBe(fromHeader);
    expect(specKitJobPreAuthKey(req({ authorization: "Bearer another.token.value" }))).not.toBe(
      fromHeader,
    );
  });

  it("does not move with the claimed address: a victim's address buys nothing", () => {
    const token = "Bearer a.b.c";
    expect(specKitJobPreAuthKey(req({ authorization: token, ip: "198.51.100.1" }))).toBe(
      specKitJobPreAuthKey(req({ authorization: token, ip: "198.51.100.2" })),
    );
    // No token: the TCP peer, whatever X-Forwarded-For says.
    const anonymous = specKitJobPreAuthKey(req({ ip: "198.51.100.1", peer: "10.0.0.7" }));
    expect(anonymous).toBe("peer:10.0.0.7");
    expect(specKitJobPreAuthKey(req({ ip: "198.51.100.2", peer: "10.0.0.7" }))).toBe(anonymous);
    expect(specKitJobPreAuthKey(req({ authorization: "Bearer ", peer: "10.0.0.7" }))).toBe(
      anonymous,
    );
  });
});

describe("the three limiters count separately", () => {
  /** Each limiter alone on a path, with a header standing in for `requireAuth`. */
  function app() {
    const a = express();
    a.set("trust proxy", 1);
    a.use((r, _res, next) => {
      const userId = r.header("x-test-user");
      if (userId) (r as unknown as { user: { userId: string } }).user = { userId };
      next();
    });
    const ok: express.RequestHandler = (_req, res) => {
      res.json({ success: true });
    };
    a.get("/read", specKitJobUserReadRateLimiter, ok);
    a.post("/write", specKitJobUserWriteRateLimiter, ok);
    a.get("/pre", specKitJobPreAuthRateLimiter, ok);
    return a;
  }
  const as = (r: request.Test, user: string) => r.set("x-test-user", user);

  it("caps reads per user at SPECKIT_JOB_LIMIT_MAX, with the standard envelope", async () => {
    process.env.SPECKIT_JOB_LIMIT_MAX = "2";
    const a = app();
    expect((await as(request(a).get("/read"), "u-r1")).status).toBe(200);
    // A different claimed address is the same budget.
    expect(
      (await as(request(a).get("/read"), "u-r1").set("X-Forwarded-For", "198.51.100.9")).status,
    ).toBe(200);
    const limited = await as(request(a).get("/read"), "u-r1").set(
      "X-Forwarded-For",
      "198.51.100.10",
    );
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({
      success: false,
      error: { code: "SPECKIT_JOB_RATE_LIMITED" },
    });
    expect((await as(request(a).get("/read"), "u-r2")).status).toBe(200);
  });

  it("does not count a read against the same user's writes, or the reverse", async () => {
    process.env.SPECKIT_JOB_LIMIT_MAX = "1";
    process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX = "1";
    const a = app();
    expect((await as(request(a).get("/read"), "u-sep")).status).toBe(200);
    expect((await as(request(a).get("/read"), "u-sep")).status).toBe(429);
    expect((await as(request(a).post("/write"), "u-sep")).status).toBe(200);
    expect((await as(request(a).post("/write"), "u-sep")).status).toBe(429);
  });

  it("does not count the pre-auth guard against either user budget", async () => {
    process.env.SPECKIT_JOB_PREAUTH_LIMIT_MAX = "1";
    process.env.SPECKIT_JOB_LIMIT_MAX = "1";
    const a = app();
    const pre = () => request(a).get("/pre").set("Authorization", "Bearer sep.token.one");
    expect((await pre()).status).toBe(200);
    expect((await pre()).status).toBe(429);
    // Another token is another bucket.
    expect((await request(a).get("/pre").set("Authorization", "Bearer sep.token.two")).status).toBe(
      200,
    );
    expect((await as(request(a).get("/read"), "u-sep-pre")).status).toBe(200);
  });

  it.each(["not-a-number", "0", "-5"])(
    "falls back to the default cap for the setting %s",
    async (value) => {
      process.env.SPECKIT_JOB_LIMIT_MAX = value;
      const a = app();
      expect((await as(request(a).get("/read"), `u-bad-${value}`)).status).toBe(200);
      expect((await as(request(a).get("/read"), `u-bad-${value}`)).status).toBe(200);
    },
  );
});

describe("the default caps", () => {
  it("let a page poll every 3 seconds for the whole window, twenty times over", () => {
    const pollsPerWindow = (15 * 60) / 3;
    expect(SPECKIT_JOB_DEFAULT_MAX).toBeGreaterThanOrEqual(pollsPerWindow * 20);
  });

  it("leave room for ordinary starting and cancelling", () => {
    expect(SPECKIT_JOB_USER_WRITE_DEFAULT_MAX).toBeGreaterThanOrEqual(60);
  });

  it("keep the pre-auth guard above everything one signed-in user may send", () => {
    expect(SPECKIT_JOB_PREAUTH_DEFAULT_MAX).toBeGreaterThan(
      SPECKIT_JOB_DEFAULT_MAX + SPECKIT_JOB_USER_WRITE_DEFAULT_MAX,
    );
  });
});
