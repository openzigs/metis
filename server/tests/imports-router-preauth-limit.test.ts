/**
 * PR #850 CI — `importsRouter()` runs its per-IP limiter AHEAD of `requireAuth`
 * (CodeQL js/missing-rate-limiting alerts 541/542 on the #763 secret-authorising
 * routes): once the cap is spent an unauthenticated caller gets 429, not 401.
 * Real router, real auth, real limiter; the import service is never reached.
 */
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { importsRouter } from "../src/routes/imports.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import type { ImportService } from "../src/lib/importers/import-service.js";

afterAll(() => {
  delete process.env.IMPORTS_PREAUTH_RATE_LIMIT_MAX;
});

describe("importsRouter — pre-auth limiter order", () => {
  it("throttles an unauthenticated caller before auth rejects it", async () => {
    process.env.IMPORTS_PREAUTH_RATE_LIMIT_MAX = "1";
    const a = express();
    a.use(express.json());
    a.use("/api/projects/:projectId/imports", importsRouter({} as ImportService));
    a.use(errorHandler);

    const first = await request(a).post("/api/projects/p1/imports/preview").send({});
    expect(first.status).toBe(401);
    const second = await request(a).post("/api/projects/p1/imports/preview").send({});
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("IMPORTS_RATE_LIMITED");
  });
});
