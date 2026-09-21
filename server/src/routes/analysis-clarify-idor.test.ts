/**
 * IDOR-hardening test for POST /api/projects/:projectId/analyses/:id/clarify.
 *
 * The clarify handler scopes knowledge-grounding retrieval to the path
 * projectId, so the analysis MUST belong to that project. This mirrors the
 * existing deep-dive / publish IDOR defence (scoped Prisma query → 404).
 * Prisma is mocked so no real DB is touched (the #289 lesson); the analysis
 * services are mocked because the ownership check fires before any of them run
 * on the mismatch path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

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

// Scoped analysis lookup is the unit under test — drive findFirst directly.
const analysisFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    analysis: { findFirst: analysisFindFirst },
    // #674 — requireProjectAccess chokepoint on the projectScoped router. Null
    // workspaceId → open to any authed caller, so the analysis↔project IDOR
    // path under test (ensureAnalysisVisible) remains the unit exercised.
    project: { findUnique: vi.fn(async () => ({ workspaceId: null })) },
  },
}));

// Dialog + the rest of the analysis surface are mocked: on the mismatch path
// none of them should be reached.
const startOrContinue = vi.fn();
const submitAnswers = vi.fn();
const getStructuredRequirements = vi.fn();
const getDialogState = vi.fn();
class FakeDialog {
  startOrContinue = startOrContinue;
  submitAnswers = submitAnswers;
}
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
  getStructuredRequirements,
  persistAnalysisEnhancement: vi.fn(),
  listAnalysesForProject: vi.fn(),
  setOrchestratorForTests: vi.fn(),
  updateRequirementRow: vi.fn(),
  ClarificationDialog: FakeDialog,
  getDialogState,
  listApprovalRequests: vi.fn(),
  reviewApprovalRequest: vi.fn(),
  canCreateTickets: vi.fn(),
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
vi.mock("../lib/scanner/prisma-adapter.js", () => ({ publishAnalysisFinding: vi.fn() }));
vi.mock("../lib/scanner/finding-publisher.js", () => ({ PublishError: class extends Error {} }));

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

describe("POST /api/projects/:projectId/analyses/:id/clarify — IDOR hardening", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    app = createApp();
  });

  it("404s when the analysis does not belong to the path project (scoped query returns null)", async () => {
    // Scoped findFirst (id + projectId) finds nothing → ownership mismatch.
    analysisFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/projects/other-project/analyses/analysis-1/clarify")
      .send({
        requirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    // The scoped lookup must include BOTH id and the path projectId.
    expect(analysisFindFirst).toHaveBeenCalledWith({
      where: { id: "analysis-1", deletedAt: null, projectId: "other-project" },
    });
    // Ownership check fires before any dialog work.
    expect(startOrContinue).not.toHaveBeenCalled();
    expect(submitAnswers).not.toHaveBeenCalled();
  });

  it("proceeds past the ownership check when the analysis belongs to the project", async () => {
    analysisFindFirst.mockResolvedValueOnce({ id: "analysis-1", projectId: "proj-1" });
    getStructuredRequirements.mockResolvedValueOnce(undefined);
    startOrContinue.mockResolvedValueOnce({ round: 1, questions: [] });

    const res = await request(app)
      .post("/api/projects/proj-1/analyses/analysis-1/clarify")
      .send({
        requirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
      });

    expect(res.status).toBe(200);
    expect(analysisFindFirst).toHaveBeenCalledWith({
      where: { id: "analysis-1", deletedAt: null, projectId: "proj-1" },
    });
    expect(startOrContinue).toHaveBeenCalledWith("analysis-1", expect.anything());
  });
});
