/**
 * #1059 — the Spec Kit job-endpoint limiters: reads and writes have separate
 * budgets, the two that run ahead of `requireAuth` key by client address, and
 * the one after it keys by user. The limiters are module-level (CodeQL must see
 * the `rateLimit()` result), so each budget is shared across tests in this
 * file: every test uses its own address or user.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// As with more than one replica: every limiter counts on ONE shared backend,
// where only a limiter's own store prefix keeps its counters from another's.
// (The default backend gives each limiter a private store, which would hide two
// limiters sharing a prefix.) Set before the first request resolves the backend.
vi.hoisted(() => {
  process.env.DISCUSSION_RATE_LIMIT_BACKEND = "shared";
});
import express from "express";
import request from "supertest";

import {
  SPECKIT_JOB_DEFAULT_MAX,
  SPECKIT_JOB_USER_WRITE_DEFAULT_MAX,
  SPECKIT_JOB_WRITE_DEFAULT_MAX,
  specKitJobReadRateLimiter,
  specKitJobUserWriteRateLimiter,
  specKitJobWriteRateLimiter,
} from "./spec-kit-job-rate-limit.js";

/** The route shape of `routes/spec-kit.ts`, with a header standing in for `requireAuth`. */
function app() {
  const a = express();
  // As `app.ts`: trust one proxy hop, so `req.ip` is the last X-Forwarded-For entry.
  a.set("trust proxy", 1);
  const auth: express.RequestHandler = (req, _res, next) => {
    const userId = req.header("x-test-user");
    if (userId) (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  };
  const ok: express.RequestHandler = (_req, res) => {
    res.json({ success: true });
  };
  a.get("/jobs/:jobId", specKitJobReadRateLimiter, auth, ok);
  a.post(
    "/jobs/:jobId/cancel",
    specKitJobWriteRateLimiter,
    auth,
    specKitJobUserWriteRateLimiter,
    ok,
  );
  return a;
}
const poll = (a: express.Express, from: string) =>
  request(a).get("/jobs/a").set("X-Forwarded-For", from);
const cancel = (a: express.Express, from: string, user?: string) => {
  const req = request(a).post("/jobs/a/cancel").set("X-Forwarded-For", from);
  return user ? req.set("x-test-user", user) : req;
};

afterEach(() => {
  delete process.env.SPECKIT_JOB_LIMIT_MAX;
  delete process.env.SPECKIT_JOB_WRITE_LIMIT_MAX;
  delete process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX;
});

describe("specKitJobReadRateLimiter", () => {
  it("caps by client address at SPECKIT_JOB_LIMIT_MAX, with the standard envelope", async () => {
    process.env.SPECKIT_JOB_LIMIT_MAX = "2";
    const a = app();
    expect((await poll(a, "198.51.100.1")).status).toBe(200);
    // Another job id is the same budget: the key is the address, not the job.
    expect((await request(a).get("/jobs/b").set("X-Forwarded-For", "198.51.100.1")).status).toBe(
      200,
    );
    const limited = await poll(a, "198.51.100.1");
    expect(limited.status).toBe(429);
    expect(limited.body.success).toBe(false);
    expect(limited.body.error.code).toBe("SPECKIT_JOB_RATE_LIMITED");
    // Another address has its own budget.
    expect((await poll(a, "198.51.100.2")).status).toBe(200);
  });

  it("keys on the LAST forwarded address: the hop the trusted proxy reports", async () => {
    process.env.SPECKIT_JOB_LIMIT_MAX = "1";
    const a = app();
    // The same real client behind two different spoofed first entries is one bucket…
    expect((await poll(a, "203.0.113.9, 198.51.100.3")).status).toBe(200);
    expect((await poll(a, "203.0.113.77, 198.51.100.3")).status).toBe(429);
    // …and a different last entry is another.
    expect((await poll(a, "203.0.113.9, 198.51.100.4")).status).toBe(200);
  });

  it.each(["not-a-number", "0", "-5"])(
    "falls back to the default cap for the setting %s",
    async (value) => {
      process.env.SPECKIT_JOB_LIMIT_MAX = value;
      const a = app();
      expect((await poll(a, "198.51.100.5")).status).toBe(200);
      expect((await poll(a, "198.51.100.5")).status).toBe(200);
    },
  );

  it("allows a page to poll every 3 seconds for the whole window, twenty times over", () => {
    const pollsPerWindow = (15 * 60) / 3;
    expect(SPECKIT_JOB_DEFAULT_MAX).toBeGreaterThanOrEqual(pollsPerWindow * 20);
  });
});

describe("reads and writes do not share a budget", () => {
  // On the shared backend two limiters with one prefix add each other's hits.
  it("does not count a poll against the budget for cancelling", async () => {
    process.env.SPECKIT_JOB_WRITE_LIMIT_MAX = "2";
    const a = app();
    for (let i = 0; i < 6; i += 1) {
      expect((await poll(a, "198.51.100.12")).status).toBe(200);
    }
    // Six polls later the address has still made no write.
    expect((await cancel(a, "198.51.100.12", "u-count-1")).status).toBe(200);
    expect((await cancel(a, "198.51.100.12", "u-count-2")).status).toBe(200);
    expect((await cancel(a, "198.51.100.12", "u-count-3")).status).toBe(429);
  });

  it("does not count a user's write against that address's write budget twice", async () => {
    // The per-address and the per-user write limiters are separate counters too.
    process.env.SPECKIT_JOB_WRITE_LIMIT_MAX = "3";
    process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX = "3";
    const a = app();
    for (const user of ["u-twice-1", "u-twice-2", "u-twice-3"]) {
      expect((await cancel(a, "198.51.100.13", user)).status).toBe(200);
    }
  });

  it("still accepts a cancel from an address whose polling budget is spent", async () => {
    process.env.SPECKIT_JOB_LIMIT_MAX = "1";
    const a = app();
    expect((await poll(a, "198.51.100.10")).status).toBe(200);
    expect((await poll(a, "198.51.100.10")).status).toBe(429);

    expect((await cancel(a, "198.51.100.10", "u-polling")).status).toBe(200);
  });

  it("still accepts a poll from an address whose write budget is spent", async () => {
    process.env.SPECKIT_JOB_WRITE_LIMIT_MAX = "1";
    const a = app();
    expect((await cancel(a, "198.51.100.11", "u-w1")).status).toBe(200);
    const limited = await cancel(a, "198.51.100.11", "u-w2");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("SPECKIT_JOB_RATE_LIMITED");

    expect((await poll(a, "198.51.100.11")).status).toBe(200);
  });
});

describe("specKitJobUserWriteRateLimiter", () => {
  it("caps each authenticated user separately, whatever address they share", async () => {
    process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX = "2";
    const a = app();
    // Two users behind ONE address.
    expect((await cancel(a, "198.51.100.20", "u-alice")).status).toBe(200);
    expect((await cancel(a, "198.51.100.20", "u-alice")).status).toBe(200);
    const limited = await cancel(a, "198.51.100.20", "u-alice");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("SPECKIT_JOB_RATE_LIMITED");
    // Alice spending her budget costs Bob nothing…
    expect((await cancel(a, "198.51.100.20", "u-bob")).status).toBe(200);
    // …and Alice is still limited from another address.
    expect((await cancel(a, "198.51.100.21", "u-alice")).status).toBe(429);
  });

  it("falls back to the address when no user is set", async () => {
    process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX = "1";
    const a = app();
    expect((await cancel(a, "198.51.100.30")).status).toBe(200);
    expect((await cancel(a, "198.51.100.30")).status).toBe(429);
    expect((await cancel(a, "198.51.100.31")).status).toBe(200);
  });

  it("leaves room for ordinary use and stays below the address budgets", () => {
    expect(SPECKIT_JOB_USER_WRITE_DEFAULT_MAX).toBeGreaterThanOrEqual(60);
    expect(SPECKIT_JOB_USER_WRITE_DEFAULT_MAX).toBeLessThan(SPECKIT_JOB_WRITE_DEFAULT_MAX);
    expect(SPECKIT_JOB_WRITE_DEFAULT_MAX).toBeLessThan(SPECKIT_JOB_DEFAULT_MAX);
  });
});
