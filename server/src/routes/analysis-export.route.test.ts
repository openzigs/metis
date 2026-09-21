/**
 * Route tests for the #744 export endpoints (route wiring only — the serializer
 * output is covered in analysis-export.test.ts):
 *
 *   GET  /api/projects/:projectId/analyses/:id/export?format=md
 *   POST /api/projects/:projectId/analyses/:id/findings/:findingId/export?format=md|issue
 *
 * Verifies analysis↔project ownership (IDOR/BOLA → 404), format negotiation,
 * attachment headers, draft validation (400), and the issue-draft JSON path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { FindingIssueDraft } from "@metis/shared";

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
const getTraceabilityMatrix = vi.fn();
const serializeAnalysisReportMarkdown = vi.fn(() => "REPORT_MD");
const serializeFindingIssueDraftMarkdown = vi.fn(() => "DRAFT_MD");
const buildFindingIssueDraft = vi.fn(() => ({ title: "T", body: "B", labels: ["security"] }));

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
  getTraceabilityMatrix,
  serializeTraceabilityCsv: vi.fn(),
  serializeTraceabilityMarkdown: vi.fn(),
  getGapReport,
  buildFindingIssueDraft,
  serializeFindingIssueDraftMarkdown,
  serializeAnalysisReportMarkdown,
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

const DRAFT: FindingIssueDraft = {
  title: "Add rate limiting",
  problemStatement: "No throttling.",
  affected: { files: ["auth.ts"], requirementIds: ["REQ-1"] },
  acceptanceCriteria: ["Limited to 5/min"],
  suggestedLabels: ["security"],
};

function createApp() {
  const { projectScoped } = initAnalysisRouter();
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/analyses", projectScoped);
  app.use(errorHandler);
  return app;
}

describe("GET /api/projects/:projectId/analyses/:id/export", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    app = createApp();
  });

  it("404s when the analysis does not belong to the path project (IDOR)", async () => {
    analysisFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get("/api/projects/other/analyses/a-1/export");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    expect(analysisFindFirst).toHaveBeenCalledWith({
      where: { id: "a-1", deletedAt: null, projectId: "other" },
    });
    expect(getGapReport).not.toHaveBeenCalled();
  });

  it("streams the combined report markdown as a download", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "a-1", projectId: "p-1" });
    getGapReport.mockResolvedValueOnce({ requirements: [] });
    getTraceabilityMatrix.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/api/projects/p-1/analyses/a-1/export?format=md");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain(
      'attachment; filename="analysis-report-a-1.md"',
    );
    expect(res.text).toBe("REPORT_MD");
    expect(serializeAnalysisReportMarkdown).toHaveBeenCalledOnce();
  });

  it("404s when the gap report or matrix is unavailable", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "a-1", projectId: "p-1" });
    getGapReport.mockResolvedValueOnce(null);
    getTraceabilityMatrix.mockResolvedValueOnce(null);
    const res = await request(app).get("/api/projects/p-1/analyses/a-1/export");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
  });
});

describe("POST /api/projects/:projectId/analyses/:id/findings/:findingId/export", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    app = createApp();
  });

  it("400s on an invalid draft payload before touching the DB", async () => {
    const res = await request(app)
      .post("/api/projects/p-1/analyses/a-1/findings/f-1/export")
      .send({ title: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(analysisFindFirst).not.toHaveBeenCalled();
  });

  it("404s when the analysis does not belong to the path project (IDOR)", async () => {
    analysisFindFirst.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/projects/other/analyses/a-1/findings/f-1/export")
      .send(DRAFT);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
  });

  it("returns the issue-draft markdown attachment by default", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "a-1", projectId: "p-1" });
    const res = await request(app)
      .post("/api/projects/p-1/analyses/a-1/findings/f-1/export")
      .send(DRAFT);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain(
      'attachment; filename="issue-draft-f-1.md"',
    );
    expect(res.text).toBe("DRAFT_MD");
    expect(serializeFindingIssueDraftMarkdown).toHaveBeenCalledOnce();
    expect(buildFindingIssueDraft).not.toHaveBeenCalled();
  });

  it("returns the structured issue draft JSON for format=issue", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "a-1", projectId: "p-1" });
    const res = await request(app)
      .post("/api/projects/p-1/analyses/a-1/findings/f-1/export?format=issue")
      .send(DRAFT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { title: "T", body: "B", labels: ["security"] },
    });
    expect(buildFindingIssueDraft).toHaveBeenCalledOnce();
    expect(serializeFindingIssueDraftMarkdown).not.toHaveBeenCalled();
  });
});
