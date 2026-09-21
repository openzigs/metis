/**
 * Issue #1228 — a database-scope document that generated no table prose must
 * persist its warnings and reach `degraded`, not `ready` with `warnings = NULL`.
 *
 * The synthesizer's warnings are only worth producing if the route feeds them
 * into `deriveDocStatus`; the database branch was the one scope that never did.
 * These tests pin that wiring end to end through the real route handler.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const { synthesizeSpy, updateSpy, claimState, authState } = vi.hoisted(() => ({
  claimState: { codeGraphHash: null as string | null },
  synthesizeSpy: vi.fn(),
  updateSpy: vi.fn(async () => ({})),
  // The caller `requireAuth` installs. Mutable so the suite exercises a
  // NON-admin as well: an admin bypasses `assertProjectAccess`, so an
  // admin-only fixture could not notice the object-level guard disappearing
  // (#1058).
  authState: {
    user: { userId: "user_admin", username: "admin", role: "admin", permissions: [] } as Record<
      string,
      unknown
    >,
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
      // `workspaceId` feeds the real `assertProjectAccess`; the approval flag is
      // read by the export gate. One row satisfies both readers.
      findUnique: vi.fn(async () => ({ workspaceId: "ws-a", requireApprovedReview: false })),
    },
    generatedDocument: {
      create: vi.fn(async () => ({ id: "doc-db", projectId: "proj-1", status: "pending" })),
      findFirst: vi.fn(async () => ({
        id: "doc-db",
        projectId: "proj-1",
        codeGraphHash: claimState.codeGraphHash,
        evidencePolicy: JSON.stringify({
          version: 1,
          principal: { kind: "initiating-user", userId: "user_admin" },
          sharedDocumentIds: [],
          allowWebResearch: false,
        }),
        scope: "database",
        title: "Database Schema",
        scopeFilter: JSON.stringify({ dbConnectorId: "conn-1", actorId: "user_admin" }),
      })),
      update: updateSpy,
      updateMany: vi.fn(async (args) => {
        if (args.data.codeGraphHash) claimState.codeGraphHash = args.data.codeGraphHash;
        await updateSpy(args);
        return { count: 1 };
      }),
    },
    generatedDocumentVersion: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    codeSymbol: { findMany: vi.fn(async () => []) },
    task: { upsert: vi.fn(async ({ create }) => create), findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn) => fn((await import("../../src/lib/prisma.js")).prisma)),
  },
}));

vi.mock("../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = authState.user;
    next();
  },
  refreshAuthenticatedUser: (
    req: { user?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = authState.user;
    next();
  },
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

vi.mock("../../src/lib/docs-gen/db-schema-synthesizer.js", () => ({
  DB_SCHEMA_PROSE_PROMPT_VERSION: 1,
  synthesizeDbSchemaDocument: synthesizeSpy,
}));

// The 5-per-15-minute /generate limiter is process-wide, and vitest's `retry: 2`
// would otherwise let a single slow run exhaust it and turn a pass into a 429.
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

vi.mock("../../src/lib/docs-gen/rag-ingest.js", () => ({
  ingestDocumentToRag: vi.fn(async () => undefined),
}));

import { generatedDocsRouter } from "../../src/routes/generated-docs.js";
import { sectionFailedWarning } from "../../src/lib/docs-gen/grounding/degraded-warnings.js";

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

function postGenerate() {
  return request(buildApp())
    .post("/projects/proj-1/docs/generate")
    .send({
      title: "Database Schema",
      scope: "database",
      scopeFilter: { dbConnectorId: "conn-1" },
    });
}

/** The final `update` the route makes after generation completes. */
async function generateAndReadFinalUpdate(): Promise<Record<string, unknown>> {
  const res = await postGenerate();
  expect(res.status).toBe(202);

  // Generation is fire-and-forget; under parallel suite load the terminal update
  // lands well after the 202, so this waits generously rather than racing it.
  await vi.waitFor(
    () => {
      const last = updateSpy.mock.calls.at(-1)?.[0] as
        | { data?: Record<string, unknown> }
        | undefined;
      expect(last?.data?.status).not.toBe("generating");
      expect(last?.data?.generatedAt).toBeDefined();
    },
    { timeout: 10_000, interval: 20 },
  );
  const last = updateSpy.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
  return last.data;
}

beforeEach(() => {
  updateSpy.mockClear();
  synthesizeSpy.mockReset();
  claimState.codeGraphHash = null;
  authState.user = { userId: "user_admin", username: "admin", role: "admin", permissions: [] };
});

describe("#1228 — database-scope docs surface their prose warnings", () => {
  it("persists the warnings and marks the document degraded", async () => {
    synthesizeSpy.mockResolvedValue({
      markdown: "# Database Schema\n",
      schemaGraph: null,
      generationModel: "db-schema-test-model",
      warnings: [sectionFailedWarning("Table Reference", "0 of 641 tables described")],
    });

    const data = await generateAndReadFinalUpdate();

    expect(data.status).toBe("degraded");
    expect(data.warnings).not.toBe("__DbNull__");
    expect(Array.isArray(data.warnings)).toBe(true);
    expect((data.warnings as Array<{ kind: string }>)[0]?.kind).toBe("section-failed");
  });

  it("still reaches ready with no warnings when every table was described", async () => {
    synthesizeSpy.mockResolvedValue({
      markdown: "# Database Schema\n",
      schemaGraph: null,
      generationModel: "db-schema-test-model",
      warnings: [],
    });

    const data = await generateAndReadFinalUpdate();

    expect(data.status).toBe("ready");
    expect(data.warnings).toBe("__DbNull__");
  });
});

describe("#1228 — the generate route still enforces project scope", () => {
  it("404s a non-admin caller from another workspace instead of generating", async () => {
    authState.user = {
      userId: "u_reader",
      username: "reader",
      role: "reader",
      permissions: [],
      workspaces: ["ws-other"],
    };
    synthesizeSpy.mockResolvedValue({
      markdown: "#",
      schemaGraph: null,
      generationModel: "db-schema-test-model",
      warnings: [],
    });

    const res = await postGenerate();

    expect(res.status).toBe(404);
    expect(synthesizeSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
