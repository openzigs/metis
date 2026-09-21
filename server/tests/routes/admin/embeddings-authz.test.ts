/**
 * Epic #930 / issue #937 — negative RBAC tests for `/api/admin/embeddings`.
 *
 * Unlike `embeddings.test.ts` (which stubs the auth/permission middleware to
 * assert the HTTP contract), this suite exercises the REAL `requireAuth` +
 * `requirePermission` chain so the authorization boundary itself is proven:
 *
 *   - unauthenticated            → 401
 *   - authenticated non-admin    → 403
 *   - admin                      → success
 *
 * Only the data layer (embedder + knowledge service) is mocked; the security
 * middleware is intentionally NOT stubbed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const {
  getEmbedder,
  listBackendDescriptors,
  coverageReport,
  reindexProject,
  reindexShadowState,
  discardReindexShadow,
  migrationStatus,
  planMigration,
  defaultMigrationDeps,
} = vi.hoisted(() => ({
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
  // #787 — the DESTRUCTIVE route: throw away a project's resume checkpoint.
  discardReindexShadow: vi.fn().mockResolvedValue(undefined),
  // #787 — the deployment-wide coverage GET is served out of embed-migration.
  migrationStatus: vi.fn().mockResolvedValue({
    embedder: {
      model: "metis-offline-hash-v1",
      dimension: 384,
      backend: "offline",
      status: "ok",
      fellBack: false,
    },
    store: { kind: "local", storedDimension: null, needsColumnMigration: false },
    coverage: {
      currentModel: "metis-offline-hash-v1",
      currentDimension: 384,
      totalChunks: 0,
      modelCounts: {},
      projects: [],
      projectsNeedingReindex: 0,
    },
  }),
  planMigration: vi.fn().mockReturnValue({
    upToDate: true,
    blocked: null,
    needsColumnMigration: false,
    projectsToReindex: [],
    steps: [],
  }),
  defaultMigrationDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../src/lib/rag/embedder.js", () => ({
  getEmbedder,
  listBackendDescriptors,
}));
vi.mock("../../../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({
    coverageReport,
    reindexProject,
    reindexShadowState,
    discardReindexShadow,
  }),
  ReindexConflictError: class ReindexConflictError extends Error {},
}));
vi.mock("../../../src/lib/rag/embed-migration.js", () => ({
  migrationStatus,
  planMigration,
  defaultMigrationDeps,
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { embeddingsAdminRouter } from "../../../src/routes/admin/embeddings.js";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { issueTokens } from "../../../src/lib/auth/jwt.js";

let adminToken: string;
let readerToken: string;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/embeddings", embeddingsAdminRouter());
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  adminToken = issueTokens({
    userId: "u-admin",
    username: "admin",
    role: "admin",
    permissions: getPermissionsForRole("admin"),
  }).accessToken;
  // `reader` carries neither admin.read nor admin.write.
  readerToken = issueTokens({
    userId: "u-reader",
    username: "reader",
    role: "reader",
    permissions: getPermissionsForRole("reader"),
  }).accessToken;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("RBAC — GET /api/admin/embeddings (requires admin.read)", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const res = await request(makeApp()).get("/api/admin/embeddings");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
    expect(getEmbedder).not.toHaveBeenCalled();
  });

  it("rejects a malformed bearer token with 401", async () => {
    const res = await request(makeApp())
      .get("/api/admin/embeddings")
      .set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
    expect(getEmbedder).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-admin (reader) with 403", async () => {
    const res = await request(makeApp())
      .get("/api/admin/embeddings")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(getEmbedder).not.toHaveBeenCalled();
  });

  it("allows an admin (200)", async () => {
    getEmbedder.mockReturnValue({
      capabilities: () => ({
        key: "offline",
        model: "metis-offline-hash-v1",
        dimension: 384,
        requiresEgress: false,
      }),
      health: async () => ({ ok: true }),
    });
    listBackendDescriptors.mockReturnValue([]);
    const res = await request(makeApp())
      .get("/api/admin/embeddings")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(getEmbedder).toHaveBeenCalledTimes(1);
  });
});

describe("RBAC — GET /api/admin/embeddings/projects/:id/coverage (requires admin.read)", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const res = await request(makeApp()).get("/api/admin/embeddings/projects/p1/coverage");
    expect(res.status).toBe(401);
    expect(coverageReport).not.toHaveBeenCalled();
  });

  it("rejects a non-admin (reader) with 403", async () => {
    const res = await request(makeApp())
      .get("/api/admin/embeddings/projects/p1/coverage")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(403);
    expect(coverageReport).not.toHaveBeenCalled();
  });

  it("allows an admin (200)", async () => {
    coverageReport.mockResolvedValue({
      totalChunks: 0,
      modelCounts: {},
      currentModel: "metis-offline-hash-v1",
      currentDimension: 384,
      matchingChunks: 0,
      mismatchedModels: [],
      needsReindex: false,
    });
    const res = await request(makeApp())
      .get("/api/admin/embeddings/projects/p1/coverage")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(coverageReport).toHaveBeenCalledWith("p1");
  });
});

describe("RBAC — POST /api/admin/embeddings/projects/:id/reindex (requires admin.write)", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const res = await request(makeApp()).post("/api/admin/embeddings/projects/p1/reindex").send({});
    expect(res.status).toBe(401);
    expect(reindexProject).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-admin (reader) with 403 — admin.write withheld", async () => {
    const res = await request(makeApp())
      .post("/api/admin/embeddings/projects/p1/reindex")
      .set("Authorization", `Bearer ${readerToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(reindexProject).not.toHaveBeenCalled();
  });

  it("allows an admin to enqueue a reindex (202 + jobId)", async () => {
    // Epic #406 (#423) — the reindex is now an async background job: an admin
    // gets 202 + a jobId promptly instead of a blocking 200. A never-resolving
    // mock keeps the worker pending so we assert the enqueue, not completion.
    reindexProject.mockReturnValue(new Promise(() => {}));
    const res = await request(makeApp())
      .post("/api/admin/embeddings/projects/p1/reindex")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ batchSize: 32 });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.jobId).toBe("string");
  });
});

/**
 * PR #796 review (S3) — the two routes #787 ADDED had no RBAC test at all, and one of
 * them is the destructive one. This file is the regression net that catches a future
 * refactor moving `requirePermission` off a handler; a `DELETE` that throws away a
 * reindex checkpoint is the last endpoint that should be missing from it.
 */
