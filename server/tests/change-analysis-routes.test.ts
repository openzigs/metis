/**
 * Tests for change analysis API routes — Epic #557 / Issue #565.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks -----------------------------------------------------------------

const mockTrigger = vi.fn();
const mockList = vi.fn();
const mockGet = vi.fn();
const mockReview = vi.fn();

vi.mock("../src/lib/change-analysis/change-analysis-engine.js", () => ({
  triggerChangeAnalysis: (...args: unknown[]) => mockTrigger(...args),
  listChangeAnalyses: (...args: unknown[]) => mockList(...args),
  getChangeAnalysis: (...args: unknown[]) => mockGet(...args),
  reviewChange: (...args: unknown[]) => mockReview(...args),
  ChangeAnalysisError: class ChangeAnalysisError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.name = "ChangeAnalysisError";
    }
  },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => {
    (_req as Record<string, unknown>).user = { userId: "user_1", role: "admin" };
    next();
  }),
}));

vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

import express from "express";
import type { ErrorRequestHandler } from "express";
import request from "supertest";
import { changeAnalysisRouter } from "../src/routes/change-analysis.js";
import { AppError } from "../src/middleware/error-handler.js";

/**
 * Minimal error handler so `next(err)` in routes produces proper HTTP responses.
 */
const testErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res
      .status(err.statusCode)
      .json({ success: false, error: { code: err.code, message: err.message } });
    return;
  }
  res.status(500).json({ success: false, error: { code: "INTERNAL", message: String(err) } });
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/change-analyses", changeAnalysisRouter());
  app.use(testErrorHandler);
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

// ---- Tests ------------------------------------------------------------------

describe("POST /projects/:projectId/change-analyses", () => {
  it("triggers a change analysis with valid input", async () => {
    const baseId = "analysis_base_01";
    const headId = "analysis_head_01";
    const ca = {
      id: "ca_0000000001",
      projectId: "proj_000000001",
      baseAnalysisId: baseId,
      headAnalysisId: headId,
      status: "pending",
      totalChanges: 0,
      additions: 0,
      removals: 0,
      modifications: 0,
      startedById: "user_0000000001",
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
      summary: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockTrigger.mockResolvedValueOnce(ca);

    const app = buildApp();
    const res = await request(app)
      .post("/projects/proj_000000001/change-analyses")
      .send({ baseAnalysisId: baseId, headAnalysisId: headId });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("ca_0000000001");
  });

  it("rejects invalid input (missing fields)", async () => {
    const app = buildApp();
    const res = await request(app).post("/projects/proj_1/change-analyses").send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /projects/:projectId/change-analyses", () => {
  it("lists change analyses", async () => {
    mockList.mockResolvedValueOnce([{ id: "ca_1", status: "completed", totalChanges: 3 }]);

    const app = buildApp();
    const res = await request(app).get("/projects/proj_1/change-analyses");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("passes an unrecognised service error through untranslated", async () => {
    mockList.mockRejectedValueOnce(new Error("database is on fire"));

    const app = buildApp();
    const res = await request(app).get("/projects/proj_1/change-analyses");

    expect(res.status).toBe(500);
  });
});

describe("GET /projects/:projectId/change-analyses/:id", () => {
  it("returns detail with changes", async () => {
    mockGet.mockResolvedValueOnce({
      id: "ca_1",
      status: "completed",
      changes: [{ id: "rc_1", changeType: "added", title: "New req" }],
    });

    const app = buildApp();
    const res = await request(app).get("/projects/proj_1/change-analyses/ca_1");

    expect(res.status).toBe(200);
    expect(res.body.data.changes).toHaveLength(1);
  });

  it("threads the path projectId into the service lookup (#1073)", async () => {
    mockGet.mockResolvedValueOnce({ id: "ca_1", status: "completed", changes: [] });

    const app = buildApp();
    await request(app).get("/projects/proj_1/change-analyses/ca_1");

    expect(mockGet).toHaveBeenCalledWith({ id: "ca_1", projectId: "proj_1" });
  });
});

describe("POST /projects/:projectId/change-analyses/:id/changes/:changeId/review", () => {
  it("approves a change", async () => {
    mockReview.mockResolvedValueOnce({
      id: "rc_1",
      reviewStatus: "approved",
    });

    const app = buildApp();
    const res = await request(app)
      .post("/projects/proj_1/change-analyses/ca_1/changes/rc_1/review")
      .send({ reviewStatus: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.data.reviewStatus).toBe("approved");
  });

  it("threads the path projectId and the analysis id into the service (#1073)", async () => {
    mockReview.mockResolvedValueOnce({ id: "rc_1", reviewStatus: "approved" });

    const app = buildApp();
    await request(app)
      .post("/projects/proj_1/change-analyses/ca_1/changes/rc_1/review")
      .send({ reviewStatus: "approved" });

    expect(mockReview).toHaveBeenCalledWith({
      projectId: "proj_1",
      changeAnalysisId: "ca_1",
      changeId: "rc_1",
      reviewStatus: "approved",
      actorId: "user_1",
    });
  });

  it("rejects invalid review status", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/projects/proj_1/change-analyses/ca_1/changes/rc_1/review")
      .send({ reviewStatus: "invalid" });

    expect(res.status).toBe(400);
  });
});
