/**
 * Route tests for GET /api/projects/:projectId/analyses/:id/requirement-diff (#743).
 *
 * Verifies analysis↔project ownership for BOTH the head and the (optional) base
 * analysis (IDOR/BOLA → 404), the JSON diff response, and that the base query
 * param is passed through to the service. The composition/aggregation itself is
 * covered in requirement-diff*.test.ts; this suite isolates the route wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { RequirementDiff } from "@metis/shared";

let currentUser: { userId: string; role: string } = { userId: "user-1", role: "member" };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
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

const analysisFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    analysis: { findFirst: analysisFindFirst },
    project: { findUnique: vi.fn(async () => ({ workspaceId: null })) },
  },
}));

const getRequirementDiff = vi.fn();
vi.mock("../lib/change-analysis/requirement-diff-service.js", () => ({ getRequirementDiff }));

vi.mock("../lib/analysis/index.js", () => ({
  ANALYSIS_SPECIALIST_AGENT_KEYS: [],
  AnalysisOrchestrator: class {},
  AnalysisNotRegeneratableError: class extends Error {},
  CostCapExceededError: class extends Error {},
  assertCanStartAnalysis: vi.fn(),
  getAllPersonas: vi.fn(),
  getAnalysisSnapshot: vi.fn(),
  detectStaticCapability: vi.fn(),
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
  canCreateTickets: vi.fn(),
  deepDiveFinding: vi.fn(),
  loadFindingForDeepDive: vi.fn(),
  getTraceabilityMatrix: vi.fn(),
  serializeTraceabilityCsv: vi.fn(),
  serializeTraceabilityMarkdown: vi.fn(),
  getGapReport: vi.fn(),
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
vi.mock("../lib/scanner/prisma-adapter.js", () => ({ publishAnalysisFinding: vi.fn() }));
vi.mock("../lib/scanner/finding-publisher.js", () => ({ PublishError: class extends Error {} }));

const { initAnalysisRouter } = await import("./analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

const DIFF: RequirementDiff = {
  projectId: "proj-1",
  headAnalysisId: "analysis-1",
  baseAnalysisId: "analysis-0",
  entries: [
    {
      changeType: "modified",
      severity: "medium",
      impactScore: 0.6,
      diffSummary: "Body content modified (40 character delta)",
      current: {
        requirementId: "b1",
        title: "Users can log in",
        body: "old",
        priority: "high",
        storyPoints: 3,
        codeCitations: [{ filePath: "auth.ts", startLine: 1, endLine: 5 }],
        hasEvidence: true,
      },
      proposed: {
        requirementId: "h1",
        title: "Users can log in",
        body: "new",
        priority: "high",
        storyPoints: 3,
        gapReport: null,
      },
    },
  ],
  summary: { total: 1, added: 0, removed: 0, modified: 1 },
};

function createApp() {
  const { projectScoped } = initAnalysisRouter();
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/analyses", projectScoped);
  app.use(errorHandler);
  return app;
}

describe("GET /api/projects/:projectId/analyses/:id/requirement-diff", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    app = createApp();
  });

  it("404s when the head analysis does not belong to the path project (IDOR)", async () => {
    analysisFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get(
      "/api/projects/other-project/analyses/analysis-1/requirement-diff",
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    expect(getRequirementDiff).not.toHaveBeenCalled();
  });

  it("404s when the ?base analysis does not belong to the project (base IDOR)", async () => {
    // First call (head) passes; second call (base) is the cross-project miss.
    analysisFindFirst
      .mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" })
      .mockResolvedValueOnce(null);
    const res = await request(app).get(
      "/api/projects/proj-1/analyses/analysis-1/requirement-diff?base=foreign",
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    expect(analysisFindFirst).toHaveBeenNthCalledWith(2, {
      where: { id: "foreign", deletedAt: null, projectId: "proj-1" },
    });
    expect(getRequirementDiff).not.toHaveBeenCalled();
  });

  it("returns the JSON diff and passes the base param to the service", async () => {
    analysisFindFirst
      .mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" })
      .mockResolvedValueOnce({ id: "analysis-0", projectId: "proj-1" });
    getRequirementDiff.mockResolvedValueOnce(DIFF);
    const res = await request(app).get(
      "/api/projects/proj-1/analyses/analysis-1/requirement-diff?base=analysis-0",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: DIFF });
    expect(getRequirementDiff).toHaveBeenCalledWith({
      projectId: "proj-1",
      headAnalysisId: "analysis-1",
      baseAnalysisId: "analysis-0",
    });
  });

  it("defaults the base to null when no ?base is supplied", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" });
    getRequirementDiff.mockResolvedValueOnce({ ...DIFF, baseAnalysisId: null, entries: [] });
    const res = await request(app).get("/api/projects/proj-1/analyses/analysis-1/requirement-diff");
    expect(res.status).toBe(200);
    expect(getRequirementDiff).toHaveBeenCalledWith({
      projectId: "proj-1",
      headAnalysisId: "analysis-1",
      baseAnalysisId: null,
    });
  });
});
