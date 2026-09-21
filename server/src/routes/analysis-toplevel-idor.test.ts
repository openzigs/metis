/**
 * Issue #1099 — cross-tenant hardening for the top-level `/api/analyses` router.
 *
 * That router is mounted at `/api/analyses` with no `:projectId` in the path, so
 * the `requireProjectAccess()` chokepoint (#674) cannot gate it. Before this
 * change every route on it was gated by `requireAuth` + a GLOBAL-role
 * `requirePermission(...)` only, so any authenticated caller holding the
 * ordinary `analysis.read` role (`reader`, the lowest role) could read the full
 * snapshot — findings and requirements — of ANY analysis in the deployment by
 * id, and any `developer` could cancel / regenerate / resume / edit another
 * tenant's run.
 *
 * `requirePermission` is deliberately NOT mocked here: it is pure (role →
 * permission matrix, no DB), so using the real middleware proves these routes
 * are reachable by the real lowest-privileged roles and that the 404 comes from
 * the new object-level check rather than from the role gate. Prisma IS mocked so
 * no database is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { AuthPayload } from "@metis/shared";

/** Workspace-A analysis every out-of-tenant caller below tries to reach. */
const ANALYSIS = { id: "an-1", projectId: "proj-a", deletedAt: null };

const READER_WS_B: AuthPayload = {
  userId: "user-b",
  username: "reader-b",
  role: "reader",
  workspaces: ["ws-b"],
} as AuthPayload;
const DEV_WS_B: AuthPayload = {
  userId: "user-b",
  username: "dev-b",
  role: "developer",
  workspaces: ["ws-b"],
} as AuthPayload;
const DEV_WS_A: AuthPayload = {
  userId: "user-a",
  username: "dev-a",
  role: "developer",
  workspaces: ["ws-a"],
} as AuthPayload;
const SYS_ADMIN: AuthPayload = {
  userId: "user-root",
  username: "root",
  role: "admin",
  workspaces: [],
} as AuthPayload;

let currentUser: AuthPayload = READER_WS_B;
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: AuthPayload }).user = currentUser;
    next();
  },
}));

vi.mock("../middleware/analysis-deepdive-rate-limit.js", () => ({
  analysisDeepDiveRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

const analysisFindFirst = vi.fn();
/** `assertProjectAccess` resolves the owning project's workspace through this. */
const projectFindUnique = vi.fn(async () => ({ workspaceId: "ws-a" }));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    analysis: { findFirst: analysisFindFirst },
    project: { findUnique: projectFindUnique },
  },
}));

const cancel = vi.fn(async () => true);
const assertCanRegenerate = vi.fn(async () => undefined);
const regenerateAgent = vi.fn(async () => undefined);
const assertCanResumeRepos = vi.fn(async () => ({ skippedRepos: [{ connectorId: "c1" }] }));
const resumeSkippedRepos = vi.fn(async () => undefined);
const orchestrator = {
  cancel,
  assertCanRegenerate,
  regenerateAgent,
  assertCanResumeRepos,
  resumeSkippedRepos,
};

const getAnalysisSnapshot = vi.fn(async () => ({ id: "an-1", status: "completed" }));
const updateRequirementRow = vi.fn(async () => ({ id: "req-1" }));

vi.mock("../lib/analysis/index.js", () => ({
  ANALYSIS_SPECIALIST_AGENT_KEYS: ["document", "code", "database", "web"],
  AnalysisOrchestrator: class {},
  AnalysisNotRegeneratableError: class extends Error {},
  CostCapExceededError: class extends Error {},
  assertCanStartAnalysis: vi.fn(),
  getAllPersonas: vi.fn(),
  getAnalysisSnapshot,
  detectStaticCapability: vi.fn(),
  getCostCapStatus: vi.fn(),
  getOrchestrator: () => orchestrator,
  getStructuredRequirements: vi.fn(),
  persistAnalysisEnhancement: vi.fn(),
  listAnalysesForProject: vi.fn(),
  setOrchestratorForTests: vi.fn(),
  updateRequirementRow,
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
  resolveGapReportDeps: vi.fn(),
  buildFindingIssueDraft: vi.fn(),
  serializeFindingIssueDraftMarkdown: vi.fn(),
  serializeAnalysisReportMarkdown: vi.fn(),
}));

