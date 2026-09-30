/**
 * Route tests for the analysis model-recommendation endpoint (#1095).
 *
 * The bug these guard: the endpoint took no parameter describing the run, so it
 * classified the constant string "Analyze project documents and codebase" and
 * answered `tokenEstimate: 16` / `reasoningDepth: "simple"` / `$0.0000` for every
 * project — including one whose next run cost 185,167 tokens.
 *
 * A test asserting "a tokenEstimate is present" passes against that bug, so these
 * assertions are differential: two different run shapes must yield two different
 * estimates, and the no-history case must yield NO number rather than a plausible
 * one. If someone reintroduces a constant estimate, "reacts to the number of
 * selected agents" and "reacts to the project's own history" both fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Authenticate as a NON-admin by default: `assertProjectAccess` short-circuits
 * for admins, so an admin-only suite could not observe an object-level hole.
 */
let currentUser: { userId: string; role: string; workspaces: string[] } = {
  userId: "user-1",
  role: "coordinator",
  workspaces: ["ws-1"],
};

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = currentUser;
    next();
  },
}));

vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));

const projectFindFirst = vi.fn();
/** Used by `assertProjectAccess` to resolve the target project's workspace. */
const projectFindUnique = vi.fn();
const modelPreferenceFindUnique = vi.fn();
const analysisFindMany = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      findFirst: (...a: unknown[]) => projectFindFirst(...a),
      findUnique: (...a: unknown[]) => projectFindUnique(...a),
    },
    modelPreference: { findUnique: (...a: unknown[]) => modelPreferenceFindUnique(...a) },
    analysis: { findMany: (...a: unknown[]) => analysisFindMany(...a) },
  },
}));

/**
 * #512 — the recommendation reports the model the ACTIVE provider will run.
 * Default: a Claude-serving provider (the Bedrock gateway), so the tier routing
 * the #1095 tests exercise is in force; the #512 block swaps in DeepSeek.
 */
interface FakeProvider {
  key: string;
  model: string;
  servesRouterModel?: (id: string) => boolean;
}
const claudeGateway: FakeProvider = {
  key: "bedrock-gateway",
  model: "us.anthropic.claude-sonnet-5",
  servesRouterModel: () => true,
};
let activeProvider: FakeProvider = claudeGateway;
const buildProviderMock = vi.fn(() => activeProvider);
const loadAIConfigMock = vi.fn(() => ({ provider: activeProvider.key }));

vi.mock("../lib/ai/providers/factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai/providers/factory.js")>()),
  buildProvider: (...a: unknown[]) => buildProviderMock(...(a as [])),
}));
vi.mock("../lib/ai/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai/config.js")>()),
  loadAIConfig: (...a: unknown[]) => loadAIConfigMock(...(a as [])),
}));

const { initModelRecommendationRouter } = await import("./model-preferences.js");
const { errorHandler } = await import("../middleware/error-handler.js");

/** Metadata exactly as `createAnalysis` writes it. */
const metaWithAgents = (n: number): string =>
  JSON.stringify({
    agentKeys: ["document", "code", "database", "web"].slice(0, n),
    documentIds: [],
  });

/** The run reported in #1095: 185,167 tokens across 4 agents. */
const REPORTED_HISTORY = [{ totalTokens: 185_167, metadata: metaWithAgents(4) }];

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/analyses/model-recommendation", initModelRecommendationRouter());
  app.use(errorHandler);
  return app;
}

interface RecommendationBody {
  success: boolean;
  data: {
    profile: {
      tokenEstimate: number | null;
      reasoningDepth: string;
      latencySLA: string;
      taskType: string;
    };
    selection: {
      modelId: string;
      modelName: string;
      estimatedCost: number | null;
      rationale: string;
    };
    estimate: { tokens: number | null; basis: string; sampleSize: number };
  };
}

async function post(body: Record<string, unknown>): Promise<RecommendationBody> {
  const res = await request(buildApp())
    .post("/projects/proj-1/analyses/model-recommendation")
    .send(body);
  expect(res.status).toBe(200);
  return res.body as RecommendationBody;
}

