/**
 * Issue #741 (Epic #727) — route tests for POST /api/analyses/:id/resume-repos.
 *
 * Isolates the route wiring: the synchronous pre-flight status mapping
 * (429/409/404), the idempotent 200 no-op when nothing is skipped, and the 202
 * kick-off (with the willResume payload) when repos were skipped. The
 * orchestrator is faked — its resume behaviour is covered in
 * resume-skipped-repos.test.ts.
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
vi.mock("../middleware/require-project-access.js", () => ({
  requireProjectAccess:
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

const assertCanResumeRepos = vi.fn();
const resumeSkippedRepos = vi.fn();
const orch = { assertCanResumeRepos, resumeSkippedRepos };

class AnalysisNotRegeneratableError extends Error {
  code = "ANALYSIS_NOT_REGENERATABLE";
  constructor(
    _id: string,
    public currentStatus: string,
  ) {
    super(`Analysis not regeneratable (${_id})`);
    this.name = "AnalysisNotRegeneratableError";
  }
}
class CostCapExceededError extends Error {
  code = "COST_CAP_EXCEEDED";
  constructor(
    public cap: number,
    public used: number,
  ) {
    super("cost cap exceeded");
    this.name = "CostCapExceededError";
  }
}

vi.mock("../lib/analysis/index.js", () => ({
  ANALYSIS_SPECIALIST_AGENT_KEYS: [],
  AnalysisOrchestrator: class {},
  AnalysisNotRegeneratableError,
  CostCapExceededError,
  assertCanStartAnalysis: vi.fn(),
  getAllPersonas: vi.fn(),
  getAnalysisSnapshot: vi.fn(),
  detectStaticCapability: vi.fn(),
  getCostCapStatus: vi.fn(),
  getOrchestrator: vi.fn(() => orch),
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
  const { topLevel } = initAnalysisRouter();
  const app = express();
  app.use(express.json());
  app.use("/api/analyses", topLevel);
  app.use(errorHandler);
  return app;
}

const SKIPPED = [{ connectorId: "c2", label: "worker" }];

describe("POST /api/analyses/:id/resume-repos", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    analysisFindFirst.mockResolvedValue({ id: "an-1", projectId: "pr-1" });
    app = createApp();
  });

  it("202-accepts and kicks off the resume when repos were skipped", async () => {
    assertCanResumeRepos.mockResolvedValueOnce({ skippedRepos: SKIPPED });
    resumeSkippedRepos.mockResolvedValueOnce({ resumed: SKIPPED, remaining: [], noop: false });

    const res = await request(app).post("/api/analyses/an-1/resume-repos");

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, data: { accepted: true, willResume: SKIPPED } });
    expect(resumeSkippedRepos).toHaveBeenCalledWith({ analysisId: "an-1", actorId: "user-1" });
  });

  it("200 no-op (never kicks off a run) when nothing was skipped", async () => {
    assertCanResumeRepos.mockResolvedValueOnce({ skippedRepos: [] });

    const res = await request(app).post("/api/analyses/an-1/resume-repos");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { accepted: false, resumed: [], remaining: [] },
    });
    expect(resumeSkippedRepos).not.toHaveBeenCalled();
  });

  it("409s when the analysis is still running (double-resume / non-terminal guard)", async () => {
    assertCanResumeRepos.mockRejectedValueOnce(
      new AnalysisNotRegeneratableError("an-1", "running"),
    );

    const res = await request(app).post("/api/analyses/an-1/resume-repos");

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_REGENERATABLE");
    expect(res.body.error.details.currentStatus).toBe("running");
    expect(resumeSkippedRepos).not.toHaveBeenCalled();
  });

  it("429s when the cost cap is exceeded", async () => {
    assertCanResumeRepos.mockRejectedValueOnce(new CostCapExceededError(100, 120));

    const res = await request(app).post("/api/analyses/an-1/resume-repos");

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("COST_CAP_EXCEEDED");
  });

  it("404s when the analysis is not visible to the caller", async () => {
    analysisFindFirst.mockResolvedValueOnce(null);

    const res = await request(app).post("/api/analyses/does-not-exist/resume-repos");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    expect(assertCanResumeRepos).not.toHaveBeenCalled();
  });
});
