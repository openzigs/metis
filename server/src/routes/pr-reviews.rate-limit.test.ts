/**
 * #1472 — `prReviewsRouter()` runs its own rate limiters ahead of its
 * project-scope guard (CodeQL js/missing-rate-limiting). Mounts the REAL router
 * and the REAL limiters; only auth and Prisma are stubbed. Separate file because
 * the limiters are module-level: a cap set here must not throttle the other
 * route tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUserId = "u-1472-wiring";

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    // The project-scope guard's lookup: a live project in the caller's workspace.
    project: {
      findUnique: vi.fn(async () => ({
        workspaceId: "ws-1472",
        deletedAt: null,
        workspace: { deletedAt: null, members: [{ id: "member-row" }] },
      })),
    },
    prReviewState: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => null),
    },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, _res: any, next: any) => {
    // A workspace coordinator: passes the real scope guard and the real role
    // gates (read and manage), so only the limiters can refuse.
    req.user = {
      userId: currentUserId,
      role: "coordinator",
      permissions: [],
      workspaces: ["ws-1472"],
    };
    next();
  },
}));

const { prReviewsRouter } = await import("./pr-reviews.js");
const { errorHandler, notFoundHandler } = await import("../middleware/error-handler.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/projects/:projectId/pr-reviews", prReviewsRouter());
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

afterEach(() => {
  delete process.env.PR_REVIEWS_LIMIT_MAX;
});

describe("prReviewsRouter rate limiting (#1472)", () => {
  it("throttles a user past PR_REVIEWS_LIMIT_MAX on the list, with the router's own code", async () => {
    process.env.PR_REVIEWS_LIMIT_MAX = "1";
    currentUserId = "u-1472-wiring-list";
    const a = app();
    expect((await request(a).get("/api/projects/p1/pr-reviews")).status).toBe(200);
    const limited = await request(a).get("/api/projects/p1/pr-reviews");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("PR_REVIEWS_RATE_LIMITED");
  });

  it("counts the detail and re-review against the same per-user budget", async () => {
    process.env.PR_REVIEWS_LIMIT_MAX = "1";
    currentUserId = "u-1472-wiring-detail";
    const a = app();
    const first = await request(a).get("/api/projects/p1/pr-reviews/3?owner=o&repo=r");
    expect(first.status).toBe(404); // no row: past the limiter, into the handler
    const second = await request(a)
      .post("/api/projects/p1/pr-reviews/3/re-review")
      .send({ owner: "o", repo: "r" });
    expect(second.status).toBe(429);
  });
});
