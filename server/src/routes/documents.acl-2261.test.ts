/**
 * #2261 — follow-ups from #2258 on the documents subtree:
 *   - a deprovisioned caller of `POST /api/projects/:id/retrieve` gets 401
 *     `TOKEN_INVALID` (as `refreshAuthenticatedUser` answers), not a 500;
 *   - `PATCH /documents/:id/acl` rejects a NEW `group` subject (METIS stores no
 *     group membership, so it would match no one), while a group subject the
 *     document already carries may stay, so the editor can still save the rest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = {
      userId: "user-1",
      username: "u1",
      role: "coordinator",
      workspaces: ["ws-a"],
    };
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

const search = vi.fn();
vi.mock("../lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ deleteDocument: vi.fn(), ingestDocument: vi.fn(), search }),
}));
vi.mock("../lib/rag/ingest-queue.js", () => ({ getIngestQueue: () => null }));
vi.mock("../lib/documents/storage.js", () => ({ getDocumentStorage: () => ({ write: vi.fn() }) }));
vi.mock("../lib/documents/upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/documents/upload.js")>()),
  validateUpload: vi.fn(),
}));
vi.mock("../lib/documents/url-fetcher.js", () => ({
  fetchUrlForIngest: vi.fn(),
  UrlFetchError: class extends Error {},
}));
const getProject = vi.fn();
vi.mock("../lib/projects/project-service.js", () => ({ getProject }));
vi.mock("../lib/rag/quarantine.js", () => ({ approveDocument: vi.fn(), rejectDocument: vi.fn() }));
const propagateAcl = vi.fn();
const resolveAclActor = vi.fn();
vi.mock("../lib/rag/acl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/rag/acl.js")>()),
  propagateAcl,
  resolveAclActor,
}));
const audit = vi.fn();
vi.mock("../lib/audit/audit-service.js", () => ({ audit }));

const { documentsRouter, knowledgeRouter } = await import("./documents.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { InactiveAclActorError } = await import("../lib/rag/acl.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/documents", documentsRouter({ ingestQueue: null }));
  app.use("/api/projects/:projectId", knowledgeRouter());
  app.use(errorHandler);
  return app;
}

const inWorkspace = {
  workspaceId: "ws-a",
  workspace: { deletedAt: null, members: [{ id: "member-row" }] },
};

describe("POST /retrieve — deprovisioned caller (#2261)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    projectFindUnique.mockResolvedValue(inWorkspace);
    getProject.mockResolvedValue({ id: "project-a01", name: "Scheduler" });
    search.mockResolvedValue({ hits: [], mode: "hybrid", reranked: false });
    app = createApp();
  });

  it("answers 401 TOKEN_INVALID, never a 500, and never searches", async () => {
    resolveAclActor.mockRejectedValueOnce(new InactiveAclActorError());
    const res = await request(app)
      .post("/api/projects/project-a01/retrieve")
      .send({ query: "scheduler" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_INVALID");
    expect(search).not.toHaveBeenCalled();
  });

  it("leaves any other actor failure a server error", async () => {
    resolveAclActor.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app)
      .post("/api/projects/project-a01/retrieve")
      .send({ query: "scheduler" });
    expect(res.status).toBe(500);
    expect(search).not.toHaveBeenCalled();
  });

  it("searches as the live caller", async () => {
    resolveAclActor.mockResolvedValueOnce({ userId: "user-1", role: "coordinator" });
    const res = await request(app)
      .post("/api/projects/project-a01/retrieve")
      .send({ query: "scheduler" });
    expect(res.status).toBe(200);
    expect(resolveAclActor).toHaveBeenCalledWith("user-1");
    expect(search).toHaveBeenCalledWith(
      "project-a01",
      "scheduler",
      expect.objectContaining({ actor: { userId: "user-1", role: "coordinator" } }),
    );
  });
});

describe("PATCH /documents/:id/acl — group subjects (#2261)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    projectFindUnique.mockResolvedValue(inWorkspace);
    propagateAcl.mockResolvedValue(3);
    app = createApp();
  });

  const patch = (aclSubjects: unknown) =>
    request(app).patch("/api/projects/project-a01/documents/doc-9/acl").send({ aclSubjects });

  it("rejects a new group subject with 400 and changes nothing", async () => {
    documentFindFirst.mockResolvedValueOnce({ id: "doc-9", aclSubjects: "[]" });
    const res = await patch([
      { kind: "user", value: "alice" },
      { kind: "group", value: "finance" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ACL_GROUP_UNSUPPORTED");
    expect(res.body.error.details).toEqual({ groups: ["finance"] });
    expect(propagateAcl).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects a group the document does not already carry, beside one it does", async () => {
    documentFindFirst.mockResolvedValueOnce({
      id: "doc-9",
      aclSubjects: '[{"kind":"group","value":"legacy"}]',
    });
    const res = await patch([
      { kind: "group", value: "legacy" },
      { kind: "group", value: "finance" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ groups: ["finance"] });
    expect(propagateAcl).not.toHaveBeenCalled();
  });

  it("keeps a group subject the document already carries, so the rest can be saved", async () => {
    documentFindFirst.mockResolvedValueOnce({
      id: "doc-9",
      aclSubjects: '[{"kind":"group","value":"legacy"},{"kind":"user","value":"bob"}]',
    });
    const subjects = [
      { kind: "group", value: "legacy" },
      { kind: "role", value: "coordinator" },
    ];
    const res = await patch(subjects);
    expect(res.status).toBe(200);
    expect(propagateAcl).toHaveBeenCalledWith("doc-9", subjects);
  });

  it("still saves user and role subjects", async () => {
    documentFindFirst.mockResolvedValueOnce({ id: "doc-9", aclSubjects: null });
    const subjects = [
      { kind: "user", value: "alice" },
      { kind: "role", value: "coordinator" },
    ];
    const res = await patch(subjects);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ chunkCount: 3, aclSubjects: subjects });
    expect(propagateAcl).toHaveBeenCalledWith("doc-9", subjects);
  });
});
