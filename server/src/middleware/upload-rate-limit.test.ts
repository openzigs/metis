/**
 * #1985 — the rule-extraction retry limiter is the upload limiter's tuning in a
 * bucket of its own: exhausting one leaves the other open, and each refusal
 * names what was refused. Real limiters with a ceiling of one per window, on the
 * `shared` backend: one counter store for every limiter, as on a cluster
 * (`postgres`, `valkey`), so only the store prefix keeps the buckets apart. (The
 * default `memory` backend gives each limiter a private store, which would pass
 * with the two limiters sharing a prefix.)
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let app: express.Express;

beforeAll(async () => {
  vi.stubEnv("UPLOAD_RATE_LIMIT_MAX", "1");
  vi.stubEnv("DISCUSSION_RATE_LIMIT_BACKEND", "shared");
  vi.resetModules();
  const { uploadRateLimiter, extractionRetryRateLimiter } = await import("./upload-rate-limit.js");
  app = express();
  app.post("/upload", uploadRateLimiter, (_req, res) => {
    res.status(201).end();
  });
  app.post("/retry", extractionRetryRateLimiter, (_req, res) => {
    res.status(202).end();
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("extractionRetryRateLimiter", () => {
  it("counts in its own bucket, with its own message", async () => {
    expect((await request(app).post("/upload")).status).toBe(201);
    const refusedUpload = await request(app).post("/upload");
    expect(refusedUpload.status).toBe(429);
    expect(refusedUpload.body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Too many uploads — please slow down",
    });

    // The upload bucket is spent; a retry is still allowed once.
    expect((await request(app).post("/retry")).status).toBe(202);
    const refusedRetry = await request(app).post("/retry");
    expect(refusedRetry.status).toBe(429);
    expect(refusedRetry.body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Too many rule-extraction retries — please slow down",
    });
  });
});
