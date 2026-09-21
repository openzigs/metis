/**
 * BOLA / object-level authorization test for the generated-docs subtree
 * (`/api/projects/:projectId/docs/*`) — issue #674, epic #671, OWASP A01.
 *
 * `GET /:docId`, `POST /generate`, and siblings resolved a generated document
 * scoped to the path project but not to the caller's workspace. The workspace
 * scope must 404 before the document lookup / generation runs.
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
const generatedDocumentCreate = vi.fn();
const documentFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    document: { findFirst: documentFindFirst },
    generatedDocument: {
      findFirst: generatedDocumentFindFirst,
      create: generatedDocumentCreate,
    },
  },
  Prisma: { DbNull: Symbol("DbNull") },
}));
vi.mock("../lib/reviews/approval-gate.js", () => ({ assertDocumentExportable: vi.fn() }));
vi.mock("../lib/socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: vi.fn(() => "failed"),
}));

const { generatedDocsRouter } = await import("./generated-docs.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/docs", generatedDocsRouter());
  app.use(errorHandler);
  return app;
}

describe("generated-docs subtree — workspace scope (#674)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    documentFindFirst.mockResolvedValue(null);
    app = createApp();
  });

  it("404s a role-permitted caller outside the project's workspace on GET — no oracle", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).get("/api/projects/project-b01/docs/doc-9");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(generatedDocumentFindFirst).not.toHaveBeenCalled();
  });

  it("404s a cross-tenant generate before a document row is created", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app)
      .post("/api/projects/project-b01/docs/generate")
      .send({ title: "Steal", scope: "full" });
    expect(res.status).toBe(404);
    expect(generatedDocumentCreate).not.toHaveBeenCalled();
  });

  it("serves the document for an in-tenant caller", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    generatedDocumentFindFirst.mockResolvedValueOnce({ id: "doc-9", versions: [] });
    const res = await request(app).get("/api/projects/project-a01/docs/doc-9");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("doc-9");
  });

  it("lets a system admin bypass the workspace scope", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    generatedDocumentFindFirst.mockResolvedValueOnce({ id: "doc-9", versions: [] });
    const res = await request(app).get("/api/projects/project-b01/docs/doc-9");
    expect(res.status).toBe(200);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});
