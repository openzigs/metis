/**
 * Epic #192 (A.4 + A.6) — run-reviews route tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const findUnique = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
const updateRun = vi.hoisted(() => vi.fn(async () => ({})));
const createRun = vi.hoisted(() => vi.fn(async () => ({ id: "run-test" })));
const stepCount = vi.hoisted(() => vi.fn(async () => 0));
const stepCreate = vi.hoisted(() => vi.fn(async () => ({ id: "step1" })));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    agentRun: { create: createRun, update: updateRun, findUnique },
    agentRunStep: {
      count: stepCount,
      create: stepCreate,
      findMany,
    },
  },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user?: { userId: string } }).user = { userId: "tester" };
    next();
  },
}));

vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));

import { runReviewsRouter } from "../src/routes/run-reviews.js";
import { errorHandler } from "../src/middleware/error-handler.js";

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue({ id: "run-test", startedAt: new Date() });
  findMany.mockReset();
  createRun.mockClear();
  stepCount.mockClear();
  stepCreate.mockClear();
});

afterEach(() => vi.restoreAllMocks());

function makeApp(deps?: Parameters<typeof runReviewsRouter>[0]): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api/run-reviews", runReviewsRouter(deps));
  app.use(errorHandler);
  return app;
}

describe("POST /api/run-reviews", () => {
  it("returns 400 on bad body", async () => {
    const app = makeApp({
      judge: { evaluate: async () => "{}" },
      octokit: { pulls: { createReview: vi.fn(async () => ({ data: { id: 1, html_url: "" } })) } },
    });
    const res = await request(app).post("/api/run-reviews").send({});
    expect(res.status).toBe(400);
  });

  it("returns 503 when judge or octokit not configured", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/run-reviews")
      .send({ projectId: "p1", owner: "a", repo: "b", prNumber: 1 });
    expect(res.status).toBe(503);
  });

  it("starts a run, runs review, and returns runId + result", async () => {
    const judge = vi.fn(async () =>
      JSON.stringify({
        verdicts: [{ acId: "AC1", verdict: "satisfied", reasoning: "", evidenceFiles: [] }],
        comments: [],
        overallVerdict: "approve",
        summary: "ok",
      }),
    );
    const createReview = vi.fn(async () => ({ data: { id: 1, html_url: "u" } }));
    const app = makeApp({
      judge: { evaluate: judge },
      octokit: { pulls: { createReview } },
    });
    const res = await request(app)
      .post("/api/run-reviews")
      .send({
        projectId: "p1",
        owner: "acme",
        repo: "proj",
        prNumber: 7,
        prTitle: "t",
        prBody: "",
        diff: "",
        criteria: [{ id: "AC1", text: "thing" }],
      });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.runId).toBeTruthy();
    expect(res.body.data.result.judge.overallVerdict).toBe("approve");
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("502s when the review pipeline throws", async () => {
    const judge = vi.fn(async () => {
      throw new Error("boom");
    });
    const app = makeApp({
      judge: { evaluate: judge },
      octokit: { pulls: { createReview: vi.fn() } },
    });
    const res = await request(app)
      .post("/api/run-reviews")
      .send({
        projectId: "p1",
        owner: "acme",
        repo: "proj",
        prNumber: 7,
        criteria: [{ id: "AC1", text: "x" }],
      });
    expect(res.status).toBe(502);
  });
});

describe("GET /api/run-reviews/:runId", () => {
  it("returns 404 for unknown runs", async () => {
    findUnique.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app).get("/api/run-reviews/run-missing");
    expect(res.status).toBe(404);
  });

  it("returns null review when no pr_review step exists", async () => {
    findUnique.mockResolvedValueOnce({ id: "r1" });
    findMany.mockResolvedValueOnce([{ content: JSON.stringify({ kind: "other" }) }]);
    const app = makeApp();
    const res = await request(app).get("/api/run-reviews/r1");
    expect(res.status).toBe(200);
    expect(res.body.data.review).toBeNull();
  });

  it("returns the parsed review when present", async () => {
    findUnique.mockResolvedValueOnce({ id: "r1" });
    findMany.mockResolvedValueOnce([
      {
        content: JSON.stringify({
          kind: "pr_review",
          result: { judge: { overallVerdict: "approve" }, sandboxResults: [], reviewUrl: "u" },
        }),
      },
    ]);
    const app = makeApp();
    const res = await request(app).get("/api/run-reviews/r1");
    expect(res.status).toBe(200);
    expect(res.body.data.review.judge.overallVerdict).toBe("approve");
    expect(res.body.data.review.reviewUrl).toBe("u");
  });

  it("ignores unparseable step content", async () => {
    findUnique.mockResolvedValueOnce({ id: "r1" });
    findMany.mockResolvedValueOnce([
      { content: "not-json" },
      { content: JSON.stringify({ kind: "pr_review", result: { reviewUrl: "x" } }) },
    ]);
    const app = makeApp();
    const res = await request(app).get("/api/run-reviews/r1");
    expect(res.body.data.review.reviewUrl).toBe("x");
  });
});
