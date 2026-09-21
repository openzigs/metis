/**
 * Route tests for GET /api/projects/:projectId/analyses/:id/traceability (#737).
 *
 * Verifies: analysis↔project ownership (IDOR/BOLA → 404), the default JSON
 * matrix response, and the server-side CSV / markdown export branches (correct
 * Content-Type + Content-Disposition + body). The pure serializers are stubbed
 * here — they are exhaustively covered in traceability-matrix.test.ts — so this
 * suite isolates the route wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { TraceabilityMatrix } from "@metis/shared";

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
    // #674 chokepoint: null workspaceId → open to any authed caller, so the
    // ensureAnalysisVisible IDOR path remains the unit under test.
    project: { findUnique: vi.fn(async () => ({ workspaceId: null })) },
  },
}));

const getTraceabilityMatrix = vi.fn();
const serializeTraceabilityCsv = vi.fn(() => "CSV_BODY");
const serializeTraceabilityMarkdown = vi.fn(() => "MD_BODY");
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
  serializeTraceabilityCsv,
  serializeTraceabilityMarkdown,
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

const MATRIX: TraceabilityMatrix = {
  analysisId: "analysis-1",
  projectId: "proj-1",
  testsDetection: "heuristic",
  rows: [
    {
      requirementId: "req-1",
      title: "Users can log in",
      coverage: "grounded_in_code",
      findings: [{ id: "f-1", title: "Login", severity: "high" }],
      codeLocations: [{ filePath: "auth.ts", startLine: 1, endLine: 9, source: "citation" }],
      tests: [],
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

describe("GET /api/projects/:projectId/analyses/:id/traceability", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    serializeTraceabilityCsv.mockReturnValue("CSV_BODY");
    serializeTraceabilityMarkdown.mockReturnValue("MD_BODY");
    app = createApp();
  });

  it("404s when the analysis does not belong to the path project (IDOR)", async () => {
    analysisFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get(
      "/api/projects/other-project/analyses/analysis-1/traceability",
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    expect(analysisFindFirst).toHaveBeenCalledWith({
      where: { id: "analysis-1", deletedAt: null, projectId: "other-project" },
    });
    // Ownership check fires before any matrix assembly.
    expect(getTraceabilityMatrix).not.toHaveBeenCalled();
  });

  it("returns the JSON matrix by default", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" });
    getTraceabilityMatrix.mockResolvedValueOnce(MATRIX);
    const res = await request(app).get("/api/projects/proj-1/analyses/analysis-1/traceability");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: MATRIX });
    expect(getTraceabilityMatrix).toHaveBeenCalledWith("analysis-1");
  });

  it("streams CSV with attachment headers for ?format=csv", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" });
    getTraceabilityMatrix.mockResolvedValueOnce(MATRIX);
    const res = await request(app).get(
      "/api/projects/proj-1/analyses/analysis-1/traceability?format=csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(
      'attachment; filename="traceability-matrix-analysis-1.csv"',
    );
    expect(res.text).toBe("CSV_BODY");
    expect(serializeTraceabilityCsv).toHaveBeenCalledWith(MATRIX);
  });

  it("streams markdown with attachment headers for ?format=md", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" });
    getTraceabilityMatrix.mockResolvedValueOnce(MATRIX);
    const res = await request(app).get(
      "/api/projects/proj-1/analyses/analysis-1/traceability?format=md",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain(
      'attachment; filename="traceability-matrix-analysis-1.md"',
    );
    expect(res.text).toBe("MD_BODY");
    expect(serializeTraceabilityMarkdown).toHaveBeenCalledWith(MATRIX);
  });

  it("404s when the matrix builder finds no analysis", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" });
    getTraceabilityMatrix.mockResolvedValueOnce(null);
    const res = await request(app).get("/api/projects/proj-1/analyses/analysis-1/traceability");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
  });
});