describe("RBAC — GET /api/admin/embeddings/coverage (requires admin.read)", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const res = await request(makeApp()).get("/api/admin/embeddings/coverage");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
    expect(migrationStatus).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-admin (reader) with 403", async () => {
    const res = await request(makeApp())
      .get("/api/admin/embeddings/coverage")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    // The deployment-wide model split is not something a reader gets to enumerate.
    expect(migrationStatus).not.toHaveBeenCalled();
  });

  it("allows an admin (200)", async () => {
    const res = await request(makeApp())
      .get("/api/admin/embeddings/coverage")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(migrationStatus).toHaveBeenCalledTimes(1);
  });
});

describe("RBAC — DELETE /api/admin/embeddings/projects/:id/reindex (requires admin.write)", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const res = await request(makeApp()).delete("/api/admin/embeddings/projects/p1/reindex");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
    expect(discardReindexShadow).not.toHaveBeenCalled();
  });

  it("rejects a malformed bearer token with 401", async () => {
    const res = await request(makeApp())
      .delete("/api/admin/embeddings/projects/p1/reindex")
      .set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
    expect(discardReindexShadow).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-admin (reader) with 403 — admin.write withheld", async () => {
    const res = await request(makeApp())
      .delete("/api/admin/embeddings/projects/p1/reindex")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    // The negative path that actually matters: nothing was discarded.
    expect(discardReindexShadow).not.toHaveBeenCalled();
  });

  it("allows an admin (200)", async () => {
    const res = await request(makeApp())
      .delete("/api/admin/embeddings/projects/p1/reindex")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ projectId: "p1", discarded: true });
    expect(discardReindexShadow).toHaveBeenCalledWith("p1");
  });
});