describe("POST /projects/:projectId/analyses/model-recommendation (#1095)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
    activeProvider = claudeGateway;
    projectFindFirst.mockResolvedValue({ id: "proj-1" });
    // Default: the path project lives in a workspace the caller belongs to.
    projectFindUnique.mockResolvedValue({
      workspaceId: "ws-1",
      workspace: { deletedAt: null, members: [{ id: "member-row" }] },
    });
    modelPreferenceFindUnique.mockResolvedValue(null);
    // Two calls hit `analysis.findMany`: prior-run history, then this month's
    // project usage. Both are satisfied by the same rows here.
    analysisFindMany.mockResolvedValue(REPORTED_HISTORY);
  });

  it("reacts to the number of selected agents", async () => {
    const two = await post({ agentKeys: ["document", "code"], requirementText: "Fix checkout." });
    const four = await post({
      agentKeys: ["document", "code", "database", "web"],
      requirementText: "Fix checkout.",
    });

    expect(two.data.profile.tokenEstimate).not.toBe(four.data.profile.tokenEstimate);
    expect(four.data.profile.tokenEstimate).toBe((two.data.profile.tokenEstimate as number) * 2);
  });

  it("reacts to the project's own measured history", async () => {
    analysisFindMany.mockResolvedValue([{ totalTokens: 4_000, metadata: metaWithAgents(4) }]);
    const cheap = await post({ agentKeys: ["document", "code", "database", "web"] });

    analysisFindMany.mockResolvedValue(REPORTED_HISTORY);
    const expensive = await post({ agentKeys: ["document", "code", "database", "web"] });

    expect(cheap.data.profile.tokenEstimate).not.toBe(expensive.data.profile.tokenEstimate);
    expect(expensive.data.profile.tokenEstimate as number).toBeGreaterThan(
      cheap.data.profile.tokenEstimate as number,
    );
  });

  it("never answers the old constant 16 / $0.0000 for a project with history", async () => {
    const body = await post({
      agentKeys: ["document", "code", "database", "web"],
      requirementText: "Enforce inventory availability at checkout.",
    });

    expect(body.data.profile.tokenEstimate).not.toBe(16);
    expect(body.data.profile.tokenEstimate as number).toBeGreaterThan(100_000);
    // The displayed cost is no longer rounded-to-zero noise.
    expect(body.data.selection.estimatedCost as number).toBeGreaterThan(0.01);
    expect(body.data.estimate.basis).toBe("prior-runs");
  });

  it("routes a heavy measured workload away from 'simple task' Haiku", async () => {
    const body = await post({
      agentKeys: ["document", "code", "database", "web"],
      requirementText: "Fix checkout.",
    });

    expect(body.data.profile.reasoningDepth).toBe("complex");
    expect(body.data.selection.modelId).toContain("sonnet");
    expect(body.data.selection.rationale).not.toContain("Simple task");
  });

  it("shows nothing rather than a fabricated number when the project has no history", async () => {
    analysisFindMany.mockResolvedValue([]);
    const body = await post({ agentKeys: ["document", "code"] });

    expect(body.data.profile.tokenEstimate).toBeNull();
    expect(body.data.selection.estimatedCost).toBeNull();
    expect(body.data.estimate.basis).toBe("no-history");
    expect(body.data.estimate.sampleSize).toBe(0);
  });

  it("classifies the requirement text the user actually typed", async () => {
    analysisFindMany.mockResolvedValue([]); // isolate text-driven classification
    const simple = await post({
      agentKeys: ["document"],
      requirementText: "List the order tables.",
    });
    const complex = await post({
      agentKeys: ["document"],
      requirementText: "Evaluate the trade-offs of atomic inventory reservation at checkout.",
    });

    expect(simple.data.profile.reasoningDepth).not.toBe(complex.data.profile.reasoningDepth);
    expect(complex.data.profile.taskType).toBe("synthesis");
  });

  it("classifies a long requirement paste in full rather than truncating it", async () => {
    analysisFindMany.mockResolvedValue([]);
    // The only classifying phrase sits at the very END, past any URL-sized
    // truncation point. If the tail were dropped this reads as plain "analysis".
    const long = `${"Requirement text. ".repeat(400)}Evaluate the trade-offs of atomic reservation.`;
    expect(long.length).toBeGreaterThan(7_000);

    const body = await post({ agentKeys: ["code"], requirementText: long });
    expect(body.data.profile.taskType).toBe("synthesis");
  });

  it("honours a force override", async () => {
    const body = await post({ agentKeys: ["document"], override: "force-haiku" });
    expect(body.data.selection.modelId).toContain("haiku");
    expect(body.data.selection.rationale).toContain("forced Haiku");
  });

  it("rejects a malformed run shape", async () => {
    const res = await request(buildApp())
      .post("/projects/proj-1/analyses/model-recommendation")
      .send({ agentKeys: "not-an-array" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("404s for an unknown project", async () => {
    projectFindFirst.mockResolvedValue(null);
    const res = await request(buildApp())
      .post("/projects/nope/analyses/model-recommendation")
      .send({ agentKeys: [] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  describe("object-level scope (requireProjectAccess, #674)", () => {
    it("404s a non-member POSTing against another tenant's project", async () => {
      projectFindUnique.mockResolvedValue({
        workspaceId: "ws-other",
        workspace: { deletedAt: null, members: [{ id: "member-row" }] },
      });
      const res = await request(buildApp())
        .post("/projects/proj-victim/analyses/model-recommendation")
        .send({ agentKeys: ["code"] });

      expect(res.status).toBe(404);
      // Denied BEFORE any run history is read — no cross-tenant usage oracle.
      expect(analysisFindMany).not.toHaveBeenCalled();
    });

    it("404s a non-member GETting another tenant's project", async () => {
      projectFindUnique.mockResolvedValue({
        workspaceId: "ws-other",
        workspace: { deletedAt: null, members: [{ id: "member-row" }] },
      });
      const res = await request(buildApp()).get(
        "/projects/proj-victim/analyses/model-recommendation",
      );

      expect(res.status).toBe(404);
      expect(analysisFindMany).not.toHaveBeenCalled();
    });

    it("admits a member of the project's workspace", async () => {
      projectFindUnique.mockResolvedValue({
        workspaceId: "ws-1",
        workspace: { deletedAt: null, members: [{ id: "member-row" }] },
      });
      const res = await request(buildApp())
        .post("/projects/proj-1/analyses/model-recommendation")
        .send({ agentKeys: ["code"] });
      expect(res.status).toBe(200);
    });
  });

  it("still serves GET, reading the run shape from query params", async () => {
    const res = await request(buildApp()).get(
      "/projects/proj-1/analyses/model-recommendation?override=auto&agentKeys=document,code",
    );
    expect(res.status).toBe(200);
    const body = res.body as RecommendationBody;
    // 2 of 4 agents against the reported history.
    expect(body.data.profile.tokenEstimate).toBe(92_584);
  });

  describe("the model the run will actually use (#512)", () => {
    const deepSeek: FakeProvider = {
      key: "anthropic",
      model: "deepseek-v4-pro",
      servesRouterModel: () => false,
    };

    it("names a Claude tier model on a provider that serves Claude tier ids", async () => {
      const body = await post({ agentKeys: ["document", "code", "database", "web"] });
      expect(body.data.selection.modelId).toBe("us.anthropic.claude-sonnet-5");
      expect(body.data.selection.modelName).toBe("Claude Sonnet 5");
      expect(buildProviderMock).toHaveBeenCalledWith({
        config: loadAIConfigMock.mock.results[0]?.value,
      });
    });

    it("names the provider's configured model on a non-Claude provider", async () => {
      activeProvider = deepSeek;
      const body = await post({ agentKeys: ["document", "code", "database", "web"] });
      expect(body.data.selection.modelId).toBe("deepseek-v4-pro");
      expect(body.data.selection.modelName).toBe("deepseek-v4-pro");
      expect(body.data.selection.modelName).not.toContain("Claude");
      expect(body.data.selection.estimatedCost).toBeNull();
    });

    it("names the configured model even when a Claude tier is forced", async () => {
      activeProvider = deepSeek;
      const body = await post({ agentKeys: ["document"], override: "force-opus" });
      expect(body.data.selection.modelId).toBe("deepseek-v4-pro");
    });

    // Review of PR #523 — the card must read the provider the run uses: the
    // booted orchestrator's, not a fresh one built from the (possibly changed)
    // config on every request.
    it("uses the booted analysis orchestrator's provider when there is one", async () => {
      const { setOrchestratorForTests } = await import("../lib/analysis/orchestrator.js");
      setOrchestratorForTests({ provider: deepSeek } as never);
      try {
        const body = await post({ agentKeys: ["document"], override: "force-sonnet" });
        expect(body.data.selection.modelId).toBe("deepseek-v4-pro");
        expect(buildProviderMock).not.toHaveBeenCalled();
        expect(loadAIConfigMock).not.toHaveBeenCalled();
      } finally {
        setOrchestratorForTests(null);
      }
    });

    it("still answers (with tier routing) when the AI config cannot be loaded", async () => {
      loadAIConfigMock.mockImplementationOnce(() => {
        throw new Error("Invalid AI configuration");
      });
      const body = await post({ agentKeys: ["document", "code", "database", "web"] });
      expect(body.data.selection.modelId).toBe("us.anthropic.claude-sonnet-5");
    });
  });
});
