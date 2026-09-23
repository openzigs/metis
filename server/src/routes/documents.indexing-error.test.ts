/**
 * #98 — every documents route that serves a `Document` row returned its
 * `errorMessage` verbatim: the ingest pipeline's raw exception text, with
 * provider response bodies, absolute paths and whatever the provider echoed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// An in-workspace, non-admin caller: an admin bypasses the workspace scope, so
// an admin-only fixture could not notice an authorization hole.
const caller = vi.hoisted(() => ({
  user: { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] },
}));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = caller.user;
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

const document = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const projectFindUnique = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique: projectFindUnique }, document },
}));

const ingestDocument = vi.hoisted(() => vi.fn());
vi.mock("../lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ deleteDocument: vi.fn(), ingestDocument, search: vi.fn() }),
}));
vi.mock("../lib/rag/ingest-queue.js", () => ({ getIngestQueue: () => null }));
vi.mock("../lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: vi.fn(async () => ({ storagePath: "p/a.md", checksum: "c", sizeBytes: 5 })),
  }),
}));
vi.mock("../lib/documents/upload.js", () => ({
  validateUpload: vi.fn(() => ({ ok: true, filename: "a.md", mimeType: "text/markdown" })),
}));
const fetchUrlForIngest = vi.hoisted(() => vi.fn());
vi.mock("../lib/documents/url-fetcher.js", () => ({
  fetchUrlForIngest,
  UrlFetchError: class extends Error {},
}));
vi.mock("../lib/projects/project-service.js", () => ({
  getProject: vi.fn(async () => ({ id: "p-1", status: "active" })),
}));
const quarantine = vi.hoisted(() => ({ approveDocument: vi.fn(), rejectDocument: vi.fn() }));
vi.mock("../lib/rag/quarantine.js", () => quarantine);
vi.mock("../lib/rag/acl.js", () => ({ propagateAcl: vi.fn() }));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { documentsRouter } = await import("./documents.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const {
  INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE,
  INDEXING_FAILED_MESSAGE,
  INDEXING_REJECTED_MESSAGE,
  APPROVAL_NOT_FOUND_MESSAGE,
  APPROVAL_NOT_AWAITING_MESSAGE,
} = await import("../lib/rag/indexing-failure-message.js");

const RAW =
  'embedding failed: embeddings returned 500: {"error":{"message":"upstream failure reading ' +
  '/srv/metis/server/data/uploads/acme/secret.pdf","key":"sk-live-4f9a8b7c6d5e4f3a2b1c"}}' +
  "\n    at OpenAICompatibleProvider.embed (/srv/metis/server/src/lib/ai/providers/x.ts:12:7)";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    projectId: "p-1",
    filename: "a.md",
    status: "failed",
    indexState: "pending",
    chunkCount: 0,
    errorMessage: RAW,
    ...overrides,
  };
}

function expectNoLeak(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toContain("/srv");
  expect(text).not.toContain("sk-live");
  expect(text).not.toContain("secret.pdf");
  expect(text).not.toContain("OpenAICompatibleProvider");
}

function createApp(deps: Parameters<typeof documentsRouter>[0] = { ingestQueue: null }) {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/documents", documentsRouter(deps));
  app.use(errorHandler);
  return app;
}

describe("documents routes — indexing errorMessage (#98)", () => {
  const app = createApp();
  beforeEach(() => {
    vi.clearAllMocks();
    projectFindUnique.mockResolvedValue({ workspaceId: "ws-a" });
  });

  it("still 404s a caller outside the project's workspace before any row is read", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).get("/api/projects/p-b/documents/doc-1");
    expect(res.status).toBe(404);
    expect(document.findFirst).not.toHaveBeenCalled();
  });

  it("GET / sanitises every listed row", async () => {
    document.findMany.mockResolvedValueOnce([
      row(),
      row({ id: "doc-2", errorMessage: null, status: "ready" }),
    ]);
    document.count.mockResolvedValueOnce(2);
    const res = await request(app).get("/api/projects/p-1/documents");
    expect(res.status).toBe(200);
    expectNoLeak(res.body);
    expect(res.body.data.items[0].errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
    expect(res.body.data.items[1].errorMessage).toBeNull();
    expect(res.body.data.items[0].filename).toBe("a.md");
  });

  it("GET /:documentId sanitises the row", async () => {
    document.findFirst.mockResolvedValueOnce(row());
    const res = await request(app).get("/api/projects/p-1/documents/doc-1");
    expect(res.status).toBe(200);
    expectNoLeak(res.body);
    expect(res.body.data.errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
  });

  it("POST / sanitises both the refreshed row and the synchronous ingest result", async () => {
    document.create.mockResolvedValueOnce(row({ status: "pending", errorMessage: null }));
    ingestDocument.mockResolvedValueOnce({
      documentId: "doc-1",
      status: "failed",
      chunkCount: 0,
      errorMessage: RAW,
    });
    document.findUnique.mockResolvedValueOnce(row());
    const res = await request(app)
      .post("/api/projects/p-1/documents")
      .attach("file", Buffer.from("# hi\n"), { filename: "a.md", contentType: "text/markdown" });
    expect(res.status).toBe(201);
    expectNoLeak(res.body);
    expect(res.body.data.document.errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
    expect(res.body.data.ingest.errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
  });

  it("POST / sanitises an ingest that threw", async () => {
    document.create.mockResolvedValueOnce(row({ status: "pending", errorMessage: null }));
    ingestDocument.mockRejectedValueOnce(new Error(RAW));
    document.findUnique.mockResolvedValueOnce(row({ status: "pending", errorMessage: null }));
    const res = await request(app)
      .post("/api/projects/p-1/documents")
      .attach("file", Buffer.from("# hi\n"), { filename: "a.md", contentType: "text/markdown" });
    expect(res.status).toBe(201);
    expectNoLeak(res.body);
    expect(res.body.data.ingest.errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
  });

  it("POST /:documentId/reject returns the fixed rejection message", async () => {
    document.findFirst.mockResolvedValueOnce(row({ status: "ready", errorMessage: null }));
    document.findUnique.mockResolvedValueOnce(
      row({ indexState: "rejected", errorMessage: "rejected" }),
    );
    const res = await request(app).post("/api/projects/p-1/documents/doc-1/reject").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.document.errorMessage).toBe(INDEXING_REJECTED_MESSAGE);
  });

  it("POST /:documentId/approve sanitises the refreshed row", async () => {
    document.findFirst.mockResolvedValueOnce(row());
    document.findUnique.mockResolvedValueOnce(row({ indexState: "reconciling" }));
    const res = await request(app).post("/api/projects/p-1/documents/doc-1/approve").send({});
    expect(res.status).toBe(200);
    expectNoLeak(res.body);
  });

  it("PATCH /:documentId/auto-approve and /spec sanitise the updated row", async () => {
    document.findFirst.mockResolvedValue(row());
    document.update.mockResolvedValue(row());
    const auto = await request(app)
      .patch("/api/projects/p-1/documents/doc-1/auto-approve")
      .send({ autoApproveTrusted: true });
    expect(auto.status).toBe(200);
    expectNoLeak(auto.body);
    const spec = await request(app)
      .patch("/api/projects/p-1/documents/doc-1/spec")
      .send({ isSpec: true });
    expect(spec.status).toBe(200);
    expectNoLeak(spec.body);
    document.findFirst.mockReset();
    document.update.mockReset();
  });

  // #114 — three sanitising wrappers could be deleted with every test green.
  it("POST /url sanitises the refreshed row", async () => {
    fetchUrlForIngest.mockResolvedValueOnce({
      buffer: Buffer.from("# hi\n"),
      contentType: "text/markdown",
      finalUrl: "https://docs.example/a.md",
      filename: "a.md",
    });
    document.create.mockResolvedValueOnce(row({ status: "pending", errorMessage: null }));
    ingestDocument.mockResolvedValueOnce({ documentId: "doc-1", status: "ready", chunkCount: 1 });
    document.findUnique.mockResolvedValueOnce(row());
    const res = await request(app)
      .post("/api/projects/p-1/documents/url")
      .send({ url: "https://docs.example/a.md" });
    expect(res.status).toBe(201);
    expectNoLeak(res.body);
    expect(res.body.data.document.errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
  });

  it("POST /text sanitises the refreshed row", async () => {
    document.create.mockResolvedValueOnce(row({ status: "pending", errorMessage: null }));
    ingestDocument.mockResolvedValueOnce({ documentId: "doc-1", status: "ready", chunkCount: 1 });
    document.findUnique.mockResolvedValueOnce(row());
    const res = await request(app)
      .post("/api/projects/p-1/documents/text")
      .send({ filename: "a.md", content: "# hi" });
    expect(res.status).toBe(201);
    expectNoLeak(res.body);
    expect(res.body.data.document.errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
  });

  it("an enqueue that throws answers with the fixed vocabulary, not the exception", async () => {
    const queued = createApp({
      ingestQueue: {
        enqueue: vi.fn(async () => {
          throw new Error(RAW);
        }),
      } as never,
    });
    document.create.mockResolvedValueOnce(row({ status: "pending", errorMessage: null }));
    document.findUnique.mockResolvedValueOnce(row({ status: "pending", errorMessage: null }));
    const res = await request(queued)
      .post("/api/projects/p-1/documents/text")
      .send({ filename: "a.md", content: "# hi" });
    expect(res.status).toBe(201);
    expectNoLeak(res.body);
    expect(res.body.data.ingest).toMatchObject({ status: "failed", queued: false });
    expect(res.body.data.ingest.errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
  });
});

// #108 — the approve/reject 409 body carried the cleanup exception verbatim:
// LanceDB / BM25 / Prisma text, with paths.
describe("documents routes — approve/reject 409 bodies (#108)", () => {
  const app = createApp();
  const CLEANUP =
    "LanceError(IO): Generic LocalFileSystem error: Unable to open file " +
    "/srv/metis/server/data/lancedb/knowledge.lance/_versions/12.manifest: sk-live-4f9a8b7c6d5e4f3a2b1c";
  beforeEach(() => {
    vi.clearAllMocks();
    projectFindUnique.mockResolvedValue({ workspaceId: "ws-a" });
    document.findFirst.mockResolvedValue(row({ status: "ready", errorMessage: null }));
  });

  it("approve: a cleanup failure answers with the fixed vocabulary", async () => {
    quarantine.approveDocument.mockRejectedValueOnce(new Error(CLEANUP));
    const res = await request(app).post("/api/projects/p-1/documents/doc-1/approve").send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DOCUMENT_APPROVE_FAILED");
    expectNoLeak(res.body);
    expect(res.body.error.message).toBe(INDEXING_FAILED_MESSAGE);
  });

  it("reject: a cleanup failure answers with the fixed vocabulary", async () => {
    quarantine.rejectDocument.mockRejectedValueOnce(new Error(CLEANUP));
    const res = await request(app).post("/api/projects/p-1/documents/doc-1/reject").send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DOCUMENT_REJECT_FAILED");
    expectNoLeak(res.body);
    expect(res.body.error.message).toBe(INDEXING_FAILED_MESSAGE);
  });

  it("keeps METIS's own state refusals informative, without the document id", async () => {
    quarantine.approveDocument.mockRejectedValueOnce(
      new Error("Document doc-1 not in approvable state: indexed"),
    );
    const res = await request(app).post("/api/projects/p-1/documents/doc-1/approve").send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(APPROVAL_NOT_AWAITING_MESSAGE);
    quarantine.rejectDocument.mockRejectedValueOnce(new Error("Document doc-1 not found"));
    const rej = await request(app).post("/api/projects/p-1/documents/doc-1/reject").send({});
    expect(rej.body.error.message).toBe(APPROVAL_NOT_FOUND_MESSAGE);
  });
});
