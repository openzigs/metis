/**
 * #423 — `POST /api/projects/:id/code-search`: the standalone hybrid code-search
 * endpoint (Epic #507 / AC #509). The e2e suite asserts the real searcher end to
 * end; this suite pins the route's own contract — validation, workspace scope,
 * the soft-delete check, and that the searcher's hits reach the response.
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
// Records the permission each route asks for, and refuses the ones in
// `deniedPermissions`, so the role gate's wiring is testable (PR #454 review).
const deniedPermissions = new Set<string>();
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (permission: string) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (deniedPermissions.has(permission)) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "no" } });
        return;
      }
      next();
    },
}));

const projectFindUnique = vi.fn();
const projectFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique: projectFindUnique, findFirst: projectFindFirst } },
}));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const search = vi.fn();
vi.mock("../lib/code-graph/project-code-searcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/code-graph/project-code-searcher.js")>()),
  createDefaultCodeSearcher: () => ({ search }),
}));

// Heavy imports the project router pulls in at module load — stubbed because
// the handler under test never reaches them.
vi.mock("../lib/publishing/template-service.js", () => ({ seedDefaultTemplates: vi.fn() }));
vi.mock("../lib/finops/index.js", () => ({ summarizeUsage: vi.fn() }));
vi.mock("../lib/connectors/repo/repo-service.js", () => ({ createRepoConnector: vi.fn() }));
vi.mock("../lib/rag/quarantine.js", () => ({ listQuarantine: vi.fn() }));
vi.mock("../lib/memory/chronicle.js", () => ({
  forgetEntry: vi.fn(),
  getEntries: vi.fn(),
  recordEntry: vi.fn(),
}));
vi.mock("../lib/publishing/github-projects-v2-service.js", () => ({
  getGitHubProjectV2Settings: vi.fn(),
  listGitHubProjectsV2Boards: vi.fn(),
  updateGitHubProjectV2Settings: vi.fn(),
}));
vi.mock("../lib/publishing/types.js", () => ({ PublishError: class extends Error {} }));
vi.mock("../lib/code-graph/overview.js", () => ({
  generateOverview: vi.fn(),
  OverviewError: class extends Error {},
}));
vi.mock("../lib/socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: vi.fn(() => "failed"),
}));

const { projectsRouter, CODE_SEARCH_MAX_LIMIT } = await import("./projects.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects", projectsRouter());
  app.use(errorHandler);
  return app;
}

const HIT = {
  symbolId: "sym-add",
  filePath: "src/index.ts",
  name: "add",
  kind: "function",
  score: 0.03,
};

describe("POST /api/projects/:id/code-search (#423)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    deniedPermissions.clear();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    projectFindUnique.mockResolvedValue({ workspaceId: "ws-a" }); // chokepoint
    projectFindFirst.mockResolvedValue({ id: "project-a01" });
    search.mockResolvedValue([HIT]);
    app = createApp();
  });

  it("refuses a role without project.read before searching (PR #454 review)", async () => {
    deniedPermissions.add("project.read");
    const res = await request(app)
      .post("/api/projects/project-a01/code-search")
      .send({ query: "add" });
    expect(res.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("is rate-limited per user (PR #454 review)", async () => {
    // The limiter reads its cap per request; a user of its own keeps this test's
    // counter apart from every other test's.
    const prev = process.env.CODE_SEARCH_RATE_LIMIT_MAX;
    process.env.CODE_SEARCH_RATE_LIMIT_MAX = "1";
    currentUser = { ...currentUser, userId: "user-rate-limit" };
    try {
      const send = () =>
        request(app).post("/api/projects/project-a01/code-search").send({ query: "add" });
      expect((await send()).status).toBe(200);
      const second = await send();
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe("CODE_SEARCH_RATE_LIMITED");
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.CODE_SEARCH_RATE_LIMIT_MAX;
      else process.env.CODE_SEARCH_RATE_LIMIT_MAX = prev;
    }
  });

  it("returns the hybrid searcher's hits for the project", async () => {
    const res = await request(app)
      .post("/api/projects/project-a01/code-search")
      .send({ query: "  add  ", limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { results: [HIT] } });
    expect(search).toHaveBeenCalledWith("add", "project-a01", { limit: 5 });
    expect(projectFindFirst).toHaveBeenCalledWith({
      where: { id: "project-a01", deletedAt: null },
      select: { id: true },
    });
  });

  it("leaves the limit to the searcher's default when none is sent", async () => {
    const res = await request(app).post("/api/projects/project-a01/code-search").send({
      query: "add",
    });
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith("add", "project-a01", { limit: undefined });
  });

  it("returns an empty result set when the project has no code graph", async () => {
    search.mockResolvedValueOnce([]);
    const res = await request(app)
      .post("/api/projects/project-a01/code-search")
      .send({ query: "add" });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
  });

  it("404s a caller outside the project's workspace without searching", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app)
      .post("/api/projects/project-b01/code-search")
      .send({ query: "add" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(search).not.toHaveBeenCalled();
  });

  it("404s a deleted or unknown project without searching", async () => {
    projectFindFirst.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/projects/project-a01/code-search")
      .send({ query: "add" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["a missing query", { limit: 5 }],
    ["a blank query", { query: "   " }],
    ["a non-string query", { query: 42 }],
    ["an over-long query", { query: "x".repeat(501) }],
    ["a zero limit", { query: "add", limit: 0 }],
    ["a limit over the cap", { query: "add", limit: CODE_SEARCH_MAX_LIMIT + 1 }],
    ["a fractional limit", { query: "add", limit: 2.5 }],
  ])("400s %s without searching", async (_label, body) => {
    const req = request(app).post("/api/projects/project-a01/code-search");
    const res = body === undefined ? await req : await req.send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(search).not.toHaveBeenCalled();
  });

  it("accepts a limit at the cap", async () => {
    const res = await request(app)
      .post("/api/projects/project-a01/code-search")
      .send({ query: "add", limit: CODE_SEARCH_MAX_LIMIT });
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith("add", "project-a01", { limit: CODE_SEARCH_MAX_LIMIT });
  });
});
