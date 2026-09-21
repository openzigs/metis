/**
 * Route tests for GET /api/projects/:projectId/analyses/:id/gap-report (#742).
 *
 * Verifies analysis↔project ownership (IDOR/BOLA → 404), the JSON gap-report
 * response, and the 404 when the report builder finds no analysis. The
 * aggregation itself is covered in gap-report-service.test.ts; this suite
 * isolates the route wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { GapReport } from "@metis/shared";

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

const getGapReport = vi.fn();
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
  getGapReport,
  // #847 — the route resolves the schema-impact producer deps; OFF path is `{}`.
  resolveGapReportDeps: () => ({}),
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

const REPORT: GapReport = {
  analysisId: "analysis-1",
  projectId: "proj-1",
  requirements: [
    {
      requirementId: "req-1",
      title: "Users can log in",
      body: "Users authenticate with email + password.",
      priority: "high",
      coverage: "grounded_in_code",
      storyPoints: 5,
      verificationStatus: "confirmed",
      currentImplementation: {
        hasEvidence: true,
        citations: [{ filePath: "auth.ts", startLine: 1, endLine: 9 }],
        citedFindingCount: 1,
      },
      gapFindings: [
        {
          id: "f-1",
          title: "No lockout",
          body: "add throttle",
          severity: "high",
          verificationStatus: "confirmed",
          citations: [{ filePath: "auth.ts", startLine: 1, endLine: 9 }],
        },
      ],
      noEvidence: false,
    },
  ],
};

function createApp() {
  const { projectScoped } = initAnalysisRouter();
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/analyses", projectScoped);
  app.use(errorHandler);
  return app;
}

describe("GET /api/projects/:projectId/analyses/:id/gap-report", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    app = createApp();
  });

  it("404s when the analysis does not belong to the path project (IDOR)", async () => {
    analysisFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get(
      "/api/projects/other-project/analyses/analysis-1/gap-report",
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    expect(analysisFindFirst).toHaveBeenCalledWith({
      where: { id: "analysis-1", deletedAt: null, projectId: "other-project" },
    });
    // Ownership check fires before any report assembly.
    expect(getGapReport).not.toHaveBeenCalled();
  });

  it("returns the JSON gap report", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" });
    getGapReport.mockResolvedValueOnce(REPORT);
    const res = await request(app).get("/api/projects/proj-1/analyses/analysis-1/gap-report");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: REPORT });
    expect(getGapReport).toHaveBeenCalledWith("analysis-1", {});
  });

  it("404s when the report builder finds no analysis", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" });
    getGapReport.mockResolvedValueOnce(null);
    const res = await request(app).get("/api/projects/proj-1/analyses/analysis-1/gap-report");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
  });
});
