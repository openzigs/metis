/**
 * BOLA / object-level authorization test for the project-scoped analysis subtree
 * (`/api/projects/:projectId/analyses/*`) — issue #674, epic #671, OWASP A01.
 *
 * The `projectScoped` router gated only on `analysis.read` / `analysis.run`. A
 * caller outside the project's workspace must get a 404 before the analysis
 * service runs, regardless of role.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUser: { userId: string; username: string; role: string; workspaces?: string[] } = {
  userId: "user-1",
  username: "u1",
  role: "coordinator",
  workspaces: ["ws-a"],
};

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
  analysisDeepDiveRateLimiter: (_r: unknown, _s: unknown, n: () => void) => n(),
}));

const projectFindUnique = vi.fn();
const projectFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique, findFirst: projectFindFirst },
    analysis: { findFirst: vi.fn() },
  },
}));

const listAnalysesForProject = vi.fn();
vi.mock("../lib/analysis/index.js", () => ({
  AnalysisOrchestrator: class {},
  AnalysisNotRegeneratableError: class extends Error {},
  CostCapExceededError: class extends Error {},
  assertCanStartAnalysis: vi.fn(),
  getAllPersonas: vi.fn(() => []),
  getAnalysisSnapshot: vi.fn(),
  getCostCapStatus: vi.fn(),
  getOrchestrator: vi.fn(() => ({})),
  getStructuredRequirements: vi.fn(),
  persistAnalysisEnhancement: vi.fn(),
  listAnalysesForProject,
  setOrchestratorForTests: vi.fn(),
  updateRequirementRow: vi.fn(),
  ClarificationDialog: class {},
  getDialogState: vi.fn(),
  listApprovalRequests: vi.fn(),
  reviewApprovalRequest: vi.fn(),
  canCreateTickets: vi.fn(),
  deepDiveFinding: vi.fn(),
  loadFindingForDeepDive: vi.fn(),
}));
vi.mock("../lib/analysis/clarify-csv.js", () => ({
  serializeClarifyCsv: vi.fn(),
  serializeClarifyJson: vi.fn(),
  parseClarifyCsv: vi.fn(),
  ClarifyCsvError: class extends Error {},
}));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../lib/ai/index.js", () => ({ buildProvider: vi.fn(), loadAIConfig: vi.fn(() => ({})) }));
vi.mock("../lib/rag/knowledge-service.js", () => ({ getKnowledgeService: vi.fn() }));
vi.mock("../lib/ai/providers/bedrock-direct-provider.js", () => ({
  BedrockDirectProvider: class {},
}));
vi.mock("../lib/scanner/prisma-adapter.js", () => ({ publishAnalysisFinding: vi.fn() }));
vi.mock("../lib/scanner/finding-publisher.js", () => ({ PublishError: class extends Error {} }));

const { initAnalysisRouter } = await import("./analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
  app.use(errorHandler);
  return app;
}

describe("analysis project-scoped subtree — workspace scope (#674)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s a role-permitted caller outside the project's workspace — no oracle", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).get("/api/projects/project-b01/analyses");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(listAnalysesForProject).not.toHaveBeenCalled();
  });

  it("lists analyses for an in-tenant caller", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    projectFindFirst.mockResolvedValueOnce({ id: "project-a01", deletedAt: null });
    listAnalysesForProject.mockResolvedValueOnce([{ id: "an-1" }]);
    const res = await request(app).get("/api/projects/project-a01/analyses");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it("lets a system admin bypass the workspace scope", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    projectFindFirst.mockResolvedValueOnce({ id: "project-b01", deletedAt: null });
    listAnalysesForProject.mockResolvedValueOnce([]);
    const res = await request(app).get("/api/projects/project-b01/analyses");
    expect(res.status).toBe(200);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});
