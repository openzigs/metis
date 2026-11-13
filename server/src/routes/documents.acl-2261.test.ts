/**
 * #2261 — follow-ups from #2258 on the documents subtree:
 *   - a deprovisioned caller of `POST /api/projects/:id/retrieve` gets 401
 *     `TOKEN_INVALID` (as `refreshAuthenticatedUser` answers), not a 500;
 *   - `PATCH /documents/:id/acl` rejects a NEW `group` subject (METIS stores no
 *     group membership, so it would match no one), while a group subject the
 *     document already carries may stay, so the editor can still save the rest.
 *   - #2356: "already carries" means the ACL the write replaces. The save is a
 *     compare-and-set on the ACL it read, so a group another editor removed in
 *     between is checked again and refused, never written back.
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
// #2356 — the real `saveDocumentAcl` runs: its compare-and-set write and the
// chunks' update, in a transaction.
const documentUpdateMany = vi.fn();
const chunkUpdateMany = vi.fn();
vi.mock("../lib/prisma.js", () => {
  const tx = {
    document: { updateMany: documentUpdateMany },
    knowledgeChunk: { updateMany: chunkUpdateMany },
  };
  return {
    prisma: {
      project: { findUnique: projectFindUnique },
      document: { findFirst: documentFindFirst },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

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
const resolveAclActor = vi.fn();
vi.mock("../lib/rag/acl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/rag/acl.js")>()),
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

describe("PATCH /documents/:id/acl — group subjects (#2261) and concurrent saves (#2356)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    projectFindUnique.mockResolvedValue(inWorkspace);
    documentUpdateMany.mockResolvedValue({ count: 1 });
    chunkUpdateMany.mockResolvedValue({ count: 3 });
    app = createApp();
  });

  const patch = (aclSubjects: unknown) =>
    request(app).patch("/api/projects/project-a01/documents/doc-9/acl").send({ aclSubjects });
  /** The compare-and-set write: on this project's live document, holding the ACL that was read. */
  const casWrite = (read: unknown, subjects: unknown) => ({
    where: {
      id: "doc-9",
      projectId: "project-a01",
      deletedAt: null,
      aclSubjects: read,
    },
    data: { aclSubjects: JSON.stringify(subjects) },
  });

  it("rejects a new group subject with 400 and changes nothing", async () => {
    documentFindFirst.mockResolvedValueOnce({ aclSubjects: "[]" });
    const res = await patch([
      { kind: "user", value: "alice" },
      { kind: "group", value: "finance" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ACL_GROUP_UNSUPPORTED");
    expect(res.body.error.details).toEqual({ groups: ["finance"] });
    expect(documentUpdateMany).not.toHaveBeenCalled();
    expect(chunkUpdateMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects a group the document does not already carry, beside one it does", async () => {
    documentFindFirst.mockResolvedValueOnce({
      aclSubjects: '[{"kind":"group","value":"legacy"}]',
    });
    const res = await patch([
      { kind: "group", value: "legacy" },
      { kind: "group", value: "finance" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ groups: ["finance"] });
    expect(documentUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps a group subject the document already carries, so the rest can be saved", async () => {
    const held = '[{"kind":"group","value":"legacy"},{"kind":"user","value":"bob"}]';
    documentFindFirst.mockResolvedValueOnce({ aclSubjects: held });
    const subjects = [
      { kind: "group", value: "legacy" },
      { kind: "role", value: "coordinator" },
    ];
    const res = await patch(subjects);
    expect(res.status).toBe(200);
    expect(documentUpdateMany).toHaveBeenCalledWith(casWrite(held, subjects));
    expect(chunkUpdateMany).toHaveBeenCalledWith({
      where: { documentId: "doc-9" },
      data: { aclSubjects: JSON.stringify(subjects) },
    });
  });

  it("still saves user and role subjects, and audits the save", async () => {
    documentFindFirst.mockResolvedValueOnce({ aclSubjects: "[]" });
    const subjects = [
      { kind: "user", value: "alice" },
      { kind: "role", value: "coordinator" },
    ];
    const res = await patch(subjects);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ chunkCount: 3, aclSubjects: subjects });
    expect(documentUpdateMany).toHaveBeenCalledWith(casWrite("[]", subjects));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.acl.update",
        metadata: expect.objectContaining({ chunkCount: 3 }),
      }),
    );
  });

  it("404s a document that is not live in the project", async () => {
    documentFindFirst.mockResolvedValueOnce(null);
    const res = await patch([{ kind: "user", value: "alice" }]);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("DOCUMENT_NOT_FOUND");
    expect(documentUpdateMany).not.toHaveBeenCalled();
  });

  // #2356 — Bob's editor still shows the legacy group Alice has just removed.
  // His read saw it; Alice's save landed before his write, so his write misses
  // the ACL it read, and the group is checked again against the ACL his write
  // would replace: it is no longer held, so it is refused, never written back.
  it("re-checks against the ACL it replaces when another save lands between its read and its write", async () => {
    documentFindFirst
      .mockResolvedValueOnce({
        aclSubjects: '[{"kind":"group","value":"legacy"}]',
      })
      .mockResolvedValueOnce({
        aclSubjects: '[{"kind":"user","value":"alice"}]',
      });
    documentUpdateMany.mockResolvedValueOnce({ count: 0 }); // Alice's save won the row
    const res = await patch([
      { kind: "group", value: "legacy" },
      { kind: "user", value: "bob" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ groups: ["legacy"] });
    expect(documentUpdateMany).toHaveBeenCalledTimes(1);
    expect(chunkUpdateMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("saves on the next attempt when the ACL it lost to still allows it", async () => {
    documentFindFirst.mockResolvedValueOnce({ aclSubjects: "[]" }).mockResolvedValueOnce({
      aclSubjects: '[{"kind":"user","value":"alice"}]',
    });
    documentUpdateMany.mockResolvedValueOnce({ count: 0 });
    const subjects = [{ kind: "user", value: "bob" }];
    const res = await patch(subjects);
    expect(res.status).toBe(200);
    expect(documentUpdateMany).toHaveBeenLastCalledWith(
      casWrite('[{"kind":"user","value":"alice"}]', subjects),
    );
    expect(chunkUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("answers 409 ACL_CONFLICT when the ACL changes under every attempt, writing nothing", async () => {
    documentFindFirst.mockResolvedValue({ aclSubjects: "[]" });
    documentUpdateMany.mockResolvedValue({ count: 0 });
    const res = await patch([{ kind: "user", value: "bob" }]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ACL_CONFLICT");
    expect(documentUpdateMany).toHaveBeenCalledTimes(3);
    expect(chunkUpdateMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
