/**
 * PR #850 review — `publishingRouter()` runs its per-IP limiter AHEAD of
 * `requireAuth` (CodeQL js/missing-rate-limiting, #815): an unauthenticated
 * flood is throttled before JWT verification, so once the cap is spent the
 * answer is 429, not 401. Real router, real auth, real limiter.
 */
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { publishingRouter } from "../src/routes/publishing.js";
import { errorHandler } from "../src/middleware/error-handler.js";

afterAll(() => {
  delete process.env.PUBLISHING_PREAUTH_RATE_LIMIT_MAX;
});

describe("publishingRouter — pre-auth limiter order", () => {
  it("throttles an unauthenticated caller before auth rejects it", async () => {
    process.env.PUBLISHING_PREAUTH_RATE_LIMIT_MAX = "1";
    const a = express();
    a.use(express.json());
    a.use("/api/projects/:projectId/publishing", publishingRouter());
    a.use(errorHandler);

    const first = await request(a).get("/api/projects/p1/publishing/drafts");
    expect(first.status).toBe(401);
    const second = await request(a).get("/api/projects/p1/publishing/drafts");
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("PUBLISHING_RATE_LIMITED");
  });
});
