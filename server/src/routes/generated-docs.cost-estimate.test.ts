/**
 * #2189 — `GET /api/projects/:projectId/docs/cost-estimate`: the Generate
 * form's cost estimate for a business-requirements document of the chosen
 * scope. The estimate itself is `lib/docs-gen/cost-estimate.ts` (tested there);
 * this checks the route: the scope it passes, its validation, the project
 * scope gate, and the answer for a repository with no code graph.
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
  refreshAuthenticatedUser: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));

const projectFindUnique = vi.fn();
const generatedDocumentFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    generatedDocument: { findFirst: generatedDocumentFindFirst },
  },
  Prisma: { DbNull: Symbol("DbNull") },
}));
vi.mock("../lib/reviews/approval-gate.js", () => ({ assertDocumentExportable: vi.fn() }));
vi.mock("../lib/socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: vi.fn(() => "failed"),
}));

const requireRepositoryGraph = vi.fn();
vi.mock("../lib/docs-gen/evidence-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/docs-gen/evidence-policy.js")>()),
  requireRepositoryGraph,
}));

const MODELS = {
  phase1: { provider: "anthropic", model: "claude-sonnet-5-5" },
  phase2: { provider: "anthropic", model: "claude-sonnet-5-5" },
  claim: { provider: "anthropic", model: "claude-haiku-4-5" },
  judge: { provider: "anthropic", model: "claude-sonnet-5-5" },
};
vi.mock("../lib/docs-gen/holistic-synthesizer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/docs-gen/holistic-synthesizer.js")>()),
  resolveDocsGenCostInputs: vi.fn(() => ({
    models: MODELS,
    factsCharCap: 150_000,
    phase1FactsMaxOutputTokens: 8_192,
  })),
}));

const estimateBrdGenerationCost = vi.fn();
vi.mock("../lib/docs-gen/cost-estimate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/docs-gen/cost-estimate.js")>()),
  estimateBrdGenerationCost,
}));

const { generatedDocsRouter } = await import("./generated-docs.js");
const { errorHandler, AppError } = await import("../middleware/error-handler.js");
const { PHASE1_PROMPT_VERSION } = await import("../lib/docs-gen/holistic-synthesizer.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/docs", generatedDocsRouter());
  app.use(errorHandler);
  return app;
}

const PRICED = {
  status: "priced",
  lowUsd: 1.5,
  highUsd: 3.25,
  models: ["anthropic/claude-sonnet-5-5"],
  unpricedModels: [],
  freeModels: [],
  plan: {
    modules: 10,
    modulesToExtract: 10,
    sourceLines: 202,
    sections: 7,
    modelCalls: 42,
    estimatedDocumentChars: 131_000,
  },
};

const inWorkspace = () =>
  projectFindUnique.mockResolvedValueOnce({
    workspaceId: "ws-a",
    workspace: { deletedAt: null, members: [{ id: "member-row" }] },
  });

describe("GET /projects/:projectId/docs/cost-estimate (#2189)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    estimateBrdGenerationCost.mockResolvedValue(PRICED);
    app = createApp();
  });

  it("estimates a whole-project BRD from the configured models and the generator's sections", async () => {
    inWorkspace();
    const res = await request(app).get("/api/projects/proj-1/docs/cost-estimate");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(PRICED);
    expect(estimateBrdGenerationCost).toHaveBeenCalledWith({
      projectId: "proj-1",
      codeGraphId: undefined,
      pathPrefixes: undefined,
      sections: 7,
      models: MODELS,
      factsCharCap: 150_000,
      phase1FactsMaxOutputTokens: 8_192,
      phase1PromptVersion: PHASE1_PROMPT_VERSION,
    });
    expect(requireRepositoryGraph).not.toHaveBeenCalled();
    // Not taken as a document id by `/:docId`.
    expect(generatedDocumentFindFirst).not.toHaveBeenCalled();
  });

  it("narrows to the chosen repository's code graph", async () => {
    inWorkspace();
    requireRepositoryGraph.mockResolvedValueOnce("graph-1");
    const res = await request(app).get(
      "/api/projects/proj-1/docs/cost-estimate?repoConnectorId=repo-1",
    );
    expect(res.status).toBe(200);
    expect(requireRepositoryGraph).toHaveBeenCalledWith("proj-1", "repo-1");
    expect(estimateBrdGenerationCost).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", codeGraphId: "graph-1" }),
    );
  });

  it("answers no-code, without estimating, for a repository with no code graph", async () => {
    inWorkspace();
    requireRepositoryGraph.mockRejectedValueOnce(
      new AppError(404, "REPOSITORY_GRAPH_UNAVAILABLE", "no graph"),
    );
    const res = await request(app).get(
      "/api/projects/proj-1/docs/cost-estimate?repoConnectorId=repo-2",
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "no-code", lowUsd: null, highUsd: null });
    expect(estimateBrdGenerationCost).not.toHaveBeenCalled();
  });

  it("passes any other repository error on", async () => {
    inWorkspace();
    requireRepositoryGraph.mockRejectedValueOnce(new AppError(403, "FORBIDDEN", "no"));
    const res = await request(app).get(
      "/api/projects/proj-1/docs/cost-estimate?repoConnectorId=repo-3",
    );
    expect(res.status).toBe(403);
    expect(estimateBrdGenerationCost).not.toHaveBeenCalled();
  });

  it("validates and normalises the comma-separated path prefixes as /generate does", async () => {
    inWorkspace();
    const res = await request(app)
      .get("/api/projects/proj-1/docs/cost-estimate")
      .query({ pathPrefixes: " packages/fit/ , ./src " });
    expect(res.status).toBe(200);
    expect(estimateBrdGenerationCost).toHaveBeenCalledWith(
      expect.objectContaining({ pathPrefixes: ["packages/fit", "src"] }),
    );
  });

  it("treats an empty path field as the whole scope", async () => {
    inWorkspace();
    const res = await request(app)
      .get("/api/projects/proj-1/docs/cost-estimate")
      .query({ pathPrefixes: " , " });
    expect(res.status).toBe(200);
    expect(estimateBrdGenerationCost).toHaveBeenCalledWith(
      expect.objectContaining({ pathPrefixes: undefined }),
    );
  });

  it("rejects a path prefix that escapes the repository", async () => {
    inWorkspace();
    const res = await request(app)
      .get("/api/projects/proj-1/docs/cost-estimate")
      .query({ pathPrefixes: "../etc" });
    expect(res.status).toBe(400);
    expect(estimateBrdGenerationCost).not.toHaveBeenCalled();
  });

  it("rejects a repeated query parameter", async () => {
    inWorkspace();
    const res = await request(app).get(
      "/api/projects/proj-1/docs/cost-estimate?repoConnectorId=a&repoConnectorId=b",
    );
    expect(res.status).toBe(400);
    expect(estimateBrdGenerationCost).not.toHaveBeenCalled();
  });

  it("404s a caller outside the project's workspace before estimating", async () => {
    projectFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-b",
      workspace: { deletedAt: null, members: [{ id: "member-row" }] },
    });
    const res = await request(app).get("/api/projects/project-b01/docs/cost-estimate");
    expect(res.status).toBe(404);
    expect(estimateBrdGenerationCost).not.toHaveBeenCalled();
  });
});
