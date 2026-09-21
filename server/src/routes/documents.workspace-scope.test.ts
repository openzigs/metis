/**
 * BOLA / object-level authorization test for the documents subtree
 * (`/api/projects/:projectId/documents/*`) — issue #674, epic #671, OWASP A01.
 *
 * `GET /:documentId` and `DELETE /:documentId` were scoped to the path project
 * but not to the caller's workspace, so a caller could read/delete another
 * tenant's documents by supplying that tenant's projectId + documentId. The
 * workspace scope must 404 before the document lookup runs.
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
vi.mock("../middleware/upload-rate-limit.js", () => ({
  retrieveRateLimiter: (_r: unknown, _s: unknown, n: () => void) => n(),
  uploadRateLimiter: (_r: unknown, _s: unknown, n: () => void) => n(),
}));

const projectFindUnique = vi.fn();
const documentFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    document: { findFirst: documentFindFirst },
  },
}));

const deleteDocument = vi.fn();
vi.mock("../lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ deleteDocument, ingestDocument: vi.fn(), search: vi.fn() }),
}));
vi.mock("../lib/rag/ingest-queue.js", () => ({ getIngestQueue: () => null }));
vi.mock("../lib/documents/storage.js", () => ({ getDocumentStorage: () => ({ write: vi.fn() }) }));
vi.mock("../lib/documents/upload.js", () => ({ validateUpload: vi.fn() }));
vi.mock("../lib/documents/url-fetcher.js", () => ({
  fetchUrlForIngest: vi.fn(),
  UrlFetchError: class extends Error {},
}));
vi.mock("../lib/projects/project-service.js", () => ({ getProject: vi.fn() }));
vi.mock("../lib/rag/quarantine.js", () => ({ approveDocument: vi.fn(), rejectDocument: vi.fn() }));
vi.mock("../lib/rag/acl.js", () => ({ propagateAcl: vi.fn() }));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { documentsRouter } = await import("./documents.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/documents", documentsRouter({ ingestQueue: null }));
  app.use(errorHandler);
  return app;
}

describe("documents subtree — workspace scope (#674)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s a role-permitted caller outside the project's workspace on GET — no oracle", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).get("/api/projects/project-b01/documents/doc-9");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // The document lookup must never run once access is denied.
    expect(documentFindFirst).not.toHaveBeenCalled();
  });

  it("404s a cross-tenant DELETE before the knowledge service runs", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).delete("/api/projects/project-b01/documents/doc-9");
    expect(res.status).toBe(404);
    expect(documentFindFirst).not.toHaveBeenCalled();
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it("serves the document for an in-tenant caller", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    documentFindFirst.mockResolvedValueOnce({ id: "doc-9", projectId: "project-a01" });
    const res = await request(app).get("/api/projects/project-a01/documents/doc-9");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("doc-9");
  });

  it("lets a system admin bypass the workspace scope", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    documentFindFirst.mockResolvedValueOnce({ id: "doc-9", projectId: "project-b01" });
    const res = await request(app).get("/api/projects/project-b01/documents/doc-9");
    expect(res.status).toBe(200);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});
