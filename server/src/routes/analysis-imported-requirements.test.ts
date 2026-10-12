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

/**
 * Evaluate the subset of a Prisma `where` this route uses AGAINST the rows — no
 * predicate is hard-coded here, so deleting one from production (say
 * `externalSource: { not: null }`) lets the excluded row through and the tests
 * that pin it go red. An operator this does not know throws rather than passes.
 */
type Where = Record<string, unknown>;
function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object") return value === cond;
  return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
    if (op === "not") return value !== arg;
    if (op === "in") return (arg as unknown[]).includes(value);
    if (op === "contains") return typeof value === "string" && value.includes(String(arg));
    throw new Error(`mock where: unsupported operator ${op}`);
  });
}
function matches(row: ReqRow, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    if (key === "AND") return (cond as Where[]).every((w) => matches(row, w));
    if (!(key in row)) throw new Error(`mock where: unknown field ${key}`);
    return matchField(row[key as keyof ReqRow], cond);
  });
}
const requirementFindMany = vi.fn(async (args: { where: Where; take?: number }) =>
  rows
    .filter((r) => matches(r, args.where))
    .slice(0, args.take)
    .map(({ projectId: _p, deletedAt: _d, ...rest }) => rest),
);
const requirementCount = vi.fn(
  async (args: { where: Where }) => rows.filter((r) => matches(r, args.where)).length,
);
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      findFirst: vi.fn(async () => ({ id: "proj-a" })),
      // requireProjectAccess (#674): a legacy project with no workspace is open.
      findUnique: vi.fn(async () => ({ workspaceId: null })),
    },
    requirement: { findMany: requirementFindMany, count: requirementCount },
  },
  resolveDatabaseProvider: () => "sqlite",
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
    expect(res.body.data).toMatchObject({ total: 2, truncated: false, maxSelectable: 8 });
  });

  it("narrows by ?q= on the title, and by issue number with or without a leading #", async () => {
    const byTitle = await request(app).get(
      "/api/projects/proj-a/analyses/imported-requirements?q=star",
    );
    expect(byTitle.body.data.items.map((i: { id: string }) => i.id)).toEqual([ID(2)]);
    expect(byTitle.body.data).toMatchObject({ total: 1, truncated: false });

    const byNumber = await request(app).get(
      "/api/projects/proj-a/analyses/imported-requirements?q=%231",
    );
    expect(byNumber.body.data.items.map((i: { id: string }) => i.id)).toEqual([ID(1)]);
  });

  it("says when the listing is cut at its cap, so an older row is found by searching", async () => {
    const { IMPORTED_REQUIREMENT_LIST_LIMIT } =
      await import("../lib/analysis/imported-requirement-input.js");
    for (let n = 10; n < 10 + IMPORTED_REQUIREMENT_LIST_LIMIT; n += 1) {
      rows.push(imported(n, `Bulk item ${n}`));
    }
    const all = await request(app).get("/api/projects/proj-a/analyses/imported-requirements");
    expect(all.body.data.items).toHaveLength(IMPORTED_REQUIREMENT_LIST_LIMIT);
    expect(all.body.data).toMatchObject({
      total: IMPORTED_REQUIREMENT_LIST_LIMIT + 2,
      truncated: true,
    });

    const found = await request(app).get(
      "/api/projects/proj-a/analyses/imported-requirements?q=Keyboard",
    );
    expect(found.body.data.items.map((i: { id: string }) => i.id)).toEqual([ID(2)]);
    expect(found.body.data.truncated).toBe(false);
  });

  it("never offers more picks than the per-analysis schema accepts, even if the operator cap is higher", async () => {
    const { getConfigService } = await import("../lib/config/config-service.js");
    const spy = vi.spyOn(getConfigService(), "getNumber").mockReturnValue(100);
    try {
      const res = await request(app).get("/api/projects/proj-a/analyses/imported-requirements");
      expect(res.body.data.maxSelectable).toBe(25);
    } finally {
      spy.mockRestore();
    }
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

// #1027 — the plan context travels beside the requirements text; the route never
// joins the two, so the splitter and its cap see only the requirements.
describe("POST / with agentContext (#1027)", () => {
  const CONTEXT = "Tasks (tasks.md):\n- T01: Add a ninth requirement\n- T02: And a tenth";

  it("forwards it apart from the requirements text", async () => {
    const res = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ extraInstructions: "AC-1: Reject a duplicate feed.", agentContext: CONTEXT });
    expect(res.status).toBe(202);
    const opts = start.mock.calls[0][0];
    expect(opts.agentContext).toBe(CONTEXT);
    expect(opts.extraInstructions).toBe("AC-1: Reject a duplicate feed.");
  });

  it("keeps it out of the text composed from imported requirements", async () => {
    const res = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ importedRequirementIds: [ID(1)], agentContext: CONTEXT });
    expect(res.status).toBe(202);
    const opts = start.mock.calls[0][0];
    expect(opts.extraInstructions).toBe("- Mark all entries as read");
    expect(opts.sourceRequirements).toHaveLength(1);
  });

  it("adds no key to a run started without it", async () => {
    await request(app).post("/api/projects/proj-a/analyses").send({ extraInstructions: "x" });
    expect(start.mock.calls[0][0]).not.toHaveProperty("agentContext");
  });

  it("refuses a context over the limit, an empty one and a non-string", async () => {
    const { MAX_ANALYSIS_AGENT_CONTEXT } = await import("@metis/shared");
    for (const agentContext of [
      "x".repeat(MAX_ANALYSIS_AGENT_CONTEXT + 1),
      "",
      // Review of #1027 — whitespace only is empty, not a context.
      "   ",
      " \n\t ",
      ["T01"],
      7,
    ]) {
      const res = await request(app)
        .post("/api/projects/proj-a/analyses")
        .send({ extraInstructions: "x", agentContext });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(start).not.toHaveBeenCalled();
    const atLimit = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ agentContext: "x".repeat(MAX_ANALYSIS_AGENT_CONTEXT) });
    expect(atLimit.status).toBe(202);
  });

  it("forwards the context trimmed, and measures the limit after trimming", async () => {
    const { MAX_ANALYSIS_AGENT_CONTEXT } = await import("@metis/shared");
    const padded = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ agentContext: `\n  ${CONTEXT}  \n` });
    expect(padded.status).toBe(202);
    expect(start.mock.calls[0][0].agentContext).toBe(CONTEXT);
    const atLimit = await request(app)
      .post("/api/projects/proj-a/analyses")
      .send({ agentContext: `  ${"x".repeat(MAX_ANALYSIS_AGENT_CONTEXT)}\n` });
    expect(atLimit.status).toBe(202);
    expect(start.mock.calls[1][0].agentContext).toHaveLength(MAX_ANALYSIS_AGENT_CONTEXT);
  });

  // Review of #1027 — the handoff record's "sent as context" labels are shown
  // on the analysis page, and the caller writes them. The server refuses a
  // record naming a component or task the context text does not hold.
  describe("a handoff record's context labels are checked against the text", () => {
    const record = (context: { components: string[]; tasks: string[]; omitted: string[] }) => ({
      artifacts: ["spec.md", "plan.md", "tasks.md"],
      sent: [],
      omitted: [],
      context,
    });
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post("/api/projects/proj-a/analyses")
        .send({ extraInstructions: "AC-1: Reject a duplicate feed.", ...body });

    it("accepts labels the text holds", async () => {
      const res = await post({
        agentContext: `Plan components (plan.md):\n- FeedStore — x\n${CONTEXT}`,
        specKitHandoff: record({
          components: ["FeedStore"],
          tasks: ["T01", "T02"],
          omitted: ["T03"],
        }),
      });
      expect(res.status).toBe(202);
      expect(start.mock.calls[0][0].specKitHandoff).toMatchObject({
        context: { tasks: ["T01", "T02"] },
      });
    });

    it("refuses a task or component the text does not hold, naming no label", async () => {
      for (const context of [
        { components: [], tasks: ["T01", "T09"], omitted: [] },
        { components: ["Harmless"], tasks: ["T01"], omitted: [] },
      ]) {
        const res = await post({ agentContext: CONTEXT, specKitHandoff: record(context) });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(res.body)).toContain(
          "1 context label(s) do not appear in agentContext",
        );
        expect(JSON.stringify(res.body)).not.toContain("T09");
        expect(JSON.stringify(res.body)).not.toContain("Harmless");
      }
      expect(start).not.toHaveBeenCalled();
    });

    it("refuses a record that claims context when none was sent", async () => {
      const res = await post({
        specKitHandoff: record({ components: [], tasks: ["T01"], omitted: [] }),
      });
      expect(res.status).toBe(400);
      expect(start).not.toHaveBeenCalled();
    });

    it("accepts a record with no context, or one that sent none", async () => {
      const none = await post({
        specKitHandoff: { artifacts: ["spec.md"], sent: ["AC-1"], omitted: [] },
      });
      expect(none.status).toBe(202);
      const empty = await post({
        specKitHandoff: record({ components: [], tasks: [], omitted: ["T01"] }),
      });
      expect(empty.status).toBe(202);
      const unrecognised = await post({
        specKitHandoff: {
          ...record({ components: [], tasks: [], omitted: [] }),
          context: { components: [], tasks: [], omitted: [], unrecognised: ["plan.md"] },
        },
      });
      expect(unrecognised.status).toBe(202);
      expect(start.mock.calls[2][0].specKitHandoff).toMatchObject({
        context: { unrecognised: ["plan.md"] },
      });
    });

    it("refuses an unrecognised file that is not plan.md or tasks.md", async () => {
      const res = await post({
        specKitHandoff: {
          artifacts: ["spec.md"],
          sent: [],
          omitted: [],
          context: { components: [], tasks: [], omitted: [], unrecognised: ["spec.md"] },
        },
      });
      expect(res.status).toBe(400);
    });
  });
});
