/**
 * #1837 review — `requirementSimilarityRouter()` is mounted at
 * `/projects/:projectId/requirements` AHEAD of `stakeholdersRouter()`, so its
 * middleware must be scoped to the similarity routes. A router-level `r.use()`
 * ran the similarity pre-auth limiter (and `requireAuth` / `requireProjectAccess`)
 * on every `/requirements/:requirementId/stakeholders*` request too, which then
 * drew from the similarity bucket.
 *
 * Each test uses its own client IP (`X-Forwarded-For` behind one trusted proxy
 * hop), so the shared limiter's counters never cross tests.
 */
import express, { Router } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return { prisma: {}, Prisma };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { requirementSimilarityRouter } = await import("../src/routes/requirement-similarity.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");

/** Stands in for `stakeholdersRouter()`, mounted after the similarity router as in `routes/index.ts`. */
function stakeholderStub(): Router {
  const r = Router({ mergeParams: true });
  r.get("/requirements/:requirementId/stakeholders", (_req, res) => {
    res.json({ success: true, data: [] });
  });
  return r;
}

const app = () => {
  const a = express();
  a.set("trust proxy", 1);
  a.use(express.json());
  a.use("/api/projects/:projectId/requirements", requirementSimilarityRouter());
  a.use("/api/projects/:projectId", stakeholderStub());
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
};

describe("#1837 — the similarity middleware is scoped to the similarity routes", () => {
  afterEach(() => {
    delete process.env.REQUIREMENT_SIMILARITY_RATE_LIMIT_MAX;
  });

  it("a stakeholder request passes straight through, untouched by the similarity limiter", async () => {
    process.env.REQUIREMENT_SIMILARITY_RATE_LIMIT_MAX = "2";
    const ip = "198.51.100.71";
    for (let i = 0; i < 4; i++) {
      const res = await request(app())
        .get("/api/projects/p1/requirements/r1/stakeholders")
        .set("X-Forwarded-For", ip);
      // Reaches the stakeholder router: no similarity auth, no similarity limiter headers.
      expect(res.status).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBeUndefined();
    }
    // The similarity bucket for this IP is untouched: its first two calls are
    // refused by auth (401), not by the limiter (429).
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push(
        (
          await request(app())
            .get("/api/projects/p1/requirements/r1/similar")
            .set("X-Forwarded-For", ip)
        ).status,
      );
    }
    expect(codes).toEqual([401, 401, 429]);
  });

  it("both similarity routes are still limited before auth", async () => {
    process.env.REQUIREMENT_SIMILARITY_RATE_LIMIT_MAX = "1";
    const ip = "198.51.100.72";
    const post = await request(app())
      .post("/api/projects/p1/requirements/similar")
      .set("X-Forwarded-For", ip)
      .send({ text: "x" });
    expect(post.status).toBe(401);
    const get = await request(app())
      .get("/api/projects/p1/requirements/r1/similar")
      .set("X-Forwarded-For", ip);
    expect(get.status).toBe(429);
    expect(get.body.error?.code).toBe("REQUIREMENT_SIMILARITY_RATE_LIMITED");
  });

  it("the #1838 not-duplicate route carries the same guard (limiter, auth, project access)", async () => {
    process.env.REQUIREMENT_SIMILARITY_RATE_LIMIT_MAX = "1";
    const ip = "198.51.100.73";
    const url = "/api/projects/p1/requirements/r1/similar/r2/not-duplicate";
    // The first call is refused by `requireAuth`, the second by the limiter: both
    // only happen if the guard runs ahead of the handler.
    const first = await request(app()).post(url).set("X-Forwarded-For", ip);
    expect(first.status).toBe(401);
    const second = await request(app()).post(url).set("X-Forwarded-For", ip);
    expect(second.status).toBe(429);
    expect(second.body.error?.code).toBe("REQUIREMENT_SIMILARITY_RATE_LIMITED");
  });
});
