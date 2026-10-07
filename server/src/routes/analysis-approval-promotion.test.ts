/**
 * Issue #1104 finding B — resolving the last pending approval must release the
 * withheld requirements, and the response must say what happened.
 *
 * The live walkthrough had to `PUT .../approvals/:id` by hand and STILL saw
 * "No requirements yet" afterwards, because nothing re-ran promotion once the
 * gate cleared.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: { userId: string; role: string } }).user = {
      userId: "user-1",
      role: "member",
    };
    next();
  },
}));
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));
vi.mock("../middleware/analysis-deepdive-rate-limit.js", () => ({
  analysisDeepDiveRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));
// #723 — the reopen route must sit behind its own limiter (CodeQL
// js/missing-rate-limiting). The stub lets a test flip it to "limited".
const reopenLimiter = vi.hoisted(() => ({ limited: false, calls: 0 }));
const promoteLimiter = vi.hoisted(() => ({ limited: false, calls: 0 }));
const analysisRow = vi.hoisted(() => ({ status: "completed" }));
vi.mock("../middleware/analysis-approval-rate-limit.js", () => ({
  analysisApprovalReopenRateLimiter: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    reopenLimiter.calls += 1;
    if (reopenLimiter.limited) {
      res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "slow" } });
      return;
    }
    next();
  },
  analysisApprovalPromoteRateLimiter: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    promoteLimiter.calls += 1;
    if (promoteLimiter.limited) {
      res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "slow" } });
      return;
    }
    next();
  },
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async () => ({
        id: "analysis-1",
        projectId: "proj-1",
        status: analysisRow.status,
      })),
    },
    project: { findUnique: vi.fn(async () => ({ workspaceId: null })) },
  },
}));

const reviewApprovalRequest = vi.fn(async () => ({
  id: "ap_1",
  analysisId: "analysis-1",
  type: "requirement",
  itemId: "r1",
  status: "approved",
}));
const promoteApprovedRequirements = vi.fn();
const reopenApprovalRequest = vi.fn(async () => ({
  id: "ap_1",
  analysisId: "analysis-1",
  type: "requirement",
  itemId: "r1",
  status: "pending",
}));

vi.mock("../lib/analysis/index.js", () => ({
  ANALYSIS_SPECIALIST_AGENT_KEYS: [],
  AnalysisOrchestrator: class {},
  AnalysisNotRegeneratableError: class extends Error {},
  CostCapExceededError: class extends Error {},
  assertCanStartAnalysis: vi.fn(),
  getAllPersonas: vi.fn(),
  getAnalysisSnapshot: vi.fn(),
  getCostCapStatus: vi.fn(),
  getOrchestrator: vi.fn(),
  getStructuredRequirements: vi.fn(),
  persistAnalysisEnhancement: vi.fn(),
  listAnalysesForProject: vi.fn(),
  setOrchestratorForTests: vi.fn(),
  updateRequirementRow: vi.fn(),
  ClarificationDialog: class {},
  getDialogState: vi.fn(),
  listApprovalRequests: vi.fn(),
  reviewApprovalRequest,
  reopenApprovalRequest,
  canCreateTickets: vi.fn(),
  promoteApprovedRequirements,
  deepDiveFinding: vi.fn(),
  loadFindingForDeepDive: vi.fn(),
}));

vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../lib/ai/index.js", () => ({
  buildProvider: vi.fn(() => ({})),
  loadAIConfig: vi.fn(() => ({})),
}));
vi.mock("../lib/rag/knowledge-service.js", () => ({ getKnowledgeService: vi.fn(() => ({})) }));
vi.mock("../lib/ai/providers/bedrock-direct-provider.js", () => ({
  BedrockDirectProvider: class {},
}));
vi.mock("../lib/publishing/analysis-finding-publish.js", () => ({
  publishAnalysisFinding: vi.fn(),
}));
vi.mock("../lib/publishing/finding-publisher.js", () => ({ PublishError: class extends Error {} }));

const { initAnalysisRouter } = await import("./analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const { projectScoped } = initAnalysisRouter();
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/analyses", projectScoped);
  app.use(errorHandler);
  return app;
}

const approve = () =>
  request(createApp())
    .put("/api/projects/proj-1/analyses/analysis-1/approvals/ap_1")
    .send({ status: "approved" });

beforeEach(() => {
  vi.clearAllMocks();
  reopenLimiter.limited = false;
  reopenLimiter.calls = 0;
  promoteLimiter.limited = false;
  promoteLimiter.calls = 0;
  analysisRow.status = "completed";
});

describe("PUT .../approvals/:approvalId — #1104 promotion retry", () => {
  it("promotes the withheld requirements and reports the count", async () => {
    promoteApprovedRequirements.mockResolvedValueOnce({
      status: "promoted",
      requirementCount: 14,
    });

    const res = await approve();

    expect(res.status).toBe(200);
    expect(promoteApprovedRequirements).toHaveBeenCalledWith("analysis-1");
    expect(res.body.data.promotion).toEqual({ status: "promoted", requirementCount: 14 });
  });

  it("reports the still-blocked gate when approvals remain", async () => {
    promoteApprovedRequirements.mockResolvedValueOnce({
      status: "blocked",
      pendingCount: 12,
      rejectedCount: 0,
      awaitingRequirementCount: 14,
      reason: "Promotion blocked: 14 requirement(s) awaiting approval.",
    });

    const res = await approve();

    expect(res.status).toBe(200);
    expect(res.body.data.promotion.status).toBe("blocked");
    expect(res.body.data.promotion.awaitingRequirementCount).toBe(14);
  });

  it("still answers 200 for the review when promotion itself fails", async () => {
    promoteApprovedRequirements.mockRejectedValueOnce(new Error("db down"));

    const res = await approve();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");
    expect(res.body.data.promotion.status).toBe("unavailable");
  });
});

describe("POST .../approvals/:approvalId/reopen — #723", () => {
  it("reopens a rejected approval scoped to its analysis", async () => {
    const res = await request(createApp()).post(
      "/api/projects/proj-1/analyses/analysis-1/approvals/ap_1/reopen",
    );

    expect(res.status).toBe(200);
    expect(reopenApprovalRequest).toHaveBeenCalledWith("analysis-1", "ap_1");
    expect(res.body.data.status).toBe("pending");
  });

  it("passes through the service's 409 for an approval that is not rejected", async () => {
    const { AppError } = await import("../middleware/error-handler.js");
    reopenApprovalRequest.mockRejectedValueOnce(
      new AppError(409, "APPROVAL_NOT_REOPENABLE", "only a rejected approval can be reopened"),
    );

    const res = await request(createApp()).post(
      "/api/projects/proj-1/analyses/analysis-1/approvals/ap_1/reopen",
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("APPROVAL_NOT_REOPENABLE");
  });

  it("is rate limited before the reopen runs", async () => {
    reopenLimiter.limited = true;

    const res = await request(createApp()).post(
      "/api/projects/proj-1/analyses/analysis-1/approvals/ap_1/reopen",
    );

    expect(res.status).toBe(429);
    expect(reopenLimiter.calls).toBe(1);
    expect(reopenApprovalRequest).not.toHaveBeenCalled();
  });
});

// Issue #723 — the Analysis page's recovery for a run whose gate is open but
// which has no requirement rows (no review left to fire the PUT above).
describe("POST .../approvals/promote — #723", () => {
  const promote = () =>
    request(createApp()).post("/api/projects/proj-1/analyses/analysis-1/approvals/promote");

  it("promotes the approved requirements and reports the outcome", async () => {
    promoteApprovedRequirements.mockResolvedValueOnce({ status: "promoted", requirementCount: 32 });

    const res = await promote();

    expect(res.status).toBe(200);
    expect(promoteApprovedRequirements).toHaveBeenCalledWith("analysis-1");
    expect(res.body.data.promotion).toEqual({ status: "promoted", requirementCount: 32 });
  });

  it.each(["running", "pending"])("refuses with 409 while the analysis is %s", async (status) => {
    analysisRow.status = status;

    const res = await promote();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_COMPLETED");
    expect(promoteApprovedRequirements).not.toHaveBeenCalled();
  });

  it("reports a failed promotion as unavailable instead of a 500", async () => {
    promoteApprovedRequirements.mockRejectedValueOnce(new Error("db down"));

    const res = await promote();

    expect(res.status).toBe(200);
    expect(res.body.data.promotion.status).toBe("unavailable");
  });

  it("is rate limited before the promotion runs", async () => {
    promoteLimiter.limited = true;

    const res = await promote();

    expect(res.status).toBe(429);
    expect(promoteLimiter.calls).toBe(1);
    expect(promoteApprovedRequirements).not.toHaveBeenCalled();
  });
});
