/**
 * Issue #1097 — cross-project IDOR hardening for the `/projects/:projectId/analyses/:id/*`
 * family (OWASP A01 / BOLA). Same defect class as #1072 / #1073.
 *
 * The router-level `requireProjectAccess()` guard (#674) authorizes the project
 * NAMED IN THE PATH. It cannot catch a handler that then resolves the analysis by
 * BARE id: a legitimate member of project B puts B in the path, clears every
 * project-level check, and reads (or writes) project A's analysis. That residual
 * category is what this suite covers — `server/tests/project-access-guard.test.ts`
 * structurally cannot, because this router IS guarded.
 *
 * Two properties make these tests meaningful rather than tautological:
 *
 *  1. `requireProjectAccess` runs FOR REAL (only `requirePermission` — the
 *     orthogonal role layer — is stubbed). The caller is a genuine non-admin
 *     member of the path project, so every request here legitimately passes the
 *     router guard and is denied (or admitted) purely on analysis↔project scope.
 *  2. `prisma.analysis.findFirst` is backed by a fixture table that HONOURS the
 *     `projectId` predicate only when the handler supplies it. An unscoped
 *     `ensureAnalysisVisible(id)` therefore really does return the foreign row
 *     and the assertion really does fail — these tests fail against the pre-fix
 *     handler rather than passing on a `mockResolvedValue(null)`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ── Fixtures ───────────────────────────────────────────────────────────────
// Workspace A owns proj-a / ana-a. Workspace B (the caller's) owns proj-b / ana-b.
// proj-legacy is a pre-migration, null-workspace project (open to any authed user).
const PROJECTS: Record<string, { id: string; workspaceId: string | null; deletedAt: null }> = {
  "proj-a": { id: "proj-a", workspaceId: "ws-a", deletedAt: null },
  "proj-b": { id: "proj-b", workspaceId: "ws-b", deletedAt: null },
  "proj-legacy": { id: "proj-legacy", workspaceId: null, deletedAt: null },
};
const ANALYSES: Record<string, { id: string; projectId: string; deletedAt: null }> = {
  "ana-a": { id: "ana-a", projectId: "proj-a", deletedAt: null },
  "ana-b": { id: "ana-b", projectId: "proj-b", deletedAt: null },
};

const DRAFT = {
  title: "Draft",
  problemStatement: "Something is wrong.",
  affected: { files: [], requirementIds: [] },
  acceptanceCriteria: [],
  suggestedLabels: [],
};

let currentUser: { userId: string; username: string; role: string; workspaces: string[] } = {
  userId: "user-b",
  username: "ub",
  role: "member",
  workspaces: ["ws-b"],
};

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

// The ROLE layer is orthogonal to object-level scope — stub it open so a denial
// here can only come from the project/analysis ownership check under test.
// `requireProjectAccess` is deliberately NOT mocked.
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

const analysisFindFirst = vi.fn(
  async ({ where }: { where: { id?: string; projectId?: string } }) => {
    const row = where.id ? ANALYSES[where.id] : undefined;
    if (!row) return null;
    // The scope predicate is applied ONLY when the handler passes it — that is
    // precisely what makes an unscoped call observably wrong.
    if (where.projectId !== undefined && row.projectId !== where.projectId) return null;
    return row;
  },
);
const projectFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
  return PROJECTS[where.id] ?? null;
});
const projectFindFirst = vi.fn(async ({ where }: { where: { id?: string } }) => {
  return (where.id ? PROJECTS[where.id] : null) ?? null;
});
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    analysis: { findFirst: analysisFindFirst },
    project: { findUnique: projectFindUnique, findFirst: projectFindFirst },
  },
}));

const getDialogState = vi.fn();
const listApprovalRequests = vi.fn();
const reviewApprovalRequest = vi.fn();
const canCreateTickets = vi.fn();
const loadFindingForDeepDive = vi.fn();
const deepDiveFinding = vi.fn();
const assertCanStartAnalysis = vi.fn();
vi.mock("../lib/analysis/index.js", () => ({
  ANALYSIS_SPECIALIST_AGENT_KEYS: [],
  AnalysisOrchestrator: class {},
  AnalysisNotRegeneratableError: class extends Error {},
  CostCapExceededError: class extends Error {},
  assertCanStartAnalysis,
  getAllPersonas: vi.fn(),
  getAnalysisSnapshot: vi.fn(),
  detectStaticCapability: vi.fn(),
  getCostCapStatus: vi.fn(),
  getOrchestrator: vi.fn(() => ({ provider: {} })),
  getStructuredRequirements: vi.fn(),
  persistAnalysisEnhancement: vi.fn(),
  listAnalysesForProject: vi.fn(),
  setOrchestratorForTests: vi.fn(),
  updateRequirementRow: vi.fn(),
  ClarificationDialog: class {},
  getDialogState,
  listApprovalRequests,
  reviewApprovalRequest,
  canCreateTickets,
  // #1104 — reviewing an approval now retries promotion of the withheld
  // requirements; scoping is asserted on `reviewApprovalRequest` as before.
  promoteApprovedRequirements: vi.fn(async () => ({
    status: "already-promoted" as const,
    requirementCount: 0,
  })),
  deepDiveFinding,
  loadFindingForDeepDive,
  getTraceabilityMatrix: vi.fn(),
  serializeTraceabilityCsv: vi.fn(),
  serializeTraceabilityMarkdown: vi.fn(),
  getGapReport: vi.fn(),
  resolveGapReportDeps: vi.fn(),
  buildFindingIssueDraft: vi.fn(),
  serializeFindingIssueDraftMarkdown: vi.fn(),
  serializeAnalysisReportMarkdown: vi.fn(),
}));
vi.mock("../lib/change-analysis/requirement-diff-service.js", () => ({
  getRequirementDiff: vi.fn(),
}));
vi.mock("../lib/analysis/clarify-csv.js", () => ({
  serializeClarifyCsv: vi.fn(),
  serializeClarifyJson: vi.fn(),
  parseClarifyCsv: vi.fn(),
  ClarifyCsvError: class extends Error {},
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
const publishAnalysisFinding = vi.fn();
vi.mock("../lib/scanner/prisma-adapter.js", () => ({ publishAnalysisFinding }));
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

describe("analyses/:id/* — cross-project scope (#1097)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-b", username: "ub", role: "member", workspaces: ["ws-b"] };
    app = createApp();
  });

  /**
   * Control: the caller really is a legitimate member of proj-b and really is
   * NOT a member of proj-a. Without this, a 404 below could be the router guard
   * firing rather than the handler's own scope check. Note the distinct error
   * code — `NOT_FOUND` is the middleware, `ANALYSIS_NOT_FOUND` is the handler.
   */
  describe("baseline: the router guard is intact and the caller is a genuine member", () => {
    it("404s at requireProjectAccess when the PATH project is foreign", async () => {
      const res = await request(app).get("/api/projects/proj-a/analyses/ana-a/approvals");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(analysisFindFirst).not.toHaveBeenCalled();
    });

    it("admits the caller when the PATH project is their own", async () => {
      listApprovalRequests.mockResolvedValueOnce([]);
      canCreateTickets.mockResolvedValueOnce({
        allowed: true,
        pendingCount: 0,
        rejectedCount: 0,
      });
      const res = await request(app).get("/api/projects/proj-b/analyses/ana-b/approvals");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /:id/approvals", () => {
    it("404s for an analysis owned by another project (was 200 + ticketStatus.allowed)", async () => {
      const res = await request(app).get("/api/projects/proj-b/analyses/ana-a/approvals");

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(analysisFindFirst).toHaveBeenCalledWith({
        where: { id: "ana-a", deletedAt: null, projectId: "proj-b" },
      });
      // The authorization assertion must never be computed for a foreign run.
      expect(listApprovalRequests).not.toHaveBeenCalled();
      expect(canCreateTickets).not.toHaveBeenCalled();
    });

    it("still serves the caller's own analysis (no over-blocking)", async () => {
      listApprovalRequests.mockResolvedValueOnce([{ id: "appr-1", status: "pending" }]);
      canCreateTickets.mockResolvedValueOnce({
        allowed: false,
        pendingCount: 1,
        rejectedCount: 0,
      });

      const res = await request(app).get(
        "/api/projects/proj-b/analyses/ana-b/approvals?status=pending",
      );

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.ticketStatus.pendingCount).toBe(1);
      expect(listApprovalRequests).toHaveBeenCalledWith("ana-b", "pending");
    });

    it("404s for a system admin too — the scope predicate is not a role check", async () => {
      // #1097 was originally probed as an admin, who legitimately reads both
      // projects. Admin bypasses `requireProjectAccess`, so the handler's own
      // analysis↔project predicate is the ONLY thing that can deny here.
      currentUser = { userId: "root", username: "root", role: "admin", workspaces: [] };

      const res = await request(app).get("/api/projects/proj-b/analyses/ana-a/approvals");

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(listApprovalRequests).not.toHaveBeenCalled();
    });

    it("404s through a legacy null-workspace project (open project ≠ open analysis)", async () => {
      // Pre-migration projects are reachable by any authenticated caller, which
      // makes them the widest door onto an unscoped handler.
      currentUser = { userId: "nobody", username: "nb", role: "member", workspaces: [] };

      const res = await request(app).get("/api/projects/proj-legacy/analyses/ana-a/approvals");

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(listApprovalRequests).not.toHaveBeenCalled();
    });
  });

  describe("PUT /:id/approvals/:approvalId", () => {
    it("404s before writing to another project's approval request", async () => {
      const res = await request(app)
        .put("/api/projects/proj-b/analyses/ana-a/approvals/appr-a1")
        .send({ status: "approved" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(analysisFindFirst).toHaveBeenCalledWith({
        where: { id: "ana-a", deletedAt: null, projectId: "proj-b" },
      });
      // Cross-tenant WRITE — the review must not reach the service layer.
      expect(reviewApprovalRequest).not.toHaveBeenCalled();
    });

    it("still reviews the caller's own approval request (no over-blocking)", async () => {
      reviewApprovalRequest.mockResolvedValueOnce({ id: "appr-b1", status: "approved" });

      const res = await request(app)
        .put("/api/projects/proj-b/analyses/ana-b/approvals/appr-b1")
        .send({ status: "approved" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("approved");
      // The nested id stays bound to its parent analysis in the service layer.
      expect(reviewApprovalRequest).toHaveBeenCalledWith(
        "ana-b",
        "appr-b1",
        expect.objectContaining({ status: "approved", reviewerId: "user-b" }),
      );
    });
  });

  describe("GET /:id/clarify", () => {
    it("404s for another project's clarification dialog state", async () => {
      const res = await request(app).get("/api/projects/proj-b/analyses/ana-a/clarify");

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(getDialogState).not.toHaveBeenCalled();
    });

    it("still returns the caller's own dialog state (no over-blocking)", async () => {
      getDialogState.mockResolvedValueOnce({ rounds: [] });

      const res = await request(app).get("/api/projects/proj-b/analyses/ana-b/clarify");

      expect(res.status).toBe(200);
      expect(res.body.data.state).toEqual({ rounds: [] });
      expect(getDialogState).toHaveBeenCalledWith("ana-b");
    });
  });

  describe("POST /:id/findings/:findingId/deep-dive", () => {
    it("404s on the analysis scope before loading the finding", async () => {
      const res = await request(app)
        .post("/api/projects/proj-b/analyses/ana-a/findings/find-1/deep-dive")
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(loadFindingForDeepDive).not.toHaveBeenCalled();
      expect(deepDiveFinding).not.toHaveBeenCalled();
    });

    it("still reaches the finding lookup for the caller's own analysis", async () => {
      loadFindingForDeepDive.mockResolvedValueOnce(null);

      const res = await request(app)
        .post("/api/projects/proj-b/analyses/ana-b/findings/find-1/deep-dive")
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("FINDING_NOT_FOUND");
      expect(loadFindingForDeepDive).toHaveBeenCalledWith({
        projectId: "proj-b",
        analysisId: "ana-b",
        findingId: "find-1",
      });
    });
  });

  describe("POST /:id/findings/:findingId/publish", () => {
    it("404s on the analysis scope before publishing another project's finding", async () => {
      const res = await request(app)
        .post("/api/projects/proj-b/analyses/ana-a/findings/find-1/publish")
        .send({ draft: DRAFT });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(loadFindingForDeepDive).not.toHaveBeenCalled();
      expect(publishAnalysisFinding).not.toHaveBeenCalled();
    });

    it("still reaches the finding lookup for the caller's own analysis", async () => {
      loadFindingForDeepDive.mockResolvedValueOnce(null);

      const res = await request(app)
        .post("/api/projects/proj-b/analyses/ana-b/findings/find-1/publish")
        .send({ draft: DRAFT });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("FINDING_NOT_FOUND");
      expect(loadFindingForDeepDive).toHaveBeenCalledWith({
        projectId: "proj-b",
        analysisId: "ana-b",
        findingId: "find-1",
      });
    });
  });
});
