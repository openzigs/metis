/**
 * #1059 — the Spec Kit job-endpoint limiter: caps per client address with the
 * standard envelope, and reads the cap per request. It runs ahead of
 * `requireAuth`, so it never sees a user and always keys by IP. The limiter is
 * module-level (CodeQL must see the `rateLimit()` result), so the budget is
 * shared across tests in this file.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { SPECKIT_JOB_DEFAULT_MAX, specKitJobRateLimiter } from "./spec-kit-job-rate-limit.js";

function app() {
  const a = express();
  a.get("/jobs/:jobId", specKitJobRateLimiter, (_req, res) => {
    res.json({ success: true });
  });
  return a;
}

afterEach(() => {
  delete process.env.SPECKIT_JOB_LIMIT_MAX;
});

describe("specKitJobRateLimiter", () => {
  it("caps by client address at SPECKIT_JOB_LIMIT_MAX, with the standard envelope", async () => {
    process.env.SPECKIT_JOB_LIMIT_MAX = "2";
    const a = app();
    expect((await request(a).get("/jobs/a")).status).toBe(200);
    // Another job id is the same budget: the key is the address, not the job.
    expect((await request(a).get("/jobs/b")).status).toBe(200);
    const limited = await request(a).get("/jobs/a");
    expect(limited.status).toBe(429);
    expect(limited.body.success).toBe(false);
    expect(limited.body.error.code).toBe("SPECKIT_JOB_RATE_LIMITED");
  });

  it.each(["not-a-number", "0", "-5"])(
    "falls back to the default cap for the setting %s",
    async (value) => {
      process.env.SPECKIT_JOB_LIMIT_MAX = value;
      // Earlier tests left this address a few hits in; the default is far above.
      expect((await request(app()).get("/jobs/a")).status).toBe(200);
    },
  );

  it("allows a page to poll every 3 seconds for the whole window, twenty times over", () => {
    const pollsPerWindow = (15 * 60) / 3;
    expect(SPECKIT_JOB_DEFAULT_MAX).toBeGreaterThanOrEqual(pollsPerWindow * 20);
  });
});