vi.mock("../lib/change-analysis/requirement-diff-service.js", () => ({
  getRequirementDiff: vi.fn(),
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

/** Every top-level route that addresses an analysis by bare id. */
const ROUTES = [
  {
    name: "GET /:id",
    call: (app: express.Express) => request(app).get("/api/analyses/an-1"),
    /** Lowest global role that clears this route's `requirePermission`. */
    outsider: READER_WS_B,
    insider: DEV_WS_A,
    okStatus: 200,
    sideEffects: () => [getAnalysisSnapshot],
  },
  {
    name: "POST /:id/cancel",
    call: (app: express.Express) => request(app).post("/api/analyses/an-1/cancel"),
    outsider: DEV_WS_B,
    insider: DEV_WS_A,
    okStatus: 200,
    sideEffects: () => [cancel],
  },
  {
    name: "POST /:id/agents/:agentKey/regenerate",
    call: (app: express.Express) =>
      request(app).post("/api/analyses/an-1/agents/document/regenerate"),
    outsider: DEV_WS_B,
    insider: DEV_WS_A,
    okStatus: 202,
    sideEffects: () => [assertCanRegenerate, regenerateAgent],
  },
  {
    name: "POST /:id/resume-repos",
    call: (app: express.Express) => request(app).post("/api/analyses/an-1/resume-repos"),
    outsider: DEV_WS_B,
    insider: DEV_WS_A,
    okStatus: 202,
    sideEffects: () => [assertCanResumeRepos, resumeSkippedRepos],
  },
  {
    name: "PATCH /:id/requirements/:reqId",
    call: (app: express.Express) =>
      request(app)
        .patch("/api/analyses/an-1/requirements/req-1")
        .send({ reviewStatus: "approved" }),
    outsider: DEV_WS_B,
    insider: DEV_WS_A,
    okStatus: 200,
    sideEffects: () => [updateRequirementRow],
  },
] as const;

describe("/api/analyses top-level router — cross-tenant scope (#1099)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    analysisFindFirst.mockResolvedValue({ ...ANALYSIS });
    projectFindUnique.mockResolvedValue({ workspaceId: "ws-a" });
    getAnalysisSnapshot.mockResolvedValue({ id: "an-1", status: "completed" });
    assertCanResumeRepos.mockResolvedValue({ skippedRepos: [{ connectorId: "c1" }] });
    updateRequirementRow.mockResolvedValue({ id: "req-1" });
    currentUser = READER_WS_B;
    app = createApp();
  });

  for (const route of ROUTES) {
    describe(route.name, () => {
      it("404s for a non-admin caller who is not a member of the analysis's workspace", async () => {
        currentUser = route.outsider;

        const res = await route.call(app);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
        // The denial must fire before ANY work happens on the foreign analysis.
        for (const fn of route.sideEffects()) expect(fn).not.toHaveBeenCalled();
      });

      it("is byte-identical to an unknown id, so it is not an existence oracle", async () => {
        currentUser = route.outsider;
        const denied = await route.call(app);

        vi.clearAllMocks();
        analysisFindFirst.mockResolvedValue(null); // unknown id
        const unknown = await route.call(app);

        expect(denied.status).toBe(unknown.status);
        expect(denied.body.error).toEqual(unknown.body.error);
      });

      it("still succeeds for a member of the analysis's own workspace", async () => {
        currentUser = route.insider;

        const res = await route.call(app);

        expect(res.status).toBe(route.okStatus);
      });

      it("still succeeds for a system admin (bypass), without resolving the project", async () => {
        currentUser = SYS_ADMIN;

        const res = await route.call(app);

        expect(res.status).toBe(route.okStatus);
        // `assertProjectAccess` short-circuits on `role === "admin"`.
        expect(projectFindUnique).not.toHaveBeenCalled();
      });

      it("stays reachable for a legacy project with no workspace assigned", async () => {
        currentUser = route.outsider;
        projectFindUnique.mockResolvedValue({ workspaceId: null });

        const res = await route.call(app);

        expect(res.status).toBe(route.okStatus);
      });

      it("scopes the authorization check to the analysis's OWN projectId", async () => {
        currentUser = route.outsider;

        await route.call(app);

        expect(projectFindUnique).toHaveBeenCalledWith({
          where: { id: "proj-a" },
          select: { workspaceId: true },
        });
      });
    });
  }

  it("GET /:id 404s when the snapshot vanishes between the guard and the read", async () => {
    currentUser = DEV_WS_A;
    getAnalysisSnapshot.mockResolvedValue(null as never);

    const res = await request(app).get("/api/analyses/an-1");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
  });

  it("propagates a non-404 authorization failure instead of masking it as NOT_FOUND", async () => {
    // Only a 404 from the seam means "out of tenant". Anything else (a database
    // outage here) must surface as itself — silently 404ing would hide a fault.
    currentUser = DEV_WS_B;
    projectFindUnique.mockRejectedValue(new Error("database unavailable") as never);

    const res = await request(app).get("/api/analyses/an-1");

    expect(res.status).toBe(500);
    expect(res.body.error.code).not.toBe("ANALYSIS_NOT_FOUND");
    expect(getAnalysisSnapshot).not.toHaveBeenCalled();
  });

  it("regenerate still rejects an unknown agent key before touching the analysis", async () => {
    currentUser = DEV_WS_A;

    const res = await request(app).post("/api/analyses/an-1/agents/nope/regenerate");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_AGENT_KEY");
  });

  it("PATCH requirements 404s for a requirement outside the analysis, for an in-tenant caller", async () => {
    currentUser = DEV_WS_A;
    updateRequirementRow.mockResolvedValue(null as never);

    const res = await request(app)
      .patch("/api/analyses/an-1/requirements/req-x")
      .send({ reviewStatus: "approved" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
  });

  it("resume-repos is a no-op 200 when nothing was skipped, for an in-tenant caller", async () => {
    currentUser = DEV_WS_A;
    assertCanResumeRepos.mockResolvedValue({ skippedRepos: [] as never });

    const res = await request(app).post("/api/analyses/an-1/resume-repos");

    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(false);
    expect(resumeSkippedRepos).not.toHaveBeenCalled();
  });

  describe("routes with no analysis in the path are untouched", () => {
    it("GET /personas stays open to any authenticated caller", async () => {
      currentUser = READER_WS_B;
      const res = await request(app).get("/api/analyses/personas");
      expect(res.status).toBe(200);
      expect(analysisFindFirst).not.toHaveBeenCalled();
    });

    it("GET /cost-cap stays a deployment-wide read for analysis.read holders", async () => {
      currentUser = READER_WS_B;
      const res = await request(app).get("/api/analyses/cost-cap");
      expect(res.status).toBe(200);
      expect(analysisFindFirst).not.toHaveBeenCalled();
    });
  });
});
