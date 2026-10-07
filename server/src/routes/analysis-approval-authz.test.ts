/**
 * Issue #723 — the role gate on the approval WRITE routes that #723 added
 * (reopen, promote), with the REAL `requirePermission`.
 *
 * `analysis-approval-promotion.test.ts` stubs `requirePermission` to a
 * pass-through, so deleting `requirePermission("analysis.run")` from either
 * route left every test green. Here only authentication is stubbed: the caller's
 * role is real, and a `reader` (no `analysis.run`) must be refused before the
 * service layer is reached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const caller = vi.hoisted(() => ({ role: "reader" }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: { userId: string; role: string } }).user = {
      userId: "user-1",
      role: caller.role,
    };
    next();
  },
}));
// `requirePermission` is deliberately NOT mocked.
const passThrough = (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
  next();
vi.mock("../middleware/analysis-deepdive-rate-limit.js", () => ({
  analysisDeepDiveRateLimiter: passThrough,
}));
vi.mock("../middleware/analysis-approval-rate-limit.js", () => ({
  analysisApprovalReopenRateLimiter: passThrough,
  analysisApprovalPromoteRateLimiter: passThrough,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async () => ({
        id: "analysis-1",
        projectId: "proj-1",
        status: "completed",
      })),
    },
    project: { findUnique: vi.fn(async () => ({ workspaceId: null })) },
  },
}));

const reopenApprovalRequest = vi.fn(async () => ({ id: "ap_1", status: "pending" }));
const promoteApprovedRequirements = vi.fn(async () => ({
  status: "promoted" as const,
  requirementCount: 3,
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
  reviewApprovalRequest: vi.fn(),
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

const routes = [
  {
    name: "POST .../approvals/:approvalId/reopen",
    path: "/api/projects/proj-1/analyses/analysis-1/approvals/ap_1/reopen",
    service: reopenApprovalRequest,
  },
  {
    name: "POST .../approvals/promote",
    path: "/api/projects/proj-1/analyses/analysis-1/approvals/promote",
    service: promoteApprovedRequirements,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  caller.role = "reader";
});

describe.each(routes)("$name — requires analysis.run (#723)", ({ path, service }) => {
  it("refuses a reader with 403 before the service runs", async () => {
    caller.role = "reader";

    const res = await request(createApp()).post(path);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(service).not.toHaveBeenCalled();
  });

  it("admits a developer, who holds analysis.run (no over-blocking)", async () => {
    caller.role = "developer";

    const res = await request(createApp()).post(path);

    expect(res.status).toBe(200);
    expect(service).toHaveBeenCalledTimes(1);
  });
});
