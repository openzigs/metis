/**
 * BOLA / object-level authorization test for the templates subtree
 * (`/api/projects/:projectId/templates/*`) — issue #674, epic #671, OWASP A01.
 *
 * The by-id `GET/PUT/DELETE /:id` handlers addressed templates by primary key
 * with no project binding. A caller outside the project's workspace must get a
 * 404 before the template service runs.
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

const getTemplate = vi.fn();
const updateTemplate = vi.fn();
const deleteTemplate = vi.fn();
vi.mock("../lib/publishing/template-service.js", () => ({
  listTemplates: vi.fn(),
  getTemplate,
  createTemplate: vi.fn(),
  updateTemplate,
  deleteTemplate,
  seedDefaultTemplates: vi.fn(),
  TemplateServiceError: class extends Error {},
}));

const { templatesRouter } = await import("./templates.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/templates", templatesRouter());
  app.use(errorHandler);
  return app;
}

describe("templates subtree — workspace scope (#674)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s a role-permitted caller outside the project's workspace on DELETE — no oracle", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).delete("/api/projects/project-b01/templates/tmpl-9");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(deleteTemplate).not.toHaveBeenCalled();
  });

  it("serves the template for an in-tenant caller", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    getTemplate.mockResolvedValueOnce({ id: "tmpl-9", name: "Bug" });
    const res = await request(app).get("/api/projects/project-a01/templates/tmpl-9");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("tmpl-9");
    expect(getTemplate).toHaveBeenCalledWith("project-a01", "tmpl-9");
  });

  it("lets a system admin bypass the workspace scope", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    getTemplate.mockResolvedValueOnce({ id: "tmpl-9", name: "Bug" });
    const res = await request(app).get("/api/projects/project-b01/templates/tmpl-9");
    expect(res.status).toBe(200);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});
