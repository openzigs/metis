/**
 * #675 (epic #671) — `/api/projects/:projectId/hooks` router authz.
 *
 * Exercises the REAL `requirePermission` (mcp.read / mcp.manage) and
 * `requireProjectAccess` middleware wired onto the router, so this asserts the
 * actual authorization behaviour rather than mocked pass-throughs:
 *   - object-level scope: a caller who cannot reach the path project → 404
 *     (no existence oracle), regardless of role;
 *   - role scope: a caller who can reach the project but lacks the permission
 *     → 403;
 *   - by-id mutations scope the service query to the path project → cross-project
 *     hook id → 404.
 * Prisma + the audit sink are mocked; a public DNS resolver keeps create off the
 * network. `requireAuth` is stubbed to inject a configurable caller.
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
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: TestUser }).user = currentUser;
    next();
  },
}));

const projectFindUnique = vi.fn();
const hookFindMany = vi.fn();
const hookCreate = vi.fn();
const hookFindFirst = vi.fn();
const hookUpdate = vi.fn();
const hookDeleteMany = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    hookSubscription: {
      findMany: hookFindMany,
      create: hookCreate,
      findFirst: hookFindFirst,
      update: hookUpdate,
      deleteMany: hookDeleteMany,
    },
  },
}));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { hooksRouter } = await import("./hooks.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/hooks", hooksRouter());
  app.use(errorHandler);
  return app;
}

function hookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "hook-1",
    projectId: "proj-1",
    event: "sessionEnd",
    handlerKind: "webhook",
    config: JSON.stringify({ url: "https://example.com/hook" }),
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
  // Default: the path project lives in a workspace the caller belongs to.
  projectFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  app = createApp();
});

describe("object-level scope (requireProjectAccess) — 404 for cross-tenant", () => {
  it("404s a non-member listing another tenant's project hooks", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app).get("/api/projects/proj-victim/hooks");
    expect(res.status).toBe(404);
    expect(hookFindMany).not.toHaveBeenCalled();
  });

  it("404s a non-member PATCHing a hook by id in another tenant's project", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app)
      .patch("/api/projects/proj-victim/hooks/hook-1")
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(hookFindFirst).not.toHaveBeenCalled();
  });

  it("404s a non-member creating a hook on another tenant's project", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app)
      .post("/api/projects/proj-victim/hooks")
      .send({ event: "sessionEnd", handlerKind: "webhook", config: { url: "https://x.test/h" } });
    expect(res.status).toBe(404);
    expect(hookCreate).not.toHaveBeenCalled();
  });
});

describe("role scope (requirePermission) — reader is blocked", () => {
  it("403s a reader (lacks mcp.read) listing hooks even on an accessible project", async () => {
    currentUser = { userId: "reader-1", role: "reader", workspaces: ["ws-1"] };
    const res = await request(app).get("/api/projects/proj-1/hooks");
    expect(res.status).toBe(403);
    expect(hookFindMany).not.toHaveBeenCalled();
  });

  it("403s a developer (lacks mcp.manage) creating a hook", async () => {
    currentUser = { userId: "dev-1", role: "developer", workspaces: ["ws-1"] };
    const res = await request(app)
      .post("/api/projects/proj-1/hooks")
      .send({ event: "sessionEnd", handlerKind: "webhook", config: { url: "https://x.test/h" } });
    expect(res.status).toBe(403);
    expect(hookCreate).not.toHaveBeenCalled();
  });

  it("403s a developer deleting a hook", async () => {
    currentUser = { userId: "dev-1", role: "developer", workspaces: ["ws-1"] };
    const res = await request(app).delete("/api/projects/proj-1/hooks/hook-1");
    expect(res.status).toBe(403);
    expect(hookDeleteMany).not.toHaveBeenCalled();
  });
});

describe("by-id scoping — cross-project hook id in an accessible project → 404", () => {
  it("404s DELETE when the hook id belongs to a different project (0 rows deleted)", async () => {
    hookDeleteMany.mockResolvedValueOnce({ count: 0 });
    const res = await request(app).delete("/api/projects/proj-1/hooks/hook-elsewhere");
    expect(res.status).toBe(404);
    expect(hookDeleteMany).toHaveBeenCalledWith({
      where: { id: "hook-elsewhere", projectId: "proj-1" },
    });
  });

  it("404s PATCH when the scoped lookup finds nothing", async () => {
    hookFindFirst.mockResolvedValueOnce(null);
    const res = await request(app)
      .patch("/api/projects/proj-1/hooks/hook-elsewhere")
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(hookFindFirst).toHaveBeenCalledWith({
      where: { id: "hook-elsewhere", projectId: "proj-1" },
    });
  });
});

describe("happy path — authorized coordinator", () => {
  it("lists hooks for an accessible project", async () => {
    hookFindMany.mockResolvedValueOnce([hookRow()]);
    const res = await request(app).get("/api/projects/proj-1/hooks");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(hookFindMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("creates a hook with a public webhook target (literal public IP → no DNS)", async () => {
    hookCreate.mockResolvedValueOnce(hookRow());
    const res = await request(app)
      .post("/api/projects/proj-1/hooks")
      .send({
        event: "sessionEnd",
        handlerKind: "webhook",
        config: { url: "https://93.184.216.34/hook" },
      });
    expect(res.status).toBe(201);
    expect(hookCreate).toHaveBeenCalledOnce();
  });

  it("rejects create with a webhook pointing at cloud metadata (169.254.169.254) → 400", async () => {
    const res = await request(app)
      .post("/api/projects/proj-1/hooks")
      .send({
        event: "sessionEnd",
        handlerKind: "webhook",
        config: { url: "http://169.254.169.254/latest/meta-data/" },
      });
    expect(res.status).toBe(400);
    expect(hookCreate).not.toHaveBeenCalled();
  });

  it("deletes a hook that belongs to the project", async () => {
    hookDeleteMany.mockResolvedValueOnce({ count: 1 });
    const res = await request(app).delete("/api/projects/proj-1/hooks/hook-1");
    expect(res.status).toBe(204);
    expect(hookDeleteMany).toHaveBeenCalledWith({ where: { id: "hook-1", projectId: "proj-1" } });
  });
});
