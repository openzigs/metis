/**
 * BOLA / object-level authorization test for GET + PATCH /api/projects/:id
 * (issue #673, epic #671, OWASP A01).
 *
 * The by-id read and mutate must be scoped to the caller's workspace
 * memberships. A caller who is not a member of the project's workspace gets a
 * 404 (NOT a 403 — no existence oracle, matching the canonical
 * `assertProjectAccess` seam in custom-agents/authz.ts). Admins bypass. Prisma
 * is mocked so no real DB is touched; the heavy project-router imports are
 * stubbed because these two routes never reach them.
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

// Prisma is the unit boundary — assertProjectAccess uses findUnique(workspaceId);
// getProject/updateProject use findFirst/update.
const projectFindUnique = vi.fn();
const projectFindFirst = vi.fn();
const projectUpdate = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: projectFindUnique,
      findFirst: projectFindFirst,
      update: projectUpdate,
    },
  },
}));

vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

// Heavy imports the project router pulls in at module load — stubbed because
// the by-id read + mutate handlers under test never reach them.
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

const PROJECT_WS_B = {
  id: "project-b01",
  slug: "project-b01",
  name: "Project B",
  status: "active",
  createdById: "someone-else",
  workspaceId: "ws-b",
  deletedAt: null,
};

const PROJECT_WS_A = {
  id: "project-a01",
  slug: "project-a01",
  name: "Project A",
  status: "active",
  createdById: "someone-else",
  workspaceId: "ws-a",
  deletedAt: null,
};

// ws-a project owned by the in-tenant caller (user-1) so the owner-or-admin
// archive/delete RBAC check passes for the happy-path write tests.
const PROJECT_WS_A_OWNED = { ...PROJECT_WS_A, createdById: "user-1" };

beforeEach(() => {
  // Denied requests intentionally leave one-shot Prisma results unconsumed.
  vi.resetAllMocks();
});

describe("GET /api/projects/:id — workspace scope (#673)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s for a caller whose workspaces do not include the project's workspace", async () => {
    // Caller is in ws-a; project belongs to ws-b.
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).get("/api/projects/project-b01");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // The by-id lookup must never run once access is denied.
    expect(projectFindFirst).not.toHaveBeenCalled();
  });

  it("returns the project for an in-tenant caller", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_A);
    const res = await request(app).get("/api/projects/project-a01");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("project-a01");
  });

  it("lets a system admin bypass the workspace scope", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_B);
    const res = await request(app).get("/api/projects/project-b01");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("project-b01");
    // Admin short-circuits assertProjectAccess — no workspace lookup.
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/projects/:id — workspace scope (#673)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s a role-permitted-but-wrong-workspace coordinator (cross-tenant mutate blocked)", async () => {
    // Coordinator in ws-a trying to mutate a ws-b project — the coordinator
    // short-circuit in assertCanMutate must NOT be reachable cross-tenant.
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).patch("/api/projects/project-b01").send({ name: "hijacked" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // Mutate path must never run.
    expect(projectUpdate).not.toHaveBeenCalled();
    expect(projectFindFirst).not.toHaveBeenCalled();
  });

  it("allows an in-tenant coordinator to mutate", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_A); // getProjectOrThrow
    projectUpdate.mockResolvedValueOnce({ ...PROJECT_WS_A, name: "renamed" });
    const res = await request(app).patch("/api/projects/project-a01").send({ name: "renamed" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("renamed");
    expect(projectUpdate).toHaveBeenCalled();
  });

  it("lets a system admin mutate any project (bypass)", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_B); // getProjectOrThrow
    projectUpdate.mockResolvedValueOnce({ ...PROJECT_WS_B, name: "admin-edit" });
    const res = await request(app).patch("/api/projects/project-b01").send({ name: "admin-edit" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("admin-edit");
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/:id/archive — workspace scope (#673)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s (not 403) for a caller outside the project's workspace — no existence oracle", async () => {
    // Caller is in ws-a; the project exists in ws-b. Without the scope guard the
    // by-PK write reaches assertCanArchive and leaks a 403 (owner-or-admin),
    // revealing the id exists — the exact oracle #673 eliminates for GET/PATCH.
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_B); // getProjectOrThrow (would 403)
    const res = await request(app).post("/api/projects/project-b01/archive");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // The archive service must never run once access is denied.
    expect(projectFindFirst).not.toHaveBeenCalled();
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it("archives for an in-tenant owner", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_A_OWNED); // getProjectOrThrow
    projectUpdate.mockResolvedValueOnce({ ...PROJECT_WS_A_OWNED, status: "archived" });
    const res = await request(app).post("/api/projects/project-a01/archive");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("archived");
    expect(projectUpdate).toHaveBeenCalled();
  });

  it("lets a system admin archive any project (bypass)", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_B); // getProjectOrThrow
    projectUpdate.mockResolvedValueOnce({ ...PROJECT_WS_B, status: "archived" });
    const res = await request(app).post("/api/projects/project-b01/archive");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("archived");
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/projects/:id — workspace scope (#673)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s (not 403) for a caller outside the project's workspace — no existence oracle", async () => {
    // The project exists in ws-b; the delete path would otherwise reach
    // assertCanArchive and leak a 403, revealing the id exists.
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_B); // getProjectOrThrow (would 403)
    const res = await request(app).delete("/api/projects/project-b01");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // The delete service must never run once access is denied.
    expect(projectFindFirst).not.toHaveBeenCalled();
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it("deletes for an in-tenant owner", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_A_OWNED); // getProjectOrThrow
    projectUpdate.mockResolvedValueOnce({ ...PROJECT_WS_A_OWNED, deletedAt: new Date() });
    const res = await request(app).delete("/api/projects/project-a01");
    expect(res.status).toBe(204);
    expect(projectUpdate).toHaveBeenCalled();
  });

  it("lets a system admin delete any project (bypass)", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    projectFindFirst.mockResolvedValueOnce(PROJECT_WS_B); // getProjectOrThrow
    projectUpdate.mockResolvedValueOnce({ ...PROJECT_WS_B, deletedAt: new Date() });
    const res = await request(app).delete("/api/projects/project-b01");
    expect(res.status).toBe(204);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});
