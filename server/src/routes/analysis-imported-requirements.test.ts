/**
 * Issue #1006 — start an analysis from imported requirements.
 *
 * #706 run 5 had no way to pick imported items for an analysis: pasting five of
 * them into the free-text box produced one requirement, and nothing linked the
 * results back. These pin the route: the project's imported requirements are
 * listed, a selection is loaded PROJECT-SCOPED, each item leads the
 * new-requirements text as one bullet, and the run records the NR-id link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { AuthPayload } from "@metis/shared";

const DEV: AuthPayload = {
  userId: "user-a",
  username: "dev-a",
  role: "developer",
  workspaces: ["ws-a"],
} as AuthPayload;

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: AuthPayload }).user = DEV;
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

interface ReqRow {
  id: string;
  projectId: string;
  title: string;
  type: string;
  externalSource: string | null;
  externalId: string | null;
  externalUrl: string | null;
  deletedAt: Date | null;
}
const rows: ReqRow[] = [];
const requirementFindMany = vi.fn(
  async (args: {
    where: { id?: { in: string[] }; projectId: string; externalSource: { not: null } };
  }) =>
    rows
      .filter(
        (r) =>
          r.projectId === args.where.projectId &&
          r.deletedAt === null &&
          r.externalSource !== null &&
          (!args.where.id || args.where.id.in.includes(r.id)),
      )
      .map(({ projectId: _p, deletedAt: _d, ...rest }) => rest),
);
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      findFirst: vi.fn(async () => ({ id: "proj-a" })),
      // requireProjectAccess (#674): a legacy project with no workspace is open.
      findUnique: vi.fn(async () => ({ workspaceId: null })),
    },
    requirement: { findMany: requirementFindMany },
  },
}));

const start = vi.fn(async (_opts: Record<string, unknown>) => ({ id: "an-new" }));
const orchestrator = { start };

vi.mock("../lib/analysis/index.js", () => ({
  ANALYSIS_SPECIALIST_AGENT_KEYS: ["document", "code", "database", "web"],
  AnalysisOrchestrator: class {},
  AnalysisNotRegeneratableError: class extends Error {},
  CostCapExceededError: class extends Error {},
  assertCanStartAnalysis: vi.fn(),
  getAllPersonas: vi.fn(),
  getAnalysisSnapshot: vi.fn(),
  detectStaticCapability: vi.fn(),
  getCostCapStatus: vi.fn(),
  getOrchestrator: () => orchestrator,
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

const ID = (n: number) => `req-imported-${String(n).padStart(4, "0")}`;
function imported(n: number, title: string, projectId = "proj-a"): ReqRow {
  return {
    id: ID(n),
    projectId,
    title,
    type: "feature",
    externalSource: "github",
    externalId: String(n),
    externalUrl: `https://github.com/miniflux/v2/issues/${n}`,
    deletedAt: null,
  };
}

let app: express.Express;
beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  rows.push(
    imported(1, "Mark all entries as read"),
    imported(2, "Keyboard shortcut to\nstar an entry"),
    imported(3, "Foreign project item", "proj-b"),
    { ...imported(4, "A synthesized requirement"), externalSource: null },
  );
  app = createApp();
});

describe("GET /imported-requirements (#1006)", () => {
  it("lists only this project's imported requirements, with the per-run cap", async () => {
    const res = await request(app).get("/api/projects/proj-a/analyses/imported-requirements");
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([ID(1), ID(2)]);
    expect(res.body.data.maxSelectable).toBe(8);
  });
});

describe("POST / with importedRequirementIds (#1006)", () => {
  it("leads the new-requirements text with one bullet per item and records the link", async () => {
    const res = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ importedRequirementIds: [ID(2), ID(1)], extraInstructions: "Also export OPML." });
    expect(res.status).toBe(202);
    const opts = start.mock.calls[0][0];
    expect(opts.extraInstructions).toBe(
      "- Keyboard shortcut to star an entry\n- Mark all entries as read\n\nAlso export OPML.",
    );
    expect(opts.sourceRequirements).toEqual([
      {
        candidateId: "NR-1",
        requirementId: ID(2),
        title: "Keyboard shortcut to star an entry",
        externalSource: "github",
        externalId: "2",
        externalUrl: "https://github.com/miniflux/v2/issues/2",
      },
      expect.objectContaining({ candidateId: "NR-2", requirementId: ID(1) }),
    ]);
  });

  it("404s an id from another project, and never starts a run", async () => {
    const res = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ importedRequirementIds: [ID(1), ID(3)] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("IMPORTED_REQUIREMENT_NOT_FOUND");
    expect(start).not.toHaveBeenCalled();
  });

  it("404s a requirement that was not imported", async () => {
    const res = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ importedRequirementIds: [ID(4)] });
    expect(res.status).toBe(404);
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses more imported requirements than one run analyses individually", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => ID(100 + i));
    const res = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ importedRequirementIds: ids });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IMPORTED_REQUIREMENTS_OVER_CAP");
    expect(requirementFindMany).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("a plain run carries no source requirements", async () => {
    const res = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ extraInstructions: "Export OPML." });
    expect(res.status).toBe(202);
    const opts = start.mock.calls[0][0];
    expect(opts.extraInstructions).toBe("Export OPML.");
    expect(opts).not.toHaveProperty("sourceRequirements");
  });
});
