/**
 * BOLA / object-level authorization test for the projects.ts `/:id/*`
 * SUB-RESOURCE handlers — issue #674, epic #671, OWASP A01.
 *
 * #673 scoped the base `/:id` GET/PATCH/archive/DELETE. The sub-resource
 * handlers (review-gate, budget, publish-destination, safety, autopilot,
 * chronicle, overview, github-projects-v2, …) were still object-unscoped: a
 * caller could read/mutate another tenant's project settings by supplying that
 * tenant's project id. A two-segment `.use("/:id/:sub")` chokepoint now gates
 * every sub-resource on workspace membership (404 for non-members) WITHOUT
 * double-checking the #673-scoped base `/:id` verbs. `GET /:id/review-gate` is
 * exercised here as a representative sub-resource.
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

const projectFindUnique = vi.fn();
vi.mock("../lib/prisma.js", () => ({ prisma: { project: { findUnique: projectFindUnique } } }));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

// Heavy imports the project router pulls in at module load — stubbed because
// the sub-resource handler under test never reaches them.
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

const { projectsRouter } = await import("./projects.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects", projectsRouter());
  app.use(errorHandler);
  return app;
}

describe("projects.ts /:id/* sub-resources — workspace scope (#674)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s a role-permitted caller outside the workspace on GET /:id/review-gate — no oracle", async () => {
    // Chokepoint resolves the project's workspace (ws-b) and denies before the
    // handler's own findUnique runs.
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).get("/api/projects/project-b01/review-gate");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // Only the chokepoint lookup ran; the handler never queried the row.
    expect(projectFindUnique).toHaveBeenCalledTimes(1);
  });

  it("serves the sub-resource for an in-tenant caller", async () => {
    projectFindUnique
      .mockResolvedValueOnce({ workspaceId: "ws-a" }) // chokepoint
      .mockResolvedValueOnce({ requireApprovedReview: true }); // handler
    const res = await request(app).get("/api/projects/project-a01/review-gate");
    expect(res.status).toBe(200);
    expect(res.body.data.requireApprovedReview).toBe(true);
    expect(projectFindUnique).toHaveBeenCalledTimes(2);
  });

  it("lets a system admin bypass the workspace scope", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    projectFindUnique.mockResolvedValueOnce({ requireApprovedReview: false }); // handler only
    const res = await request(app).get("/api/projects/project-b01/review-gate");
    expect(res.status).toBe(200);
    // Admin bypasses the chokepoint lookup — only the handler's own query runs.
    expect(projectFindUnique).toHaveBeenCalledTimes(1);
  });
});
