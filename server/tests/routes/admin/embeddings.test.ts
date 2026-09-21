/**
 * Epic #930 / issue #931 + #937 — `/api/admin/embeddings` route tests.
 *
 * Mounts the router in isolation with stubbed auth/permission middleware and
 * mocked embedder + knowledge service so we assert the HTTP contract
 * (envelopes, validation, status codes) without standing up the full app.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { getEmbedder, listBackendDescriptors, coverageReport, reindexProject, reindexShadowState } =
  vi.hoisted(() => ({
    getEmbedder: vi.fn(),
    listBackendDescriptors: vi.fn(),
    coverageReport: vi.fn(),
    reindexProject: vi.fn(),
    // #787 — the coverage GET now also reports the reindex resume checkpoint.
    reindexShadowState: vi.fn().mockResolvedValue({
      projectId: "p1",
      inProgress: false,
      shadowChunks: 0,
      shadowModels: [],
      resumable: false,
    }),
  }));

vi.mock("../../../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../src/lib/rag/embedder.js", () => ({
  getEmbedder,
  listBackendDescriptors,
}));
vi.mock("../../../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ coverageReport, reindexProject, reindexShadowState }),
  ReindexConflictError: class ReindexConflictError extends Error {
    readonly code = "REINDEX_IN_PROGRESS";
    readonly projectId: string;
    constructor(projectId: string) {
      super(`A reindex is already in progress for project ${projectId}`);
      this.name = "ReindexConflictError";
      this.projectId = projectId;
    }
  },
}));

import express from "express";
import request from "supertest";
import { embeddingsAdminRouter } from "../../../src/routes/admin/embeddings.js";
import { ReindexConflictError } from "../../../src/lib/rag/knowledge-service.js";
import { errorHandler } from "../../../src/middleware/error-handler.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/embeddings", embeddingsAdminRouter());
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/embeddings", () => {
  it("returns the active backend capabilities + health + registry", async () => {
    getEmbedder.mockReturnValue({
      capabilities: () => ({
        key: "xenova",
        model: "Xenova/bge-small-en-v1.5",
        dimension: 384,
        requiresEgress: false,
      }),
      health: async () => ({ ok: true }),
    });
    listBackendDescriptors.mockReturnValue([
      { key: "offline", label: "Offline hash", requiresEgress: false, offlineCapable: true },
      { key: "bedrock", label: "Bedrock gateway", requiresEgress: true, offlineCapable: false },
    ]);

    const res = await request(makeApp()).get("/api/admin/embeddings");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.active).toMatchObject({
      key: "xenova",
      dimension: 384,
      healthy: true,
      error: null,
    });
    expect(res.body.data.backends).toHaveLength(2);
  });

  it("surfaces an unhealthy backend without throwing", async () => {
    getEmbedder.mockReturnValue({
      capabilities: () => ({
        key: "bedrock",
        model: "titan",
        dimension: 1024,
        requiresEgress: true,
      }),
      health: async () => ({ ok: false, error: "gateway unreachable" }),
    });
    listBackendDescriptors.mockReturnValue([]);

    const res = await request(makeApp()).get("/api/admin/embeddings");
    expect(res.status).toBe(200);
    expect(res.body.data.active.healthy).toBe(false);
    expect(res.body.data.active.error).toBe("gateway unreachable");
  });
});

describe("GET /api/admin/embeddings/projects/:projectId/coverage", () => {
  it("returns the coverage report", async () => {
    coverageReport.mockResolvedValue({
      totalChunks: 3,
      modelCounts: { "model-a": 3 },
      currentModel: "model-a",
      currentDimension: 384,
      matchingChunks: 3,
      mismatchedModels: [],
      needsReindex: false,
    });
    const res = await request(makeApp()).get("/api/admin/embeddings/projects/p1/coverage");
    expect(res.status).toBe(200);
    expect(res.body.data.totalChunks).toBe(3);
    expect(coverageReport).toHaveBeenCalledWith("p1");
  });

  it("rejects a path-traversal projectId", async () => {
    const res = await request(makeApp()).get("/api/admin/embeddings/projects/..%2Fevil/coverage");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PROJECT_ID");
    expect(coverageReport).not.toHaveBeenCalled();
  });
});

// Epic #406 (#423) — the reindex POST now enqueues a fire-and-forget background
// job and returns 202 + a jobId promptly (instead of awaiting the full re-embed
// and returning 200 with the result). The streaming/lifecycle + conflict→generic
// behavior is covered in the co-located `src/routes/admin/embeddings.test.ts`;
// here we only assert the route's enqueue contract + pre-enqueue validation.
describe("POST /api/admin/embeddings/projects/:projectId/reindex", () => {
  it("enqueues a reindex and returns 202 with a jobId (does not block on the re-embed)", async () => {
    // A reindex that never resolves proves the route returns before it finishes.
    reindexProject.mockReturnValue(new Promise(() => {}));
    const res = await request(makeApp())
      .post("/api/admin/embeddings/projects/p1/reindex")
      .send({ batchSize: 64 });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.jobId).toBe("string");
    expect(res.body.data.projectId).toBe("p1");
    // The exact reindexProject arguments (incl. the onProgress callback the
    // worker threads in) are asserted in the co-located worker test; here the
    // worker is fire-and-forget, so we only assert the enqueue HTTP contract.
  });

  it("rejects an out-of-range batchSize before enqueueing", async () => {
    const res = await request(makeApp())
      .post("/api/admin/embeddings/projects/p1/reindex")
      .send({ batchSize: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
    expect(reindexProject).not.toHaveBeenCalled();
  });

  it("accepts a request that omits batchSize (enqueues with 202)", async () => {
    reindexProject.mockReturnValue(new Promise(() => {}));
    const res = await request(makeApp()).post("/api/admin/embeddings/projects/p1/reindex").send({});
    expect(res.status).toBe(202);
    expect(typeof res.body.data.jobId).toBe("string");
  });

  it("still returns 202 for a concurrent reindex — the conflict surfaces as a failed job event, not an HTTP error", async () => {
    // The background worker catches ReindexConflictError and broadcasts a generic
    // `failed` lifecycle event; the enqueue response itself is always 202.
    reindexProject.mockRejectedValue(new ReindexConflictError("p1"));
    const res = await request(makeApp()).post("/api/admin/embeddings/projects/p1/reindex").send({});
    expect(res.status).toBe(202);
    expect(typeof res.body.data.jobId).toBe("string");
  });
});
