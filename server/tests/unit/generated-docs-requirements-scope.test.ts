/**
 * #991 — docs generation scoped to requirements: POST /generate accepts a
 * `requirements` scope naming an analysis run, a selection or a review, refuses
 * one that selects nothing in the project, and the run publishes a document
 * built from those requirements and their code links.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const { updateSpy, versionCreateSpy, docCreateSpy, claimState, reqState } = vi.hoisted(() => ({
  claimState: { codeGraphHash: null as string | null },
  updateSpy: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})),
  versionCreateSpy: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})),
  docCreateSpy: vi.fn(async (_args: { data: Record<string, unknown> }) => ({
    id: "doc-req",
    projectId: "proj-1",
    status: "pending",
  })),
  reqState: {
    count: vi.fn(async (_args: unknown) => 1),
    findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
  },
}));

vi.mock("../../src/lib/prisma.js", () => ({
  Prisma: { DbNull: "__DbNull__" },
  prisma: {
    user: {
      findFirst: vi.fn(async () => ({
        id: "user_admin",
        username: "admin",
        roles: [{ role: { key: "admin" } }],
        workspaceMemberships: [],
      })),
    },
    project: {
      findFirst: vi.fn(async () => ({ id: "proj-1" })),
      findUnique: vi.fn(async () => ({ workspaceId: "ws-a", requireApprovedReview: false })),
    },
    requirement: reqState,
    generatedDocument: {
      create: docCreateSpy,
      findFirst: vi.fn(async () => ({
        id: "doc-req",
        projectId: "proj-1",
        codeGraphHash: claimState.codeGraphHash,
        evidencePolicy: JSON.stringify({
          version: 1,
          principal: { kind: "initiating-user", userId: "user_admin" },
          sharedDocumentIds: [],
          allowWebResearch: false,
        }),
        scope: "requirements",
        title: "Approved Requirements",
        status: "pending",
        scopeFilter: JSON.stringify({
          analysisId: "run-1",
          approvedOnly: true,
          docType: "business-requirements",
          actorId: "user_admin",
        }),
      })),
      update: updateSpy,
      updateMany: vi.fn(async (args) => {
        if (args.data.codeGraphHash) claimState.codeGraphHash = args.data.codeGraphHash;
        await updateSpy(args);
        return { count: 1 };
      }),
    },
    generatedDocumentVersion: { findFirst: vi.fn(async () => null), create: versionCreateSpy },
    codeSymbol: { findMany: vi.fn(async () => []) },
    task: { upsert: vi.fn(async ({ create }) => create), findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn) => fn((await import("../../src/lib/prisma.js")).prisma)),
  },
}));

vi.mock("../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const adminUser = { userId: "user_admin", username: "admin", role: "admin", permissions: [] };
// Mutable so a non-admin caller from another workspace is exercised too: an
// admin bypasses `assertProjectAccess`, so an admin-only suite could not
// notice the object-level guard disappearing (#1058).
const authState = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = authState.user;
    next();
  },
  refreshAuthenticatedUser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../src/lib/socket/job-events.js", () => ({
  jobEvents: {
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    docSection: vi.fn(),
  },
  genericFailureMessage: () => "failed",
}));

vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

vi.mock("../../src/lib/docs-gen/rag-ingest.js", () => ({
  ingestDocumentToRag: vi.fn(async () => undefined),
}));

import { generatedDocsRouter } from "../../src/routes/generated-docs.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/docs", generatedDocsRouter());
  app.use(
    (
      err: { statusCode?: number; code?: string; message?: string },
      _req: unknown,
      res: express.Response,
      _next: unknown,
    ) => {
      res.status(err.statusCode ?? 500).json({ error: { code: err.code, message: err.message } });
    },
  );
  return app;
}

function postGenerate(body: Record<string, unknown>) {
  return request(buildApp()).post("/projects/proj-1/docs/generate").send(body);
}

const approved = {
  id: "req-1",
  title: "Export invoices",
  body: "Users can export invoices as CSV.",
  type: "feature",
  priority: "high",
  reviewStatus: "approved",
  verdict: "implemented",
  acceptanceCriteria: JSON.stringify(["One row per invoice."]),
  version: 3,
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  codeMappings: [
    { filePath: "src/export.ts", startLine: 10, endLine: 40, confidence: 0.9, source: "semantic" },
  ],
  implementations: [],
};

beforeEach(() => {
  updateSpy.mockClear();
  versionCreateSpy.mockClear();
  docCreateSpy.mockClear();
  reqState.count.mockReset().mockResolvedValue(1);
  reqState.findMany.mockReset().mockResolvedValue([approved]);
  claimState.codeGraphHash = null;
  authState.user = adminUser;
});

describe("#991 — POST /generate with a requirements scope", () => {
  it("404s a non-admin caller from another workspace before reading any requirement", async () => {
    authState.user = {
      userId: "u_reader",
      username: "reader",
      role: "reader",
      permissions: [],
      workspaces: ["ws-other"],
    };
    const res = await postGenerate({
      title: "BRD",
      scope: "requirements",
      scopeFilter: { analysisId: "run-1" },
    });
    expect(res.status).toBe(404);
    expect(reqState.count).not.toHaveBeenCalled();
    expect(docCreateSpy).not.toHaveBeenCalled();
  });

  it("400s a requirements scope that names no run, selection or review", async () => {
    const res = await postGenerate({ title: "BRD", scope: "requirements", scopeFilter: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(docCreateSpy).not.toHaveBeenCalled();
  });

  it("400s a selection that matches no requirement in this project", async () => {
    reqState.count.mockResolvedValue(0);
    const res = await postGenerate({
      title: "BRD",
      scope: "requirements",
      scopeFilter: { analysisId: "foreign-run" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REQUIREMENTS_SCOPE_EMPTY");
    expect(reqState.count).toHaveBeenCalledWith({
      where: { projectId: "proj-1", deletedAt: null, analysisId: "foreign-run" },
    });
    expect(docCreateSpy).not.toHaveBeenCalled();
  });

  it("publishes a document built from the selected requirements and their code links", async () => {
    const res = await postGenerate({
      title: "Approved Requirements",
      scope: "requirements",
      scopeFilter: { analysisId: "run-1", approvedOnly: true },
    });
    expect(res.status).toBe(202);
    const created = docCreateSpy.mock.calls[0]![0].data;
    expect(created.scope).toBe("requirements");
    expect(JSON.parse(created.scopeFilter as string)).toMatchObject({
      analysisId: "run-1",
      approvedOnly: true,
    });

    await vi.waitFor(() => expect(versionCreateSpy).toHaveBeenCalled(), {
      timeout: 10_000,
      interval: 20,
    });
    // The run reads the requirements through the project-scoped filter.
    expect((reqState.findMany.mock.calls[0]![0] as { where: unknown }).where).toEqual({
      projectId: "proj-1",
      deletedAt: null,
      analysisId: "run-1",
      reviewStatus: "approved",
    });
    const version = versionCreateSpy.mock.calls[0]![0].data;
    expect(version.content).toContain("### R1. Export invoices");
    expect(version.content).toContain("`src/export.ts:10-40`");
    const manifest = JSON.parse(version.provenanceManifest as string);
    expect(manifest.generation.pipeline).toBe("requirements");
    expect(manifest.document.docType).toBe("business-requirements");
    expect(manifest.sourceFingerprints[0].kind).toBe("requirements");

    await vi.waitFor(
      () => {
        const last = updateSpy.mock.calls.at(-1)?.[0] as { data?: Record<string, unknown> };
        expect(last?.data?.status).toBe("ready");
      },
      { timeout: 10_000, interval: 20 },
    );
  });
});
