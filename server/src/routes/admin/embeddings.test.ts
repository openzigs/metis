/**
 * Embeddings admin reindex — async job tests (Epic #406 / #423).
 *
 * The reindex POST was changed from a blocking await into a fire-and-forget
 * background job that streams progress over the `embeddings-reindex` JobKind.
 * These tests cover the per-op AC:
 *   - enqueue-returns-jobid: POST returns 202 + a jobId WITHOUT waiting for the
 *     (slow) re-embed to finish.
 *   - progress-emitted: the worker streams `started` → `progress` → `completed`.
 *   - terminal-toast (success): `completed` carries the result summary.
 *   - terminal-toast (failure): any error (incl. a reindex conflict) emits a
 *     `failed` lifecycle event with the GENERIC user-safe message — never raw
 *     error detail (OWASP no-leak / #254).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: { userId: string; role: string } }).user = {
      userId: "admin-1",
      role: "admin",
    };
    next();
  },
}));

vi.mock("../../middleware/require-permission.js", () => ({
  requirePermission: () => (_req: express.Request, _res: express.Response, next: () => void) =>
    next(),
}));

// `vi.hoisted` so the mock object exists when the hoisted `vi.mock` factory runs.
const { jobEvents } = vi.hoisted(() => ({
  jobEvents: {
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    lifecycle: vi.fn(),
    docSection: vi.fn(),
  },
}));
vi.mock("../../lib/socket/job-events.js", () => ({
  jobEvents,
  genericFailureMessage: (kind: string) => `GENERIC:${kind}`,
}));

type ReindexOpts = {
  batchSize?: number;
  onProgress?: (p: { processed: number; total: number }) => void;
};
const { reindexProject, coverageReport, reindexShadowState, discardReindexShadow } = vi.hoisted(
  () => ({
    reindexProject: vi.fn(),
    coverageReport: vi.fn(),
    reindexShadowState: vi.fn(),
    discardReindexShadow: vi.fn(),
  }),
);
// #787 — the migration service is mocked wholesale: its own decision logic is
// unit-tested in embed-migration.test.ts, and wiring the real one here would drag
// in the embedder + vector-store singletons the route deliberately hides behind it.
const { migrationStatus, planMigration } = vi.hoisted(() => ({
  migrationStatus: vi.fn(),
  planMigration: vi.fn(),
}));
vi.mock("../../lib/rag/embed-migration.js", () => ({
  defaultMigrationDeps: () => ({}),
  migrationStatus,
  planMigration,
}));
// The conflict class is defined INSIDE the factory (vi.mock is hoisted, so a
// top-level class can't be referenced here) and re-imported below for the test.
vi.mock("../../lib/rag/knowledge-service.js", () => {
  class ReindexConflictError extends Error {
    code = "REINDEX_IN_PROGRESS";
    projectId = "p1";
    constructor() {
      super("a reindex is already running for project p1");
      this.name = "ReindexConflictError";
    }
  }
  return {
    getKnowledgeService: () => ({
      reindexProject,
      coverageReport,
      reindexShadowState,
      discardReindexShadow,
    }),
    ReindexConflictError,
  };
});
// #783 — the embedder mock is a `vi.hoisted` cell so individual tests can drive
// the health/capabilities pair (they move TOGETHER after a fallback: the loaded
// model is not the configured one).
const embedderMock = vi.hoisted(() => ({
  capabilities: vi.fn(() => ({}) as Record<string, unknown>),
  health: vi.fn(async () => ({ ok: true }) as Record<string, unknown>),
}));
vi.mock("../../lib/rag/embedder.js", () => ({
  getEmbedder: () => embedderMock,
  listBackendDescriptors: () => [],
}));

import { embeddingsAdminRouter, runReindexJob } from "./embeddings.js";
import { AppError } from "../../middleware/error-handler.js";
import { ReindexConflictError } from "../../lib/rag/knowledge-service.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin/embeddings", embeddingsAdminRouter());
  // Minimal error handler mirroring the global envelope.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof AppError) {
        res
          .status(err.statusCode)
          .json({ success: false, error: { code: err.code, message: err.message } });
        return;
      }
      res.status(500).json({ success: false, error: { code: "INTERNAL", message: String(err) } });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  embedderMock.capabilities.mockReturnValue({});
  embedderMock.health.mockResolvedValue({ ok: true });
});

describe("GET /admin/embeddings — active backend (#783)", () => {
  it("reports a healthy real backend with its model + dimension", async () => {
    embedderMock.capabilities.mockReturnValue({
      key: "xenova",
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      requiresEgress: true,
    });
    embedderMock.health.mockResolvedValue({
      ok: true,
      status: "ok",
      backend: "xenova",
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      fellBack: false,
      hashFallbackAllowed: false,
      loaded: true,
      error: null,
    });

    const res = await request(makeApp()).get("/admin/embeddings");
    expect(res.status).toBe(200);
    expect(res.body.data.active).toMatchObject({
      key: "xenova",
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      healthy: true,
      status: "ok",
      fellBack: false,
      error: null,
    });
  });

  it("shows an ACTIVE hash fallback as unhealthy, with the reason — not a green tick", async () => {
    // The panel's version of the silent-fallback bug: the deployment believes it
    // runs gte-modernbert; the process is actually emitting hash vectors. The
    // capabilities reflect the LOADED backend (the route reads them AFTER health()
    // warms), and `healthy` is false so the existing error banner renders.
    embedderMock.capabilities.mockReturnValue({
      key: "offline",
      model: "metis-offline-hash-v1",
      dimension: 384,
      requiresEgress: false,
    });
    embedderMock.health.mockResolvedValue({
      ok: false,
      status: "degraded",
      backend: "offline",
      model: "metis-offline-hash-v1",
      dimension: 384,
      fellBack: true,
      hashFallbackAllowed: true,
      loaded: true,
      error: "HF 401 — hash fallback active",
    });

    const res = await request(makeApp()).get("/admin/embeddings");
    expect(res.body.data.active).toMatchObject({
      key: "offline",
      model: "metis-offline-hash-v1",
      dimension: 384,
      healthy: false,
      status: "degraded",
      fellBack: true,
      hashFallbackAllowed: true,
    });
    expect(res.body.data.active.error).toMatch(/hash fallback/i);
  });

  it("surfaces a hard load failure with its error", async () => {
    embedderMock.health.mockResolvedValue({
      ok: false,
      status: "error",
      backend: "sidecar",
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      fellBack: false,
      hashFallbackAllowed: false,
      loaded: false,
      error: "connect ECONNREFUSED",
    });
    const res = await request(makeApp()).get("/admin/embeddings");
    expect(res.body.data.active.healthy).toBe(false);
    expect(res.body.data.active.status).toBe("error");
    expect(res.body.data.active.error).toContain("ECONNREFUSED");
  });

  it("reads capabilities AFTER health(), so a fallback cannot be reported as the configured model", async () => {
    const order: string[] = [];
    embedderMock.health.mockImplementation(async () => {
      order.push("health");
      return { ok: true, status: "ok", fellBack: false, error: null };
    });
    embedderMock.capabilities.mockImplementation(() => {
      order.push("capabilities");
      return {};
    });
    await request(makeApp()).get("/admin/embeddings");
    expect(order).toEqual(["health", "capabilities"]);
  });
});

describe("POST /admin/embeddings/projects/:id/reindex — enqueue", () => {
  it("returns 202 with a jobId WITHOUT awaiting the reindex (enqueue-returns-jobid)", async () => {
    // A reindex that never resolves proves the route does not block on it.
    let resolveReindex: (v: unknown) => void = () => {};
    reindexProject.mockReturnValue(new Promise((r) => (resolveReindex = r)));

    const res = await request(makeApp()).post("/admin/embeddings/projects/p1/reindex").send({});

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.jobId).toBe("string");
    expect(res.body.data.jobId.length).toBeGreaterThan(0);
    expect(res.body.data.projectId).toBe("p1");
    // started fired immediately; the reindex is still pending (not awaited).
    expect(jobEvents.started).toHaveBeenCalledWith(
      "embeddings-reindex",
      res.body.data.jobId,
      "p1",
      expect.any(String),
    );
    expect(jobEvents.completed).not.toHaveBeenCalled();
    resolveReindex({ reindexedChunks: 0, totalChunks: 0, currentModel: "m", currentDimension: 1 });
  });

  it("rejects an invalid projectId with 400 before enqueueing", async () => {
    // A space is rejected by the projectId guard (the `\s` clause) and stays a
    // single path segment, so it reaches the handler rather than 404-ing in
    // Express routing.
    const res = await request(makeApp())
      .post("/admin/embeddings/projects/bad%20id/reindex")
      .send({});
    expect(res.status).toBe(400);
    expect(jobEvents.started).not.toHaveBeenCalled();
  });
});

describe("runReindexJob — lifecycle streaming", () => {
  it("emits started → progress → completed with a result summary (progress + success toast)", async () => {
    reindexProject.mockImplementation(async (_id: string, opts: ReindexOpts) => {
      opts.onProgress?.({ processed: 5, total: 10 });
      opts.onProgress?.({ processed: 10, total: 10 });
      return {
        reindexedChunks: 10,
        totalChunks: 10,
        currentModel: "text-embed-3",
        currentDimension: 1536,
      };
    });

    await runReindexJob("job-1", "p1", {});

    expect(jobEvents.started).toHaveBeenCalledWith(
      "embeddings-reindex",
      "job-1",
      "p1",
      expect.any(String),
    );
    expect(jobEvents.progress).toHaveBeenCalledWith(
      "embeddings-reindex",
      "job-1",
      "p1",
      50,
      expect.stringContaining("5/10"),
    );
    expect(jobEvents.progress).toHaveBeenCalledWith(
      "embeddings-reindex",
      "job-1",
      "p1",
      100,
      expect.stringContaining("10/10"),
    );
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "embeddings-reindex",
      "job-1",
      "p1",
      expect.stringContaining("Reindexed 10 of 10 chunks"),
    );
    expect(jobEvents.failed).not.toHaveBeenCalled();
  });

  it("handles a zero-total corpus without a divide-by-zero (progress 0)", async () => {
    reindexProject.mockImplementation(async (_id: string, opts: ReindexOpts) => {
      opts.onProgress?.({ processed: 0, total: 0 });
      return { reindexedChunks: 0, totalChunks: 0, currentModel: "m", currentDimension: 1 };
    });
    await runReindexJob("job-z", "p1", {});
    expect(jobEvents.progress).toHaveBeenCalledWith(
      "embeddings-reindex",
      "job-z",
      "p1",
      0,
      expect.any(String),
    );
    expect(jobEvents.completed).toHaveBeenCalled();
  });

  it("emits a GENERIC failed message on error — no raw detail leaked (terminal failure toast)", async () => {
    reindexProject.mockRejectedValue(new Error("lancedb table locked at /var/secret/path"));
    await runReindexJob("job-2", "p1", {});
    expect(jobEvents.failed).toHaveBeenCalledWith(
      "embeddings-reindex",
      "job-2",
      "p1",
      "GENERIC:embeddings-reindex",
    );
    const leaked = jobEvents.failed.mock.calls[0][3] as string;
    expect(leaked).not.toContain("lancedb");
    expect(leaked).not.toContain("/var/secret/path");
    expect(jobEvents.completed).not.toHaveBeenCalled();
  });

  it("treats a ReindexConflictError as a generic failure (never throws)", async () => {
    reindexProject.mockRejectedValue(new ReindexConflictError());
    await expect(runReindexJob("job-3", "p1", {})).resolves.toBeUndefined();
    expect(jobEvents.failed).toHaveBeenCalledWith(
      "embeddings-reindex",
      "job-3",
      "p1",
      "GENERIC:embeddings-reindex",
    );
  });

  it("forwards an explicit batchSize to reindexProject", async () => {
    reindexProject.mockResolvedValue({
      reindexedChunks: 1,
      totalChunks: 1,
      currentModel: "m",
      currentDimension: 1,
    });
    await runReindexJob("job-4", "p1", { batchSize: 64 });
    expect(reindexProject).toHaveBeenCalledWith("p1", expect.objectContaining({ batchSize: 64 }));
  });
});

// ---------------------------------------------------------------------------
// Issue #787 — mixed-generation visibility + resume-checkpoint control.
// ---------------------------------------------------------------------------

describe("GET /admin/embeddings/coverage — deployment-wide coverage (#787)", () => {
  it("returns the per-model split, the store's width, and the ordered migration steps", async () => {
    migrationStatus.mockResolvedValue({
      embedder: {
        model: "Alibaba-NLP/gte-modernbert-base",
        dimension: 768,
        backend: "sidecar",
        status: "ok",
        fellBack: false,
      },
      store: { kind: "pgvector", storedDimension: 384, needsColumnMigration: true },
      coverage: {
        currentModel: "Alibaba-NLP/gte-modernbert-base",
        currentDimension: 768,
        totalChunks: 150,
        modelCounts: { "Xenova/bge-small-en-v1.5": 100, "Alibaba-NLP/gte-modernbert-base": 50 },
        projects: [
          {
            projectId: "p-old",
            totalChunks: 100,
            matchingChunks: 0,
            modelCounts: { "Xenova/bge-small-en-v1.5": 100 },
            needsReindex: true,
          },
        ],
        projectsNeedingReindex: 1,
      },
    });
    planMigration.mockReturnValue({
      upToDate: false,
      blocked: null,
      needsColumnMigration: true,
      projectsToReindex: ["p-old"],
      steps: ["Migrate the pgvector column", "Reindex p-old"],
    });

    const res = await request(makeApp()).get("/admin/embeddings/coverage");

    expect(res.status).toBe(200);
    // The mixed-generation picture the AC asks for: BOTH models, with counts.
    expect(res.body.data.modelCounts).toEqual({
      "Xenova/bge-small-en-v1.5": 100,
      "Alibaba-NLP/gte-modernbert-base": 50,
    });
    expect(res.body.data.projectsNeedingReindex).toBe(1);
    expect(res.body.data.store).toMatchObject({ storedDimension: 384, needsColumnMigration: true });
    expect(res.body.data.migration.steps).toHaveLength(2);
  });

  it("surfaces a BLOCKED migration rather than telling the operator to reindex", async () => {
    migrationStatus.mockResolvedValue({
      embedder: {
        model: "metis-offline-hash-v1",
        dimension: 384,
        backend: "offline",
        status: "degraded",
        fellBack: true,
      },
      store: { kind: "lance", storedDimension: null, needsColumnMigration: false },
      coverage: {
        currentModel: "metis-offline-hash-v1",
        currentDimension: 384,
        totalChunks: 0,
        modelCounts: {},
        projects: [],
        projectsNeedingReindex: 0,
      },
    });
    planMigration.mockReturnValue({
      upToDate: false,
      blocked: "hash stub active",
      needsColumnMigration: false,
      projectsToReindex: [],
      steps: ["BLOCKED: hash stub active"],
    });

    const res = await request(makeApp()).get("/admin/embeddings/coverage");
    expect(res.status).toBe(200);
    expect(res.body.data.migration.blocked).toBe("hash stub active");
    expect(res.body.data.embedder.fellBack).toBe(true);
  });
});

describe("GET /admin/embeddings/projects/:id/coverage — shadow state (#787)", () => {
  it("reports an interrupted reindex's resumable checkpoint alongside coverage", async () => {
    coverageReport.mockResolvedValue({
      totalChunks: 100,
      modelCounts: { "Xenova/bge-small-en-v1.5": 100 },
      currentModel: "Alibaba-NLP/gte-modernbert-base",
      currentDimension: 768,
      matchingChunks: 0,
      mismatchedModels: ["Xenova/bge-small-en-v1.5"],
      needsReindex: true,
    });
    reindexShadowState.mockResolvedValue({
      projectId: "p1",
      inProgress: false,
      shadowChunks: 64,
      shadowModels: ["Alibaba-NLP/gte-modernbert-base"],
      resumable: true,
    });

    const res = await request(makeApp()).get("/admin/embeddings/projects/p1/coverage");

    expect(res.status).toBe(200);
    expect(res.body.data.needsReindex).toBe(true);
    // Without this, a project with 64 chunks of completed work looks exactly like
    // one that was never reindexed at all.
    expect(res.body.data.shadow).toMatchObject({ shadowChunks: 64, resumable: true });
  });
});

describe("DELETE /admin/embeddings/projects/:id/reindex — discard checkpoint (#787)", () => {
  it("discards the shadow", async () => {
    discardReindexShadow.mockResolvedValue(undefined);
    const res = await request(makeApp()).delete("/admin/embeddings/projects/p1/reindex");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ projectId: "p1", discarded: true });
    expect(discardReindexShadow).toHaveBeenCalledWith("p1");
  });

  it("409s rather than yanking a checkpoint out from under a running reindex", async () => {
    discardReindexShadow.mockRejectedValue(new ReindexConflictError("p1"));
    const res = await request(makeApp()).delete("/admin/embeddings/projects/p1/reindex");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REINDEX_IN_PROGRESS");
  });

  it("rejects a path-hostile projectId", async () => {
    const res = await request(makeApp()).delete("/admin/embeddings/projects/..%2Fetc/reindex");
    expect(res.status).toBe(400);
    expect(discardReindexShadow).not.toHaveBeenCalled();
  });
});

describe("POST /admin/embeddings/projects/:id/reindex — #787 additions", () => {
  it("forwards `fresh` to the reindex so an operator can force a clean rebuild", async () => {
    reindexProject.mockResolvedValue({
      projectId: "p1",
      totalChunks: 3,
      reindexedChunks: 3,
      previousModels: [],
      currentModel: "m",
      currentDimension: 768,
      durationMs: 1,
      resumedChunks: 0,
      embeddedChunks: 3,
    });

    const res = await request(makeApp())
      .post("/admin/embeddings/projects/p1/reindex")
      .send({ fresh: true });
    expect(res.status).toBe(202);

    await runReindexJob("job-1", "p1", { fresh: true });
    expect(reindexProject).toHaveBeenLastCalledWith("p1", expect.objectContaining({ fresh: true }));
  });

  it("says so in the completion message when the run RESUMED", async () => {
    reindexProject.mockResolvedValue({
      projectId: "p1",
      totalChunks: 100,
      reindexedChunks: 100,
      previousModels: ["old"],
      currentModel: "new",
      currentDimension: 768,
      durationMs: 10,
      resumedChunks: 90,
      embeddedChunks: 10,
    });

    await runReindexJob("job-2", "p1");

    expect(jobEvents.completed).toHaveBeenCalledWith(
      "embeddings-reindex",
      "job-2",
      "p1",
      expect.stringContaining("90 resumed from an interrupted run, 10 re-embedded"),
    );
  });
});
