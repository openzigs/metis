/** Real SQLite transactions + real TaskStore/TaskQueue/Scheduler startup.
 * Route authorization uses real JWTs, middleware and SQLite-backed memberships. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import { isolateSupertestLoopback } from "./helpers/supertest-loopback.js";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
import { issueTokens } from "../src/lib/auth/jwt.js";

const state = vi.hoisted(() => ({ db: null as PrismaClient | null, dispatch: vi.fn() }));
vi.mock("../src/lib/prisma.js", async () => ({
  Prisma: (await import("@prisma/client")).Prisma,
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/scheduler/index.js", () => ({
  getSchedulerBootstrap: () => ({ queue: { resume: state.dispatch, enqueue: state.dispatch } }),
}));
vi.mock("../src/lib/docs-gen/evidence-policy.js", () => ({
  resolveEvidencePolicy: async () => ({
    actor: { userId: "actor", role: "admin" },
    sharedDocumentIds: [],
    aclSubjects: [],
    allowWebResearch: false,
  }),
}));
vi.mock("../src/lib/docs-gen/generation-inputs.js", () => ({
  captureGenerationInputs: async () => ({ version: 1, fingerprint: "current", items: {} }),
}));
vi.mock("../src/lib/docs-gen/holistic-synthesizer.js", () => ({
  PHASE1_PROMPT_VERSION: 1,
  buildDocsGenProvider: () => ({ tuning: { phase1Model: "test" } }),
  resolvePhase2Router: () => ({
    primary: { tuning: { phase2Model: "test", claimModel: "test", judgeModel: "test" } },
    hybrid: null,
  }),
  synthesizeHolisticDocument: async () => ({
    markdown: "# Durable",
    warnings: [],
    provenanceManifest: null,
  }),
}));
vi.mock("../src/lib/docs-gen/grounding/grounding-retrieval.js", () => ({
  buildProjectGroundingContext: async () => undefined,
  buildSectionGroundingRetriever: () => async () => undefined,
}));
vi.mock("../src/lib/docs-gen/discovery-agent.js", () => ({
  DISCOVERY_SUMMARY_PROMPT_VERSION: 1,
  resolveDiscoveryGenerationModel: () => "test",
  runDiscoveryAgent: async () => [],
}));
vi.mock("../src/lib/docs-gen/assembler.js", () => ({ assembleDocument: () => "# Durable" }));
vi.mock("../src/lib/docs-gen/db-schema-synthesizer.js", () => ({
  DB_SCHEMA_PROSE_PROMPT_VERSION: 1,
  synthesizeDbSchemaDocument: vi.fn(),
}));
vi.mock("../src/lib/socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: () => "Generation failed",
}));
vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: async () => ({ storagePath: "doc.md", checksum: "hash", sizeBytes: 9 }),
  }),
}));
vi.mock("../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({ embed: async () => ({ model: "test", vectors: [[1, 0]] }) }),
}));
vi.mock("../src/lib/rag/quarantine.js", () => ({
  writeQuarantine: vi.fn(),
  shouldAutoApprove: async () => false,
}));
vi.mock("../src/lib/rag/vector-store.js", () => ({
  getVectorStore: () => ({ deleteByDocument: async () => {} }),
}));
vi.mock("../src/lib/rag/bm25-index.js", () => ({
  getBM25Index: () => ({ removeDocument: async () => {} }),
}));

import { generateDocumentAsync, generatedDocsRouter } from "../src/routes/generated-docs.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { TaskQueue } from "../src/lib/scheduler/task-queue.js";
import { SchedulerService } from "../src/lib/scheduler/scheduler-service.js";
import { createPrismaTaskStore } from "../src/lib/scheduler/task-store.js";
import {
  InMemoryTaskHandlerRegistry,
  registerBuiltInHandlers,
} from "../src/lib/scheduler/task-handlers.js";
import { publishGeneratedDocRevision } from "../src/lib/docs-gen/generated-doc-publication.js";
import { INDEXING_FAILED_MESSAGE } from "../src/lib/rag/indexing-failure-message.js";
import {
  dispatchGeneratedDocTask,
  generatedDocOutboxId,
} from "../src/lib/docs-gen/generated-doc-outbox.js";

describe.runIf(readGeneratedClientProvider() === "sqlite")(
  "transactional generated-doc outbox",
  () => {
    let db: PrismaClient;
    let directory: string;
    const instances: Array<{ queue: TaskQueue; service: SchedulerService }> = [];
    const revision = (version: number) => `gendoc:project:doc:v${version}`;
    const app = express();
    app.use("/projects/:projectId/docs", generatedDocsRouter());
    app.use(errorHandler);
    function authorization(
      userId = "actor",
      role: RoleKey = "coordinator",
      workspaces = ["workspace"],
    ) {
      return `Bearer ${
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces,
        }).accessToken
      }`;
    }
    const remove = () =>
      request(app).delete("/projects/project/docs/doc").set("Authorization", authorization());
    const automatic = {
      projectId: "project",
      generatedDocumentId: "doc",
      expectedVersion: 0,
      fingerprint: "current",
      signal: new AbortController().signal,
    };

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "metis-outbox-"));
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: `file:${join(directory, "test.db")}` }),
      });
      state.db = db;
      // Minimal real schema, including SQL constraints and defaults used by Prisma.
      for (const sql of [
        `CREATE TABLE projects (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL)`,
        `CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, status TEXT DEFAULT 'active', deletedAt DATETIME, authRolesInitializedAt DATETIME DEFAULT CURRENT_TIMESTAMP, authRoleAuthority TEXT DEFAULT 'explicit')`,
        `CREATE TABLE roles (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', isSystem BOOLEAN DEFAULT true, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE user_roles (userId TEXT REFERENCES users(id), roleId TEXT REFERENCES roles(id), source TEXT DEFAULT 'local', assignedAt DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(userId,roleId))`,
        `CREATE TABLE workspace_members (id TEXT PRIMARY KEY, userId TEXT REFERENCES users(id), workspaceId TEXT NOT NULL, role TEXT DEFAULT 'member', joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(workspaceId,userId))`,
        `CREATE TABLE generated_documents (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL, scope TEXT DEFAULT 'full', scopeFilter TEXT DEFAULT '{}', evidencePolicy TEXT, content TEXT DEFAULT '', codeGraphHash TEXT, schemaGraph TEXT, status TEXT DEFAULT 'pending', errorMessage TEXT, warnings JSONB, autoUpdate BOOLEAN DEFAULT true, generatedAt DATETIME, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL, deletedAt DATETIME)`,
        `CREATE TABLE generated_document_versions (id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES generated_documents(id), version INTEGER NOT NULL, revisionId TEXT, provenanceManifest TEXT, content TEXT NOT NULL, diffSummary TEXT, changedSymbols TEXT DEFAULT '[]', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(documentId,version))`,
        `CREATE TABLE tasks (id TEXT PRIMARY KEY, scheduledJobId TEXT, projectId TEXT, type TEXT NOT NULL, trigger TEXT DEFAULT 'manual', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 5, payload TEXT DEFAULT '{}', result TEXT, errorMessage TEXT, progress INTEGER, attempts INTEGER DEFAULT 0, maxAttempts INTEGER DEFAULT 3, scheduledFor DATETIME, startedAt DATETIME, completedAt DATETIME, createdById TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`,
        `CREATE TABLE scheduled_jobs (id TEXT PRIMARY KEY, key TEXT, name TEXT, cron TEXT, taskType TEXT, payload TEXT, projectId TEXT, enabled BOOLEAN, lastRunAt DATETIME, lastFiredAt DATETIME, nextRunAt DATETIME, maxAttempts INTEGER, createdById TEXT, createdAt DATETIME, updatedAt DATETIME, deletedAt DATETIME)`,
        `CREATE TABLE code_symbols (id TEXT PRIMARY KEY, projectId TEXT, contentHash TEXT, qualifiedName TEXT)`,
        `CREATE TABLE documents (id TEXT PRIMARY KEY, projectId TEXT, filename TEXT, mimeType TEXT, sizeBytes INTEGER, storagePath TEXT, checksum TEXT, status TEXT DEFAULT 'pending', indexState TEXT DEFAULT 'pending', autoApproveTrusted BOOLEAN DEFAULT false, aclSubjects TEXT DEFAULT '[]', isSpec BOOLEAN DEFAULT false, errorMessage TEXT, chunkCount INTEGER DEFAULT 0, uploadedById TEXT, uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP, processedAt DATETIME, deletedAt DATETIME)`,
        `CREATE TABLE quarantine_chunks (id TEXT PRIMARY KEY, documentId TEXT, projectId TEXT, ord INTEGER)`,
        `CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, documentId TEXT, projectId TEXT)`,
      ])
        await db.$executeRawUnsafe(sql);
      await db.$executeRaw`INSERT INTO projects (id, workspaceId) VALUES ('project', 'workspace')`;
      await db.$executeRaw`INSERT INTO roles (id, key, name) VALUES ('coordinator', 'coordinator', 'Coordinator'), ('reader', 'reader', 'Reader')`;
      for (const [userId, role, workspaceId] of [
        ["actor", "coordinator", "workspace"],
        ["reader", "reader", "workspace"],
        ["outsider", "coordinator", "other-workspace"],
      ]) {
        await db.$executeRaw`INSERT INTO users (id, username) VALUES (${userId}, ${userId})`;
        await db.$executeRaw`INSERT INTO user_roles (userId, roleId) VALUES (${userId}, ${role})`;
        await db.$executeRaw`INSERT INTO workspace_members (id, userId, workspaceId) VALUES (${userId}, ${userId}, ${workspaceId})`;
      }
    });
    beforeEach(async () => {
      vi.restoreAllMocks();
      isolateSupertestLoopback();
      state.dispatch.mockReset().mockImplementation(() => {
        throw new Error("process lost after SQL commit");
      });
      await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_outbox");
      for (const table of [
        "tasks",
        "documents",
        "generated_document_versions",
        "generated_documents",
      ])
        await db.$executeRawUnsafe(`DELETE FROM ${table}`);
      await db.generatedDocument.create({
        data: {
          id: "doc",
          projectId: "project",
          title: "Durable",
          scope: "full",
          evidencePolicy: "{}",
          autoUpdate: true,
        },
      });
    });
    afterEach(async () => {
      for (const { service, queue } of instances.splice(0)) {
        await service.stop();
        await queue.shutdown();
      }
    });
    afterAll(async () => {
      await db?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function restart() {
      const registry = new InMemoryTaskHandlerRegistry();
      const observed: unknown[] = [];
      registerBuiltInHandlers(registry, {
        httpWebhookHandler: async () => {},
        publishGeneratedDocument: async (
          generatedDocumentId,
          projectId,
          version,
          revisionId,
          signal,
        ) => {
          observed.push({ generatedDocumentId, projectId, version, revisionId });
          return publishGeneratedDocRevision(
            { generatedDocumentId, projectId, version, revisionId },
            { signal },
          );
        },
      });
      const emitter = { taskStatus() {}, taskProgress() {}, schedulerStatus() {} };
      const config = {
        concurrency: 1,
        tickMs: 1000,
        defaultTimeoutMs: 30_000,
        retryBackoffMs: 1,
        retryBackoffMaxMs: 2,
        minCronIntervalSec: 60,
        enabled: true,
      };
      const queue = new TaskQueue(createPrismaTaskStore(), registry, emitter, config);
      const service = new SchedulerService({ queue, registry, emitter, config });
      instances.push({ queue, service });
      await service.start();
      await vi.waitFor(() => expect(queue.snapshot()).toMatchObject({ running: 0, queueDepth: 0 }));
      expect(
        await db.task.findMany({ where: { status: "failed" }, select: { errorMessage: true } }),
      ).toEqual([]);
      return observed;
    }

    it.each(["manual", "regeneration"])(
      "%s commits a recoverable task with the version before dispatch",
      async (mode) => {
        await generateDocumentAsync(
          "doc",
          "project",
          mode === "regeneration" ? automatic : undefined,
        );
        expect(await db.generatedDocumentVersion.count()).toBe(1);
        const tasks = await db.task.findMany();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
          status: "pending",
          createdById: "actor",
          projectId: "project",
        });
        expect(JSON.parse(tasks[0].payload)).toEqual({
          projectId: "project",
          generatedDocumentId: "doc",
          version: 1,
          revisionId: revision(1),
        });
        expect(await restart()).toEqual([JSON.parse(tasks[0].payload)]);
        expect(await db.task.findUnique({ where: { id: tasks[0].id } })).toMatchObject({
          status: "completed",
          attempts: 1,
        });
      },
    );

    it.each(["manual", "regeneration"])(
      "%s rolls back the version and ready content if task insertion fails",
      async (mode) => {
        await db.$executeRawUnsafe(
          `CREATE TRIGGER fail_outbox BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'outbox disk failure'); END`,
        );
        const generation = generateDocumentAsync(
          "doc",
          "project",
          mode === "regeneration" ? automatic : undefined,
        );
        if (mode === "regeneration") await expect(generation).rejects.toThrow();
        else await generation;
        expect(await db.generatedDocumentVersion.count()).toBe(0);
        expect(await db.task.count()).toBe(0);
        expect(await db.generatedDocument.findUnique({ where: { id: "doc" } })).toMatchObject({
          status: "failed",
          content: "",
          codeGraphHash: null,
        });
        expect(state.dispatch).not.toHaveBeenCalled();
      },
    );

    it.each(["manual", "regeneration"])(
      "%s exposes the current outbox on both GETs before any publication worker",
      async (mode) => {
        await db.generatedDocumentVersion.create({
          data: { documentId: "doc", version: 1, revisionId: null, content: "legacy" },
        });
        await db.document.create({
          data: {
            id: "gendoc-doc",
            projectId: "project",
            uploadedById: "actor",
            filename: "legacy.md",
            mimeType: "text/markdown",
            sizeBytes: 6,
            storagePath: "legacy",
            checksum: "old",
            status: "ready",
            indexState: "indexed",
            chunkCount: 7,
          },
        });
        const getIndexing = async () => {
          const list = await request(app)
            .get("/projects/project/docs")
            .set("Authorization", authorization());
          const get = await request(app)
            .get("/projects/project/docs/doc")
            .set("Authorization", authorization());
          expect(list.status).toBe(200);
          expect(get.status).toBe(200);
          return [list.body.data[0].indexing, get.body.data.indexing];
        };
        // Truly legacy generations retain shared-ID indexing compatibility.
        for (const indexing of await getIndexing())
          expect(indexing).toMatchObject({ state: "indexed", chunkCount: 7 });
        await generateDocumentAsync(
          "doc",
          "project",
          mode === "regeneration" ? { ...automatic, expectedVersion: 1 } : undefined,
        );
        const task = await db.task.findFirstOrThrow();
        expect(task.status).toBe("pending");
        expect(JSON.parse(task.payload)).toMatchObject({ version: 2, revisionId: revision(2) });
        expect(await db.document.count()).toBe(1); // Only the old shared row exists.
        for (const indexing of await getIndexing())
          expect(indexing).toEqual({
            state: "pending",
            status: "pending",
            chunkCount: 0,
            errorMessage: null,
            processedAt: null,
          });
        await db.task.update({ where: { id: task.id }, data: { status: "running" } });
        for (const indexing of await getIndexing())
          expect(indexing).toMatchObject({ state: "pending", status: "processing", chunkCount: 0 });
        for (const status of ["failed", "cancelled"]) {
          await db.task.update({
            where: { id: task.id },
            data: { status, errorMessage: "publication stopped" },
          });
          for (const indexing of await getIndexing())
            expect(indexing).toEqual({
              state: "failed",
              status: "failed",
              chunkCount: 0,
              errorMessage: INDEXING_FAILED_MESSAGE, // #98 — never the task's raw error,
              processedAt: null,
            });
        }
        // Even after task retention removes the journal, the current manifest
        // cannot be mistaken for the older shared-ID publication.
        await db.task.delete({ where: { id: task.id } });
        for (const indexing of await getIndexing())
          expect(indexing).toMatchObject({ state: "pending", chunkCount: 0 });
      },
    );

    async function seedVersions() {
      for (const version of [1, 2])
        await db.generatedDocumentVersion.create({
          data: { documentId: "doc", version, revisionId: revision(version), content: "old" },
        });
    }
    it("regeneration of an existing history commits only the next immutable revision and its outbox", async () => {
      await seedVersions();
      await generateDocumentAsync("doc", "project", { ...automatic, expectedVersion: 2 });
      const task = await db.task.findFirstOrThrow();
      expect(JSON.parse(task.payload)).toEqual({
        projectId: "project",
        generatedDocumentId: "doc",
        version: 3,
        revisionId: revision(3),
      });
      expect(await db.generatedDocumentVersion.count()).toBe(3);
      expect(await restart()).toEqual([JSON.parse(task.payload)]);
      await generateDocumentAsync("doc", "project", { ...automatic, expectedVersion: 2 });
      expect(await db.task.count()).toBe(1);
      expect(await db.generatedDocumentVersion.count()).toBe(3);
    });
    it("deletion atomically retains every revision cleanup and repeated DELETE remains idempotent", async () => {
      await seedVersions();
      expect((await remove()).status).toBe(204);
      const tombstone = (await db.generatedDocument.findUniqueOrThrow({ where: { id: "doc" } }))
        .deletedAt;
      expect(tombstone).not.toBeNull();
      const tasks = await db.task.findMany({ orderBy: { payload: "asc" } });
      expect(tasks).toHaveLength(2);
      expect(tasks.map((task) => JSON.parse(task.payload).revisionId).sort()).toEqual([
        revision(1),
        revision(2),
      ]);
      expect((await remove()).status).toBe(204);
      expect(await db.task.count()).toBe(2);
      expect(
        (await db.generatedDocument.findUniqueOrThrow({ where: { id: "doc" } })).deletedAt,
      ).toEqual(tombstone);
      expect(await restart()).toHaveLength(2);
      expect(await db.task.count({ where: { status: "completed" } })).toBe(2);
    });
    it("rolls back the tombstone AND earlier tasks when a later cleanup insertion fails", async () => {
      await seedVersions();
      await db.$executeRawUnsafe(
        `CREATE TRIGGER fail_outbox BEFORE INSERT ON tasks WHEN json_extract(NEW.payload, '$.version') = 1 BEGIN SELECT RAISE(ABORT, 'outbox disk failure'); END`,
      );
      expect((await remove()).status).toBe(500);
      expect(
        (await db.generatedDocument.findUniqueOrThrow({ where: { id: "doc" } })).deletedAt,
      ).toBeNull();
      expect(await db.task.count()).toBe(0);
      expect(state.dispatch).not.toHaveBeenCalled();
    });
    it("does not revive cancelled publication on regeneration replay, but deletion owns separate cleanup work", async () => {
      await generateDocumentAsync("doc", "project", automatic);
      const task = await db.task.findFirstOrThrow();
      await db.task.update({ where: { id: task.id }, data: { status: "cancelled" } });
      state.dispatch.mockClear();
      await generateDocumentAsync("doc", "project", automatic);
      expect(await db.task.count()).toBe(1);
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(await restart()).toEqual([]);
      expect((await remove()).status).toBe(204);
      expect(await db.task.count()).toBe(2);
      expect(await restart()).toHaveLength(1);
      expect(await db.task.findUnique({ where: { id: task.id } })).toMatchObject({
        status: "cancelled",
      });
    });
    it("rejects a different project without tombstoning or scheduling anything", async () => {
      expect(
        (
          await request(app)
            .delete("/projects/foreign/docs/doc")
            .set("Authorization", authorization())
        ).status,
      ).toBe(404);
      expect(await db.task.count()).toBe(0);
      expect(
        (await db.generatedDocument.findUniqueOrThrow({ where: { id: "doc" } })).deletedAt,
      ).toBeNull();
    });

    it.each([
      {
        caller: "reader",
        role: "reader" as const,
        workspaces: ["workspace"],
        status: 403,
        code: "FORBIDDEN",
      },
      {
        caller: "outsider",
        role: "coordinator" as const,
        workspaces: ["other-workspace"],
        status: 404,
        code: "NOT_FOUND",
      },
      {
        caller: null,
        role: "coordinator" as const,
        workspaces: ["workspace"],
        status: 401,
        code: "AUTH_REQUIRED",
      },
    ])(
      "DELETE denies $caller with $status without mutating source, versions or tasks",
      async ({ caller, role, workspaces, status, code }) => {
        await generateDocumentAsync("doc", "project", automatic);
        const snapshot = async () => ({
          source: await db.generatedDocument.findUniqueOrThrow({ where: { id: "doc" } }),
          versions: await db.generatedDocumentVersion.findMany({ orderBy: { version: "asc" } }),
          tasks: await db.task.findMany({ orderBy: { id: "asc" } }),
        });
        const before = await snapshot();
        expect(before.source).toMatchObject({ status: "ready", deletedAt: null });
        expect(before.versions).toHaveLength(1);
        expect(before.tasks).toHaveLength(1);
        expect(before.tasks[0].status).toBe("pending");
        state.dispatch.mockClear();

        const req = request(app).delete("/projects/project/docs/doc");
        if (caller) req.set("Authorization", authorization(caller, role, workspaces));
        const response = await req;
        expect(response.status).toBe(status);
        expect(response.body.error.code).toBe(code);
        expect(await snapshot()).toEqual(before);
        expect(state.dispatch).not.toHaveBeenCalled();
      },
    );

    it("dispatch observes committed source and task rows from a separate database connection", async () => {
      const observer = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: `file:${join(directory, "test.db")}` }),
      });
      const observed: Promise<void>[] = [];
      state.dispatch.mockImplementation((task) => {
        observed.push(
          (async () => {
            expect(await observer.task.findUnique({ where: { id: task.id } })).toMatchObject({
              status: "pending",
            });
            expect(await observer.generatedDocumentVersion.count()).toBe(1);
            expect(
              await observer.generatedDocument.findUnique({ where: { id: "doc" } }),
            ).toMatchObject({ status: "ready", content: "# Durable" });
          })(),
        );
      });
      try {
        await generateDocumentAsync("doc", "project");
        expect(observed).toHaveLength(1);
        await Promise.all(observed);
      } finally {
        await observer.$disconnect();
      }
    });

    it("repairs a pre-existing tombstone with exact stored, manifest and legacy revision identities", async () => {
      // Use a valid generated manifest, then retain its historical identity while
      // the dedicated revisionId is NULL (legacy migration shape).
      await generateDocumentAsync("doc", "project");
      await db.task.deleteMany();
      const version = await db.generatedDocumentVersion.findFirstOrThrow();
      const manifest = JSON.parse(version.provenanceManifest!);
      manifest.revision.revisionId = "historical-manifest-id";
      await db.generatedDocumentVersion.update({
        where: { id: version.id },
        data: { revisionId: null, provenanceManifest: JSON.stringify(manifest) },
      });
      await db.generatedDocumentVersion.create({
        data: { documentId: "doc", version: 2, content: "legacy" },
      });
      await db.generatedDocumentVersion.create({
        data: { documentId: "doc", version: 3, revisionId: "stored-id", content: "stored" },
      });
      await db.generatedDocument.update({ where: { id: "doc" }, data: { deletedAt: new Date() } });
      expect((await remove()).status).toBe(204);
      expect(
        (await db.task.findMany()).map((task) => JSON.parse(task.payload).revisionId).sort(),
      ).toEqual([revision(2), "historical-manifest-id", "stored-id"].sort());
      expect(await restart()).toHaveLength(3);
    });

    it.each(["cancelled", "completed", "failed"])(
      "DELETE retry preserves %s cleanup unless explicitly retrying failure",
      async (status) => {
        await seedVersions();
        expect((await remove()).status).toBe(204);
        const before = await db.task.findMany();
        await db.task.updateMany({
          data: { status, attempts: 3, errorMessage: "previous result" },
        });
        state.dispatch.mockClear();
        expect((await remove()).status).toBe(204);
        const after = await db.task.findMany();
        expect(after.map((task) => task.id).sort()).toEqual(before.map((task) => task.id).sort());
        expect(
          after.every((task) => task.status === (status === "failed" ? "pending" : status)),
        ).toBe(true);
        expect(state.dispatch).toHaveBeenCalledTimes(status === "failed" ? 2 : 0);
        if (status === "failed") {
          expect(after.every((task) => task.attempts === 0 && task.errorMessage === null)).toBe(
            true,
          );
          expect(await restart()).toHaveLength(2);
        } else expect(await restart()).toEqual([]);
      },
    );

    it("cleans the legacy shared identity even without version history", async () => {
      await db.document.create({
        data: {
          id: "gendoc-doc",
          projectId: "project",
          filename: "old.md",
          mimeType: "text/markdown",
          sizeBytes: 1,
          storagePath: "old.md",
          checksum: "old",
          uploadedById: "actor",
        },
      });
      expect((await remove()).status).toBe(204);
      expect(await db.task.count()).toBe(1);
      expect(await restart()).toHaveLength(1);
      expect(await db.document.findUnique({ where: { id: "gendoc-doc" } })).toMatchObject({
        indexState: "rejected",
        deletedAt: expect.any(Date),
      });
    });

    it("ignores a missing dispatch row and uses collision-free exact tuple identities", async () => {
      await dispatchGeneratedDocTask("missing");
      expect(state.dispatch).not.toHaveBeenCalled();
      const payload = { projectId: "a:b", generatedDocumentId: "c", version: 1, revisionId: "r" };
      expect(generatedDocOutboxId(payload)).not.toBe(
        generatedDocOutboxId({ ...payload, projectId: "a", generatedDocumentId: "b:c" }),
      );
      expect(generatedDocOutboxId(payload)).not.toBe(generatedDocOutboxId(payload, "delete"));
    });
  },
);
