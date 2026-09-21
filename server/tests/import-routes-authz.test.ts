/**
 * #1053 (finding F3, epic #1051) — object-level project scope for
 * `/api/projects/:projectId/imports`.
 *
 * The router previously gated only on `requireAuth` + a GLOBAL-role
 * `requirePermission("connector.read"|"connector.write")`, so any authenticated
 * coordinator could read another tenant's import sources (leaking vault secret
 * refs / Jira connection ids) and — worse — create sources and trigger runs that
 * write `Requirement` rows into the victim project.
 *
 * These tests exercise the REAL `requirePermission` + `requireProjectAccess`
 * middleware wired onto the router: a caller who cannot reach the path project
 * gets a 404 (no existence oracle) BEFORE any handler body runs, while a
 * same-workspace caller is still served (guard against over-blocking).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface TestUser {
  userId: string;
  role: string;
  workspaces?: string[];
}
let currentUser: TestUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: TestUser }).user = currentUser;
    next();
  },
}));

const projectFindUnique = vi.fn();
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { project: { findUnique: projectFindUnique } },
}));

const { importsRouter } = await import("../src/routes/imports.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");
type ImportService = Parameters<typeof importsRouter>[0];

function buildApp(service: Partial<ImportService>) {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/imports", importsRouter(service as ImportService));
  app.use(errorHandler);
  return app;
}

const createSourceBody = {
  source: "github",
  label: "GH",
  filter: { owner: "o", repo: "r", state: "open" },
  token: "t",
};

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
  // Default: the path project lives in a workspace the caller belongs to.
  projectFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
});

describe("imports — object-level scope (requireProjectAccess) → 404 cross-tenant", () => {
  it("404s a non-member listing another tenant's import sources (read route)", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const service = { listSources: vi.fn(async () => []) };
    const res = await request(buildApp(service)).get("/api/projects/proj-victim/imports/sources");
    expect(res.status).toBe(404);
    expect(service.listSources).not.toHaveBeenCalled();
  });

  it("404s a non-member creating an import source on another tenant's project (write route)", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const service = { createSource: vi.fn(async () => ({ source: {}, run: {} })) };
    const res = await request(buildApp(service))
      .post("/api/projects/proj-victim/imports/sources")
      .send(createSourceBody);
    expect(res.status).toBe(404);
    expect(service.createSource).not.toHaveBeenCalled();
  });

  it("404s a non-member previewing a filter against another tenant's project", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const service = { preview: vi.fn(async () => ({ source: "github", count: 0, sample: [] })) };
    const res = await request(buildApp(service))
      .post("/api/projects/proj-victim/imports/preview")
      .send({ source: "github", filter: { owner: "o", repo: "r", state: "open" }, token: "t" });
    expect(res.status).toBe(404);
    expect(service.preview).not.toHaveBeenCalled();
  });

  it("404s a non-member triggering a run in another tenant's project", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const service = {
      getSource: vi.fn(async () => ({ id: "src_1" })),
      enqueueRun: vi.fn(async () => ({ id: "run_1" })),
    };
    const res = await request(buildApp(service)).post(
      "/api/projects/proj-victim/imports/sources/src_1/run",
    );
    expect(res.status).toBe(404);
    expect(service.getSource).not.toHaveBeenCalled();
    expect(service.enqueueRun).not.toHaveBeenCalled();
  });

  it("404s a non-member deleting a source in another tenant's project", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const service = { deleteSource: vi.fn(async () => undefined) };
    const res = await request(buildApp(service)).delete(
      "/api/projects/proj-victim/imports/sources/src_1",
    );
    expect(res.status).toBe(404);
    expect(service.deleteSource).not.toHaveBeenCalled();
  });

  it("404s a non-member reading run history for another tenant's project", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const service = { listRuns: vi.fn(async () => []) };
    const res = await request(buildApp(service)).get("/api/projects/proj-victim/imports/runs");
    expect(res.status).toBe(404);
    expect(service.listRuns).not.toHaveBeenCalled();
  });

  it("404s an unknown project id (no existence oracle)", async () => {
    projectFindUnique.mockResolvedValueOnce(null);
    const service = { listSources: vi.fn(async () => []) };
    const res = await request(buildApp(service)).get("/api/projects/nope/imports/sources");
    expect(res.status).toBe(404);
    expect(service.listSources).not.toHaveBeenCalled();
  });
});

describe("imports — same-workspace caller is still served (no over-blocking)", () => {
  it("lists sources for a project in the caller's workspace", async () => {
    const service = { listSources: vi.fn(async () => []) };
    const res = await request(buildApp(service)).get("/api/projects/proj-1/imports/sources");
    expect(res.status).toBe(200);
    expect(service.listSources).toHaveBeenCalledWith("proj-1");
  });

  it("creates a source for a project in the caller's workspace", async () => {
    const service = {
      createSource: vi.fn(async () => ({ source: { id: "src_1" }, run: { id: "run_1" } })),
    };
    const res = await request(buildApp(service))
      .post("/api/projects/proj-1/imports/sources")
      .send(createSourceBody);
    expect(res.status).toBe(201);
    expect(service.createSource).toHaveBeenCalledWith("proj-1", expect.any(Object), "user-1");
  });

  it("serves a system admin regardless of workspace membership", async () => {
    currentUser = { userId: "admin-1", role: "admin", workspaces: [] };
    const service = { listSources: vi.fn(async () => []) };
    const res = await request(buildApp(service)).get("/api/projects/proj-any/imports/sources");
    expect(res.status).toBe(200);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });

  it("still applies the role layer on top — a reader cannot write", async () => {
    currentUser = { userId: "reader-1", role: "reader", workspaces: ["ws-1"] };
    const service = { createSource: vi.fn(async () => ({ source: {}, run: {} })) };
    const res = await request(buildApp(service))
      .post("/api/projects/proj-1/imports/sources")
      .send(createSourceBody);
    expect(res.status).toBe(403);
    expect(service.createSource).not.toHaveBeenCalled();
  });
});
