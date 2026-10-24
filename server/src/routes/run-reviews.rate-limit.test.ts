/**
 * #1497 — `GET /api/run-reviews/:runId` runs the PR-review read limiters: the
 * pre-auth one ahead of `requireAuth` (the only placement CodeQL
 * js/missing-rate-limiting counts) and the per-user one after it. Every role
 * holds `pr.review.read` since #1472, so the caller here is a workspace READER:
 * it passes the real role gate and the real project-scope check, so only a
 * limiter can refuse. Mounts the REAL routers and limiters; only auth and
 * Prisma are stubbed. Separate file because the limiters are module-level.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens } from "../lib/auth/jwt.js";

let currentUserId = "u-1497-wiring";
/** How many requests reached `requireAuth`: a refusal ahead of it adds none. */
let authCalls = 0;

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    agentRun: { findUnique: vi.fn(async () => ({ projectId: "p1" })) },
    agentRunStep: {
      findMany: vi.fn(async () => [
        { content: JSON.stringify({ kind: "pr_review", result: { overallVerdict: "approve" } }) },
      ]),
    },
    // The project-scope check's lookup: a live project in the caller's workspace.
    project: {
      findUnique: vi.fn(async () => ({
        workspaceId: "ws-1497",
        deletedAt: null,
        workspace: { deletedAt: null, members: [{ id: "member-row" }] },
      })),
    },
    prReviewState: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, _res: any, next: any) => {
    authCalls += 1;
    req.user = {
      userId: currentUserId,
      role: "reader",
      permissions: [],
      workspaces: ["ws-1497"],
    };
    next();
  },
}));

const { runReviewsRouter } = await import("./run-reviews.js");
const { prReviewsRouter } = await import("./pr-reviews.js");
const { errorHandler, notFoundHandler } = await import("../middleware/error-handler.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/run-reviews", runReviewsRouter());
  a.use("/api/projects/:projectId/pr-reviews", prReviewsRouter());
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

/** An access token this server signed: the pre-auth limiter keys on its user. */
const tokenFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "reader",
    permissions: getPermissionsForRole("reader"),
  }).accessToken;

afterEach(() => {
  delete process.env.PR_REVIEWS_LIMIT_MAX;
  delete process.env.PR_REVIEWS_PREAUTH_LIMIT_MAX;
});

describe("GET /api/run-reviews/:runId rate limiting (#1497)", () => {
  it("serves a workspace reader the review, then throttles past PR_REVIEWS_LIMIT_MAX", async () => {
    process.env.PR_REVIEWS_LIMIT_MAX = "1";
    currentUserId = "u-1497-user-limit";
    const a = app();
    const first = await request(a).get("/api/run-reviews/run-1");
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ runId: "run-1", review: { overallVerdict: "approve" } });
    const limited = await request(a).get("/api/run-reviews/run-1");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("PR_REVIEWS_RATE_LIMITED");
  });

  it("runs the pre-auth limiter, keyed on the signed token's user, ahead of requireAuth", async () => {
    // The per-user cap stays at its default (600), so only the pre-auth
    // limiter can refuse the second request.
    process.env.PR_REVIEWS_PREAUTH_LIMIT_MAX = "1";
    currentUserId = "u-1497-preauth";
    const token = tokenFor("u-1497-preauth");
    const a = app();
    const first = await request(a)
      .get("/api/run-reviews/run-1")
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    const authCallsBefore = authCalls;
    const limited = await request(a)
      .get("/api/run-reviews/run-1")
      .set("Authorization", `Bearer ${token}`);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("PR_REVIEWS_RATE_LIMITED");
    // Refused before requireAuth ran: the placement CodeQL counts.
    expect(authCalls).toBe(authCallsBefore);
  });

  it("shares one per-user budget with the project PR-review pages", async () => {
    process.env.PR_REVIEWS_LIMIT_MAX = "1";
    currentUserId = "u-1497-shared";
    const a = app();
    expect((await request(a).get("/api/projects/p1/pr-reviews")).status).toBe(200);
    expect((await request(a).get("/api/run-reviews/run-1")).status).toBe(429);
  });
});
