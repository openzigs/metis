/** Real SQLite + file-backed vector store + MiniSearch; only external dependencies
 * and authentication setup are substituted. Barriers pause store boundaries,
 * with final selection paused before acquiring project-write coordination. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import express from "express";
import request from "supertest";
import MiniSearch from "minisearch";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import { isolateSupertestLoopback } from "./helpers/supertest-loopback.js";
import type { LocalVectorStore as LocalStore } from "../src/lib/rag/vector-store.js";
import type { ProjectVectorWrite } from "../src/lib/rag/project-vector-write.js";

const state = vi.hoisted(() => ({
  db: null as PrismaClient | null,
  vector: null as LocalStore | null,
}));
vi.mock("../src/lib/prisma.js", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/rag/knowledge-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: () => ({}),
}));
vi.mock("../src/lib/scheduler/index.js", () => ({ getSchedulerBootstrap: vi.fn() }));
vi.mock("../src/lib/rag/vector-store.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/vector-store.js")>()),
  getVectorStore: () => state.vector,
}));

import { LocalVectorStore } from "../src/lib/rag/vector-store.js";
import { getBM25Index, __resetBM25IndexSingleton } from "../src/lib/rag/bm25-index.js";
import { approveDocument, listQuarantine, writeQuarantine } from "../src/lib/rag/quarantine.js";
import { KnowledgeService } from "../src/lib/rag/knowledge-service.js";
import { publishGeneratedDocRevision } from "../src/lib/docs-gen/generated-doc-publication.js";
import { documentsRouter } from "../src/routes/documents.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
import { createEvidencePolicy } from "../src/lib/docs-gen/evidence-policy.js";
import { generatedDocRevisionId } from "../src/lib/docs-gen/generated-doc-provenance.js";

// A generated Postgres Prisma client cannot use the SQLite adapter. This proof
// runs with the SQLite client, never the developer's configured application DB.
describe.runIf(readGeneratedClientProvider() === "sqlite")("SQLite publication persistence", () => {
  let db: PrismaClient;
  let directory: string;
  const payload = (version: number) => ({
    projectId: "project",
    generatedDocumentId: "doc",
    version,
    revisionId: generatedDocRevisionId({
      projectId: "project",
      generatedDocumentId: "doc",
      version,
    }),
  });
  const deps = {
    storage: {
      write: async () => ({ storagePath: "doc.md", checksum: "hash", sizeBytes: 20 }),
    } as never,
    embedder: {
      embed: async (texts: string[]) => ({ model: "test", vectors: texts.map(() => [1, 0]) }),
    } as never,
  };
  function approvalApp() {
    const app = express();
    app.use(
      "/projects/:projectId/documents",
      documentsRouter({ storage: deps.storage, ingestQueue: null }),
    );
    app.use(errorHandler);
    return app;
  }
  function authorization(role: RoleKey, workspaces: string[]) {
    return `Bearer ${
      issueTokens({
        userId: "actor",
        username: "actor",
        role,
        permissions: getPermissionsForRole(role),
        workspaces,
      }).accessToken
    }`;
  }
  function barrier() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      entered,
      release,
      pause: async () => {
        enter();
        await resumed;
      },
    };
  }
  function pauseNextFinalSelection(gate: ReturnType<typeof barrier>) {
    const vector = state.vector!;
    const withProjectWrite = vector.withProjectWrite.bind(vector);
    let pending = true;
    vi.spyOn(vector, "withProjectWrite").mockImplementation(async function <T>(
      projectId: string,
      fn: (write: ProjectVectorWrite) => Promise<T>,
    ): Promise<T> {
      if (projectId === "project" && pending) {
        // Consume the barrier before yielding so the competing approval passes.
        // Pausing $transaction here would already hold the project lock.
        pending = false;
        await gate.pause();
      }
      return withProjectWrite(projectId, fn);
    });
  }
  async function version(n: number, content = n === 1 ? "alpha" : "bravo") {
    await db.generatedDocumentVersion.create({
      data: {
        documentId: "doc",
        version: n,
        revisionId: payload(n).revisionId,
        content,
      },
    });
  }
  async function assertLive(text: string) {
    const chunks = await db.knowledgeChunk.findMany({ where: { text } });
    expect(chunks).toHaveLength(1);
    const doc = await db.document.findUniqueOrThrow({ where: { id: chunks[0].documentId } });
    expect(doc).toMatchObject({ deletedAt: null, indexState: "indexed", status: "ready" });
    expect((await getBM25Index().search("project", text, 20)).map((hit) => hit.chunkId)).toContain(
      chunks[0].id,
    );
    expect((await state.vector!.search("project", [1, 0], 20)).map((hit) => hit.row.id)).toContain(
      chunks[0].id,
    );
  }
  async function seedQuarantine(chunks = true) {
    await db.document.create({
      data: {
        id: "ordinary",
        projectId: "project",
        filename: "ordinary.md",
        mimeType: "text/markdown",
        sizeBytes: 5,
        storagePath: "ordinary.md",
        checksum: "hash",
        uploadedById: "actor",
      },
    });
    await writeQuarantine({
      documentId: "ordinary",
      projectId: "project",
      filename: "ordinary.md",
      chunks: chunks ? [{ ord: 0, text: "alpha", md5: "hash", embedding: [1, 0] }] : [],
      embeddingModel: "test",
      aclSubjects: [],
    });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "metis-publication-ownership-"));
    db = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: `file:${join(directory, "db.sqlite")}` }),
    });
    state.db = db;
    // Exact scalar columns used by the real Prisma models; no app DB or migration state touched.
    const tables = [
      `CREATE TABLE projects (id TEXT PRIMARY KEY, workspaceId TEXT, deletedAt DATETIME,
      autoApproveTrustedSources BOOLEAN DEFAULT true)`,
      `CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, displayName TEXT, email TEXT,
      status TEXT DEFAULT 'active', lastLoginAt DATETIME, authRolesInitializedAt DATETIME,
      authRoleAuthority TEXT DEFAULT 'explicit', passwordHash TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      deletedAt DATETIME)`,
      `CREATE TABLE roles (id TEXT PRIMARY KEY, key TEXT, name TEXT, description TEXT DEFAULT '',
      isSystem BOOLEAN DEFAULT true, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE user_roles (userId TEXT, roleId TEXT, source TEXT DEFAULT 'local',
      assignedAt DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(userId, roleId))`,
      `CREATE TABLE workspace_members (id TEXT PRIMARY KEY, workspaceId TEXT, userId TEXT,
      role TEXT DEFAULT 'member', joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE generated_documents (id TEXT PRIMARY KEY, projectId TEXT, title TEXT, scope TEXT,
      scopeFilter TEXT, evidencePolicy TEXT, deletedAt DATETIME,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE generated_document_versions (id TEXT PRIMARY KEY, documentId TEXT, version INTEGER,
      revisionId TEXT, provenanceManifest TEXT, content TEXT, diffSummary TEXT,
      changedSymbols TEXT DEFAULT '[]', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(documentId,version))`,
      `CREATE TABLE documents (id TEXT PRIMARY KEY, projectId TEXT, filename TEXT, mimeType TEXT,
      sizeBytes INTEGER, storagePath TEXT, checksum TEXT, status TEXT DEFAULT 'pending',
      indexState TEXT DEFAULT 'pending', autoApproveTrusted BOOLEAN DEFAULT false,
      aclSubjects TEXT DEFAULT '[]', isSpec BOOLEAN DEFAULT false, errorMessage TEXT,
      chunkCount INTEGER DEFAULT 0, uploadedById TEXT, uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      processedAt DATETIME, deletedAt DATETIME)`,
      `CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, projectId TEXT, documentId TEXT,
      position INTEGER, text TEXT, md5 TEXT, embeddingModel TEXT, chunkerIdentity TEXT,
      vectorRef TEXT, metadata TEXT, aclSubjects TEXT DEFAULT '[]', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE quarantine_chunks (id TEXT PRIMARY KEY, documentId TEXT, projectId TEXT,
      ord INTEGER, text TEXT, embedding TEXT, metadata TEXT DEFAULT '{}', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    ];
    for (const sql of tables) await db.$executeRawUnsafe(sql);
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    vi.restoreAllMocks();
    isolateSupertestLoopback();
    for (const table of [
      "quarantine_chunks",
      "knowledge_chunks",
      "documents",
      "generated_document_versions",
      "generated_documents",
      "projects",
      "workspace_members",
      "user_roles",
      "roles",
      "users",
    ]) {
      await db.$executeRawUnsafe(`DELETE FROM ${table}`);
    }
    await db.$executeRaw`INSERT INTO projects (id, workspaceId) VALUES ('project', 'workspace')`;
    await db.$executeRaw`INSERT INTO generated_documents (id,projectId,title,scope,scopeFilter,evidencePolicy)
    VALUES ('doc','project','Example','full','{}',${createEvidencePolicy({
      userId: "initiator",
      username: "initiator",
      role: "coordinator",
      permissions: getPermissionsForRole("coordinator"),
    })})`;
    await db.$executeRaw`INSERT INTO users (id,username,displayName,email) VALUES
      ('initiator','initiator','Initiator','initiator@example.test'),
      ('actor','actor','Approver','actor@example.test')`;
    await db.$executeRaw`INSERT INTO roles (id,key,name) VALUES
      ('developer','developer','Developer'),('coordinator','coordinator','Coordinator')`;
    await db.$executeRaw`INSERT INTO user_roles (userId,roleId) VALUES
      ('initiator','coordinator'),('actor','developer')`;
    await db.$executeRaw`INSERT INTO workspace_members (id,workspaceId,userId) VALUES
      ('initiator-membership','workspace','initiator'),('actor-membership','workspace','actor')`;
    state.vector = new LocalVectorStore({ root: join(directory, "vectors") });
    await state.vector.dropTable("project");
    __resetBM25IndexSingleton();
    await version(1);
  });

  describe("generated manual approval fence", () => {
    const syntheticId = `gendoc-doc:${payload(1).revisionId}`;
    async function quarantineGenerated() {
      await db.$executeRaw`UPDATE projects SET autoApproveTrustedSources = false WHERE id = 'project'`;
      await publishGeneratedDocRevision(payload(1), deps);
      expect(await db.document.findUnique({ where: { id: syntheticId } })).toMatchObject({
        indexState: "quarantined",
      });
    }
    async function expectNoPublication() {
      expect(await db.knowledgeChunk.count()).toBe(0);
      expect(await state.vector!.search("project", [1, 0], 20)).toEqual([]);
      expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
      __resetBM25IndexSingleton();
      expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
    }
    async function revoke(kind: string) {
      if (kind === "superseded") await version(2);
      else if (kind === "deleted") {
        await db.$executeRaw`UPDATE generated_documents SET deletedAt = CURRENT_TIMESTAMP WHERE id = 'doc'`;
      } else if (kind === "membership") {
        await db.workspaceMember.deleteMany({ where: { userId: "initiator" } });
      } else if (kind === "policy") {
        await db.$executeRaw`UPDATE generated_documents SET evidencePolicy = '{}' WHERE id = 'doc'`;
      } else {
        await db.userRole.deleteMany({ where: { userId: "initiator" } });
      }
    }

    it.each(["quarantined", "indexed", "reconciling"])(
      "approves the current production-shaped revision from %s without losing its colon suffix",
      async (indexState) => {
        await quarantineGenerated();
        expect(syntheticId).toBe("gendoc-doc:gendoc:project:doc:v1");
        if (indexState === "reconciling") {
          vi.spyOn(state.vector!, "deleteByChunkIds").mockRejectedValueOnce(
            new Error("cleanup unavailable"),
          );
          await expect(approveDocument(syntheticId, { id: "actor" })).rejects.toThrow(
            "cleanup unavailable",
          );
        } else if (indexState === "indexed") {
          await expect(approveDocument(syntheticId, { id: "actor" })).resolves.toEqual({
            chunkCount: 1,
          });
        }
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId } })).toMatchObject({
          indexState,
        });
        const selected = await db.knowledgeChunk.findMany({ where: { documentId: syntheticId } });
        await expect(approveDocument(syntheticId, { id: "actor" })).resolves.toEqual({
          chunkCount: 1,
        });
        if (indexState !== "quarantined") {
          expect(selected).toHaveLength(1);
          expect(await db.knowledgeChunk.findMany({ where: { documentId: syntheticId } })).toEqual(
            selected,
          );
        }
        await assertLive("alpha");
        expect(await listQuarantine("project")).toEqual([]);
      },
    );

    it("denies stale colon-containing manual v1 after v2 commit and failed embedding before old cleanup", async () => {
      await quarantineGenerated();
      await version(2);
      expect(syntheticId).toBe("gendoc-doc:gendoc:project:doc:v1");
      expect(
        await db.generatedDocumentVersion.findFirst({
          where: { documentId: "doc" },
          orderBy: { version: "desc" },
        }),
      ).toMatchObject({ revisionId: payload(2).revisionId });
      await expect(
        publishGeneratedDocRevision(payload(2), {
          ...deps,
          embedder: {
            embed: async () => {
              throw new Error("v2 embedding failed");
            },
          } as never,
        }),
      ).rejects.toThrow("v2 embedding failed");
      expect((await listQuarantine("project")).map((row) => row.documentId)).toContain(syntheticId);
      await expect(approveDocument(syntheticId, { id: "actor" })).rejects.toThrow(
        "revision unavailable",
      );
      const response = await request(approvalApp())
        .post(`/projects/project/documents/${syntheticId}/approve`)
        .set("Authorization", authorization("developer", ["workspace"]));
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("DOCUMENT_APPROVE_FAILED");
      await expectNoPublication();
      expect(
        await db.quarantineChunk.count({ where: { documentId: syntheticId, ord: { gte: 0 } } }),
      ).toBe(1);
    });

    it.each(["deleted", "role", "membership", "policy"])(
      "denies initial approval after original generation %s revocation, not the approver's grant",
      async (kind) => {
        await quarantineGenerated();
        await revoke(kind);
        await expect(
          approveDocument(syntheticId, { id: "actor", role: "admin" }),
        ).rejects.toThrow();
        expect(await db.quarantineChunk.count({ where: { ord: { lt: 0 } } })).toBe(0);
        await expectNoPublication();
      },
    );

    it.each(["superseded", "deleted", "role", "membership", "policy"])(
      "fences %s at final selection after speculative vector and sparse writes",
      async (kind) => {
        await quarantineGenerated();
        const gate = barrier();
        pauseNextFinalSelection(gate);
        const approving = approveDocument(syntheticId, { id: "actor" }).catch(
          (error: unknown) => error,
        );
        await gate.entered;
        try {
          await revoke(kind);
        } finally {
          gate.release();
        }
        expect(await approving).toBeInstanceOf(Error);
        await expectNoPublication();
      },
    );

    it.each(["warm", "cold"])(
      "current generated manual approval has a discoverable %s cleanup retry",
      async (temperature) => {
        await quarantineGenerated();
        const remove = state.vector!.deleteByChunkIds.bind(state.vector);
        vi.spyOn(state.vector!, "deleteByChunkIds").mockRejectedValueOnce(
          new Error("cleanup unavailable"),
        );
        const app = approvalApp();
        const token = authorization("developer", ["workspace"]);
        const response = await request(app)
          .post(`/projects/project/documents/${syntheticId}/approve`)
          .set("Authorization", token);
        expect(response.status).toBe(409);
        expect(await listQuarantine("project")).toEqual([
          expect.objectContaining({
            documentId: syntheticId,
            indexState: "reconciling",
            errorMessage: "cleanup unavailable",
          }),
        ]);
        const selected = (await db.knowledgeChunk.findMany()).map((row) => row.id);
        expect(selected).toHaveLength(1);
        if (temperature === "cold") {
          __resetBM25IndexSingleton();
          state.vector = new LocalVectorStore({ root: join(directory, "vectors") });
        } else vi.spyOn(state.vector!, "deleteByChunkIds").mockImplementation(remove);
        const retried = await request(app)
          .post(`/projects/project/documents/${syntheticId}/approve`)
          .set("Authorization", token);
        expect(retried.status).toBe(200);
        expect((await db.knowledgeChunk.findMany()).map((row) => row.id)).toEqual(selected);
        await assertLive("alpha");
        expect(await listQuarantine("project")).toEqual([]);
      },
    );

    it.each(["superseded", "deleted", "role"])(
      "cleanup retry cannot mark %s generation indexed",
      async (kind) => {
        await quarantineGenerated();
        vi.spyOn(state.vector!, "deleteByChunkIds").mockRejectedValueOnce(
          new Error("cleanup unavailable"),
        );
        await expect(approveDocument(syntheticId, { id: "actor" })).rejects.toThrow(
          "cleanup unavailable",
        );
        await revoke(kind);
        const selected = await db.knowledgeChunk.findMany();
        await expect(approveDocument(syntheticId, { id: "actor" })).rejects.toThrow();
        expect(await db.document.findUnique({ where: { id: syntheticId } })).toMatchObject({
          indexState: "reconciling",
        });
        expect(await db.knowledgeChunk.findMany()).toEqual(selected);
      },
    );

    it.each(["superseded", "role"])(
      "cleanup completion rechecks %s after external IO",
      async (kind) => {
        await quarantineGenerated();
        const remove = state.vector!.deleteByChunkIds.bind(state.vector);
        let calls = 0;
        vi.spyOn(state.vector!, "deleteByChunkIds").mockImplementation(async (...args) => {
          // The second deletion belongs to reconciliation, after its initial fence.
          if (++calls === 2) await revoke(kind);
          return remove(...args);
        });
        await expect(approveDocument(syntheticId, { id: "actor" })).rejects.toThrow();
        expect(await db.document.findUnique({ where: { id: syntheticId } })).toMatchObject({
          indexState: "reconciling",
        });
      },
    );
  });

  describe("revision ownership at actual store boundaries", () => {
    it.each(["sql", "final-sql", "vector", "bm25"])(
      "same revision overlap at %s keeps the winning attempt in every store",
      async (boundary) => {
        const gate = barrier();
        if (boundary === "final-sql") {
          pauseNextFinalSelection(gate);
        } else if (boundary === "sql") {
          const transaction = db.$transaction.bind(db);
          let calls = 0;
          vi.spyOn(db, "$transaction").mockImplementation((async (
            arg: unknown,
            options: unknown,
          ) => {
            if (++calls === 2) await gate.pause();
            return transaction(arg as never, options as never);
          }) as typeof db.$transaction);
        } else if (boundary === "vector") {
          const upsert = state.vector!.upsert.bind(state.vector);
          vi.spyOn(state.vector!, "upsert").mockImplementationOnce(async (...args) => {
            await gate.pause();
            return upsert(...args);
          });
        } else {
          const upsert = getBM25Index().upsertDocumentChunks.bind(getBM25Index());
          vi.spyOn(getBM25Index(), "upsertDocumentChunks").mockImplementationOnce(
            async (...args) => {
              await gate.pause();
              return upsert(...args);
            },
          );
        }
        const stale = publishGeneratedDocRevision(payload(1), deps).catch(
          (error: unknown) => error,
        );
        await gate.entered;
        try {
          await publishGeneratedDocRevision(payload(1), deps);
        } finally {
          gate.release();
          await stale;
        }
        await assertLive("alpha");
        __resetBM25IndexSingleton();
        await publishGeneratedDocRevision(payload(1), deps);
        await assertLive("alpha");
        expect(await state.vector!.count("project")).toBe(1);
      },
    );

    it("shared route duplicate approval cannot compensate the winner", async () => {
      await seedQuarantine();
      const app = approvalApp();
      const token = authorization("developer", ["workspace"]);
      const gate = barrier();
      const upsert = state.vector!.upsert.bind(state.vector);
      vi.spyOn(state.vector!, "upsert").mockImplementationOnce(async (...args) => {
        await gate.pause();
        return upsert(...args);
      });
      const stale = request(app)
        .post("/projects/project/documents/ordinary/approve")
        .set("Authorization", token)
        .then((response) => response);
      await gate.entered;
      try {
        expect(
          (
            await request(app)
              .post("/projects/project/documents/ordinary/approve")
              .set("Authorization", token)
          ).status,
        ).toBe(200);
      } finally {
        gate.release();
      }
      await stale;
      await assertLive("alpha");
      __resetBM25IndexSingleton();
      await assertLive("alpha");
      expect(await state.vector!.count("project")).toBe(1);
    });

    it.each([
      { role: "reader" as const, workspaces: ["workspace"], status: 403, code: "FORBIDDEN" },
      {
        role: "developer" as const,
        workspaces: ["other-workspace"],
        status: 404,
        code: "NOT_FOUND",
      },
    ])(
      "shared approval denies $role with $code without mutating any store",
      async ({ role, workspaces, status, code }) => {
        await seedQuarantine();
        const before = await db.quarantineChunk.findMany();
        const response = await request(approvalApp())
          .post("/projects/project/documents/ordinary/approve")
          .set("Authorization", authorization(role, workspaces));
        expect(response.status).toBe(status);
        expect(response.body.error.code).toBe(code);
        expect(
          (await db.document.findUniqueOrThrow({ where: { id: "ordinary" } })).indexState,
        ).toBe("quarantined");
        expect(await db.quarantineChunk.findMany()).toEqual(before);
        expect(await db.knowledgeChunk.count()).toBe(0);
        expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
        expect(await state.vector!.search("project", [1, 0], 20)).toEqual([]);
      },
    );

    it("shared approval requires an authenticated caller", async () => {
      await seedQuarantine();
      const response = await request(approvalApp()).post(
        "/projects/project/documents/ordinary/approve",
      );
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("AUTH_REQUIRED");
      expect(await db.knowledgeChunk.count()).toBe(0);
    });

    it.each(["vector", "bm25"])(
      "deletion paused at %s cannot erase a newly published revision",
      async (boundary) => {
        await publishGeneratedDocRevision(payload(1), deps);
        await db.$executeRaw`UPDATE generated_documents SET deletedAt = CURRENT_TIMESTAMP WHERE id = 'doc'`;
        const gate = barrier();
        if (boundary === "vector") {
          const remove = state.vector!.deleteByDocument.bind(state.vector);
          vi.spyOn(state.vector!, "deleteByDocument").mockImplementationOnce(async (...args) => {
            await gate.pause();
            return remove(...args);
          });
        } else {
          const remove = getBM25Index().removeDocument.bind(getBM25Index());
          vi.spyOn(getBM25Index(), "removeDocument").mockImplementationOnce(async (...args) => {
            await gate.pause();
            return remove(...args);
          });
        }
        const deleting = publishGeneratedDocRevision(payload(1), deps);
        await gate.entered;
        await db.$executeRaw`UPDATE generated_documents SET deletedAt = NULL WHERE id = 'doc'`;
        await version(2);
        try {
          await publishGeneratedDocRevision(payload(2), deps);
        } finally {
          gate.release();
        }
        await deleting;
        await assertLive("bravo");
      },
    );

    it("deletion before approval acquires final selection coordination cannot resurrect indexed status", async () => {
      await seedQuarantine();
      const gate = barrier();
      pauseNextFinalSelection(gate);
      const approving = approveDocument("ordinary", { id: "actor" }).catch(
        (error: unknown) => error,
      );
      await gate.entered;
      try {
        await db.document.update({
          where: { id: "ordinary" },
          data: { deletedAt: new Date(), indexState: "rejected" },
        });
      } finally {
        gate.release();
        await approving;
      }
      expect(await approving).toBeInstanceOf(Error);
      expect((await db.document.findUniqueOrThrow({ where: { id: "ordinary" } })).indexState).toBe(
        "rejected",
      );
      expect(await db.knowledgeChunk.count()).toBe(0);
      expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
      expect(await state.vector!.search("project", [1, 0], 20)).toEqual([]);
    });

    it("v1 paused after quarantine cannot erase successfully published v2", async () => {
      const gate = barrier();
      const transaction = db.$transaction.bind(db);
      vi.spyOn(db, "$transaction").mockImplementationOnce((async (
        args: unknown,
        options: unknown,
      ) => {
        const result = await transaction(args as never, options as never);
        await gate.pause();
        return result;
      }) as typeof db.$transaction);
      const stale = publishGeneratedDocRevision(payload(1), deps);
      await gate.entered;
      await version(2);
      try {
        await publishGeneratedDocRevision(payload(2), deps);
        await assertLive("bravo");
      } finally {
        gate.release();
      }
      await stale;
      await assertLive("bravo");
    });

    it.each(["final-sql", "vector", "bm25"])(
      "v1 paused at %s approval mutation cannot overwrite or clean v2",
      async (boundary) => {
        const gate = barrier();
        if (boundary === "final-sql") {
          pauseNextFinalSelection(gate);
        } else if (boundary === "vector") {
          const upsert = state.vector!.upsert.bind(state.vector);
          vi.spyOn(state.vector!, "upsert").mockImplementationOnce(async (...args) => {
            await gate.pause();
            return upsert(...args);
          });
        } else {
          const upsert = getBM25Index().upsertDocumentChunks.bind(getBM25Index());
          vi.spyOn(getBM25Index(), "upsertDocumentChunks").mockImplementationOnce(
            async (...args) => {
              await gate.pause();
              return upsert(...args);
            },
          );
        }
        const stale = publishGeneratedDocRevision(payload(1), deps).catch(
          (error: unknown) => error,
        );
        await gate.entered;
        try {
          await version(2);
          await publishGeneratedDocRevision(payload(2), deps);
        } finally {
          gate.release();
          await stale;
        }
        await assertLive("bravo");
        expect(await db.knowledgeChunk.count({ where: { text: "alpha" } })).toBe(0);
        expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
      },
    );
  });

  describe("real shared approval sparse failures and retries", () => {
    it("ordinary auto-approval preserves selected count and cleanup error on failure", async () => {
      await seedQuarantine();
      const service = new KnowledgeService({
        storage: { read: async () => Buffer.from("bravo") } as never,
        embedder: deps.embedder,
        vectorStore: state.vector!,
        bm25: getBM25Index(),
      });
      const remove = getBM25Index().removeChunkIds.bind(getBM25Index());
      let calls = 0;
      vi.spyOn(getBM25Index(), "removeChunkIds").mockImplementation(async (...args) => {
        if (++calls === 2) throw new Error("ordinary cleanup failed");
        return remove(...args);
      });
      expect(await service.ingestDocument("ordinary")).toMatchObject({ status: "failed" });
      expect(await db.document.findFirst()).toMatchObject({
        indexState: "reconciling",
        status: "failed",
        chunkCount: 1,
        errorMessage: "ordinary cleanup failed",
      });
      await approveDocument("ordinary", { id: "actor" });
      await assertLive("bravo");
    });

    it("a stale ordinary ingest cannot replace a newer ingest generation after parsing resumes", async () => {
      await seedQuarantine();
      const parsing = barrier();
      const staleService = new KnowledgeService({
        storage: {
          read: async () => {
            await parsing.pause();
            return Buffer.from("stale");
          },
        } as never,
        embedder: deps.embedder,
        vectorStore: state.vector!,
        bm25: getBM25Index(),
      });
      const newerService = new KnowledgeService({
        storage: { read: async () => Buffer.from("bravo") } as never,
        embedder: deps.embedder,
        vectorStore: state.vector!,
        bm25: getBM25Index(),
      });
      const stale = staleService.ingestDocument("ordinary").catch((error: unknown) => error);
      await parsing.entered;
      try {
        await newerService.ingestDocument("ordinary");
      } finally {
        parsing.release();
      }
      expect(await stale).toEqual(
        expect.objectContaining({ message: "Document ordinary ingest generation revoked" }),
      );
      await assertLive("bravo");
      expect(await getBM25Index().search("project", "stale", 20)).toEqual([]);
    });

    it("repeated postcommit task failures never advertise an indexed winner", async () => {
      const remove = getBM25Index().removeChunkIds.bind(getBM25Index());
      vi.spyOn(getBM25Index(), "removeChunkIds").mockRejectedValue(
        new Error("terminal cleanup failure"),
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(publishGeneratedDocRevision(payload(1), deps)).rejects.toThrow(
          "terminal cleanup failure",
        );
        expect(await db.document.findFirst()).toMatchObject({
          indexState: "reconciling",
          status: "failed",
          errorMessage: "terminal cleanup failure",
          chunkCount: 1,
        });
        expect(await db.knowledgeChunk.count()).toBe(1);
      }
      vi.spyOn(getBM25Index(), "removeChunkIds").mockImplementation(remove);
      await publishGeneratedDocRevision(payload(1), deps);
      await assertLive("alpha");
    });

    it.each(["warm", "cold"])(
      "%s postcommit cleanup failure is not indexed in the SQL status route",
      async (temperature) => {
        await seedQuarantine();
        await getBM25Index().upsertDocumentChunks("project", "ordinary", "ordinary.md", [
          { id: "old", position: 0, text: "obsolete" },
        ]);
        vi.spyOn(MiniSearch.prototype, "discard").mockImplementationOnce(() => {
          throw new Error("postcommit cleanup failed");
        });
        await expect(approveDocument("ordinary", { id: "actor" })).rejects.toThrow(
          "postcommit cleanup failed",
        );
        const selected = await db.knowledgeChunk.findMany();
        expect(selected).toHaveLength(1);
        const response = await request(approvalApp())
          .get("/projects/project/documents/ordinary")
          .set("Authorization", authorization("developer", ["workspace"]));
        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({
          indexState: "reconciling",
          status: "failed",
          errorMessage: "postcommit cleanup failed",
        });
        if (temperature === "cold") {
          __resetBM25IndexSingleton();
          state.vector = new LocalVectorStore({ root: join(directory, "vectors") });
        }
        await approveDocument("ordinary", { id: "actor" });
        expect((await db.knowledgeChunk.findMany()).map((row) => row.id)).toEqual(
          selected.map((row) => row.id),
        );
        await assertLive("alpha");
        expect(await getBM25Index().search("project", "obsolete", 20)).toEqual([]);
      },
    );

    it("ordinary production reingest cannot commit IDs selected for another worker's cleanup", async () => {
      await seedQuarantine();
      const beforeReconcile = barrier();
      const beforeCommit = barrier();
      const deleting = barrier();
      const remove = state.vector!.deleteByChunkIds.bind(state.vector);
      vi.spyOn(state.vector!, "deleteByChunkIds").mockImplementationOnce(async (...args) => {
        await beforeReconcile.pause();
        return remove(...args);
      });
      const a = approveDocument("ordinary", { id: "actor" }).catch((error: unknown) => error);
      await beforeReconcile.entered;
      const sparse = getBM25Index();
      const upsert = sparse.upsertDocumentChunks.bind(sparse);
      let candidateIds: string[] = [];
      vi.spyOn(sparse, "upsertDocumentChunks").mockImplementationOnce(async (...args) => {
        await upsert(...args);
        candidateIds = args[3].map((row) => row.id);
        await beforeCommit.pause();
      });
      const service = new KnowledgeService({
        storage: { read: async () => Buffer.from("bravo") } as never,
        embedder: deps.embedder,
        vectorStore: state.vector!,
        bm25: sparse,
      });
      const b = service.ingestDocument("ordinary");
      await beforeCommit.entered;
      // Pause A exactly after its cleanup decision, before the external delete.
      vi.spyOn(state.vector!, "deleteByChunkIds").mockImplementationOnce(async (...args) => {
        await deleting.pause();
        return remove(...args);
      });
      beforeReconcile.release();
      await deleting.entered;
      beforeCommit.release();
      const result = await b;
      deleting.release();
      await a;
      // A cleanup may revoke B (then B must fail closed), or leave it active. It
      // must NEVER report ready with SQL selecting externally deleted IDs.
      if (result.status === "ready") {
        expect((await db.knowledgeChunk.findMany()).map((row) => row.id)).toEqual(candidateIds);
        await assertLive("bravo");
      } else {
        expect(await db.knowledgeChunk.count()).toBe(0);
        expect(
          (await db.document.findUniqueOrThrow({ where: { id: "ordinary" } })).indexState,
        ).not.toBe("indexed");
        await service.ingestDocument("ordinary");
        await assertLive("bravo");
      }
      __resetBM25IndexSingleton();
      await assertLive("bravo");
    });

    it("a later ordinary winner survives cleanup IO and status completion from the prior generation", async () => {
      await seedQuarantine();
      const cleaning = barrier();
      const remove = state.vector!.deleteByChunkIds.bind(state.vector);
      let calls = 0;
      vi.spyOn(state.vector!, "deleteByChunkIds").mockImplementation(async (...args) => {
        if (++calls === 2) await cleaning.pause();
        return remove(...args);
      });
      const old = approveDocument("ordinary", { id: "actor" });
      await cleaning.entered;
      const pending = await request(approvalApp())
        .get("/projects/project/documents/ordinary")
        .set("Authorization", authorization("developer", ["workspace"]));
      expect(pending.status).toBe(200);
      expect(pending.body.data).toMatchObject({
        indexState: "reconciling",
        status: "processing",
        chunkCount: 1,
      });
      const service = new KnowledgeService({
        storage: { read: async () => Buffer.from("bravo") } as never,
        embedder: deps.embedder,
        vectorStore: state.vector!,
        bm25: getBM25Index(),
      });
      try {
        expect(await service.ingestDocument("ordinary")).toMatchObject({ status: "ready" });
      } finally {
        cleaning.release();
      }
      await old;
      await assertLive("bravo");
      expect(await state.vector!.count("project")).toBe(1);
      __resetBM25IndexSingleton();
      await assertLive("bravo");
    });

    it("an indexed replay's sparse snapshot failure restores failed reconciliation status", async () => {
      await seedQuarantine();
      await approveDocument("ordinary", { id: "actor" });
      vi.spyOn(getBM25Index(), "documentChunkIds").mockRejectedValueOnce(
        new Error("snapshot unavailable"),
      );
      await expect(approveDocument("ordinary", { id: "actor" })).rejects.toThrow(
        "snapshot unavailable",
      );
      expect(await db.document.findFirst()).toMatchObject({
        indexState: "reconciling",
        status: "failed",
        errorMessage: "snapshot unavailable",
      });
      await approveDocument("ordinary", { id: "actor" });
      await assertLive("alpha");
    });

    it("a committed SQL selection survives a lost transaction acknowledgement", async () => {
      const transaction = db.$transaction.bind(db);
      let calls = 0;
      vi.spyOn(db, "$transaction").mockImplementation((async (arg: unknown, options: unknown) => {
        const finalizing = ++calls === 3;
        const result = await transaction(arg as never, options as never);
        if (finalizing) throw new Error("commit acknowledgement lost");
        return result;
      }) as typeof db.$transaction);
      await expect(publishGeneratedDocRevision(payload(1), deps)).rejects.toThrow(
        "commit acknowledgement lost",
      );
      expect(await db.knowledgeChunk.count()).toBe(1);
      expect(await db.document.findFirst()).toMatchObject({
        indexState: "reconciling",
        status: "failed",
      });
      await publishGeneratedDocRevision(payload(1), deps);
      await assertLive("alpha");
    });

    it.each(["vector", "bm25"])(
      "loser compensation paused at %s cannot remove a selected winner",
      async (boundary) => {
        const writing = barrier();
        const cleaning = barrier();
        const upsert = state.vector!.upsert.bind(state.vector);
        vi.spyOn(state.vector!, "upsert").mockImplementationOnce(async (...args) => {
          await writing.pause();
          return upsert(...args);
        });
        const stale = publishGeneratedDocRevision(payload(1), deps).catch(
          (error: unknown) => error,
        );
        await writing.entered;
        await publishGeneratedDocRevision(payload(1), deps);
        if (boundary === "vector") {
          const remove = state.vector!.deleteByChunkIds.bind(state.vector);
          vi.spyOn(state.vector!, "deleteByChunkIds").mockImplementationOnce(async (...args) => {
            await cleaning.pause();
            return remove(...args);
          });
        } else {
          const remove = getBM25Index().removeChunkIds.bind(getBM25Index());
          vi.spyOn(getBM25Index(), "removeChunkIds").mockImplementationOnce(async (...args) => {
            await cleaning.pause();
            return remove(...args);
          });
        }
        writing.release();
        await cleaning.entered;
        await publishGeneratedDocRevision(payload(1), deps);
        await assertLive("alpha");
        cleaning.release();
        expect(await stale).toBeInstanceOf(Error);
        await assertLive("alpha");
        expect(await state.vector!.count("project")).toBe(1);
      },
    );

    it.each(["warm", "cold"])(
      "%s replay removes a crashed loser's journaled external writes",
      async (temperature) => {
        const gate = barrier();
        const upsert = state.vector!.upsert.bind(state.vector);
        let staleIds: string[] = [];
        vi.spyOn(state.vector!, "upsert").mockImplementationOnce(async (...args) => {
          staleIds = args[1].map((row) => row.id);
          await gate.pause();
          return upsert(...args);
        });
        const stale = publishGeneratedDocRevision(payload(1), deps).catch(
          (error: unknown) => error,
        );
        await gate.entered;
        await publishGeneratedDocRevision(payload(1), deps);
        const remove = state.vector!.deleteByChunkIds.bind(state.vector);
        vi.spyOn(state.vector!, "deleteByChunkIds").mockImplementationOnce(async () => {
          throw new Error("crash during compensation");
        });
        gate.release();
        expect(await stale).toBeInstanceOf(Error);
        expect(await state.vector!.count("project")).toBe(2);
        expect(await db.knowledgeChunk.count()).toBe(1);
        if (temperature === "cold") {
          __resetBM25IndexSingleton();
          state.vector = new LocalVectorStore({ root: join(directory, "vectors") });
        } else {
          vi.spyOn(state.vector!, "deleteByChunkIds").mockImplementation(remove);
        }
        await publishGeneratedDocRevision(payload(1), deps);
        await assertLive("alpha");
        expect(await state.vector!.count("project")).toBe(1);
        expect((await db.knowledgeChunk.findMany()).map((row) => row.id)).not.toContain(
          staleIds[0],
        );
      },
    );

    it.each(["vector", "bm25"])(
      "abort at %s waits for mutation settlement and retry converges",
      async (boundary) => {
        const controller = new AbortController();
        if (boundary === "vector") {
          const upsert = state.vector!.upsert.bind(state.vector);
          vi.spyOn(state.vector!, "upsert").mockImplementationOnce(async (...args) => {
            await upsert(...args);
            controller.abort(new Error("timeout"));
          });
        } else {
          const upsert = getBM25Index().upsertDocumentChunks.bind(getBM25Index());
          vi.spyOn(getBM25Index(), "upsertDocumentChunks").mockImplementationOnce(
            async (...args) => {
              await upsert(...args);
              controller.abort(new Error("timeout"));
            },
          );
        }
        await expect(
          publishGeneratedDocRevision(payload(1), { ...deps, signal: controller.signal }),
        ).rejects.toThrow("timeout");
        expect(await db.knowledgeChunk.count()).toBe(0);
        expect(await state.vector!.count("project")).toBe(0);
        await publishGeneratedDocRevision(payload(1), deps);
        await assertLive("alpha");
      },
    );

    it.each(["warm", "cold"])(
      "publication retries actual approval after %s sparse failure",
      async (temperature) => {
        if (temperature === "warm") await getBM25Index().ensureProject("project");
        vi.spyOn(MiniSearch.prototype, "addAll").mockImplementationOnce(() => {
          throw new Error("publish sparse failure");
        });
        await expect(publishGeneratedDocRevision(payload(1), deps)).rejects.toThrow(
          "publish sparse failure",
        );
        expect(await db.quarantineChunk.count({ where: { ord: { gte: 0 } } })).toBe(1);
        expect(await db.document.count({ where: { indexState: "indexed" } })).toBe(0);
        __resetBM25IndexSingleton();
        await publishGeneratedDocRevision(payload(1), deps);
        await assertLive("alpha");
      },
    );

    it.each(["warm", "cold"])(
      "partial %s add failure can retry without resetting the sparse singleton",
      async (temperature) => {
        await seedQuarantine();
        if (temperature === "warm") await getBM25Index().ensureProject("project");
        const add = MiniSearch.prototype.add;
        vi.spyOn(MiniSearch.prototype, "add").mockImplementationOnce(function (
          this: MiniSearch,
          doc,
        ) {
          add.call(this, doc);
          throw new Error("partial add");
        });
        await expect(approveDocument("ordinary", { id: "actor" })).rejects.toThrow("partial add");
        await expect(approveDocument("ordinary", { id: "actor" })).resolves.toEqual({
          chunkCount: 1,
        });
        const hits = await getBM25Index().search("project", "alpha", 20);
        expect(hits).toHaveLength(1);
        await assertLive("alpha");
      },
    );

    it("cleanup waits for an in-flight cold load's old SQL snapshot", async () => {
      await publishGeneratedDocRevision(payload(1), deps);
      __resetBM25IndexSingleton();
      const gate = barrier();
      const find = db.knowledgeChunk.findMany.bind(db.knowledgeChunk);
      vi.spyOn(db.knowledgeChunk, "findMany").mockImplementationOnce(async (args) => {
        const rows = await find(args);
        await gate.pause();
        return rows;
      });
      const loading = getBM25Index().ensureProject("project");
      await gate.entered;
      await db.$executeRaw`UPDATE generated_documents SET deletedAt = CURRENT_TIMESTAMP WHERE id = 'doc'`;
      const removing = barrier();
      const remove = getBM25Index().removeDocument.bind(getBM25Index());
      vi.spyOn(getBM25Index(), "removeDocument").mockImplementationOnce(async (...args) => {
        const result = remove(...args);
        await removing.pause();
        return result;
      });
      const cleanup = publishGeneratedDocRevision(payload(1), deps);
      await removing.entered;
      removing.release();
      gate.release();
      await Promise.all([loading, cleanup]);
      expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
    });

    it("empty publication propagates sparse failure and succeeds after a cold restart", async () => {
      await version(2, "");
      // Empty publication can still have leftovers from an interrupted earlier attempt.
      await getBM25Index().upsertDocumentChunks(
        "project",
        `gendoc-doc:${payload(2).revisionId}`,
        "doc.md",
        [{ id: "leftover", position: 0, text: "alpha" }],
      );
      vi.spyOn(MiniSearch.prototype, "discard").mockImplementationOnce(() => {
        throw new Error("empty publication sparse failure");
      });
      await expect(publishGeneratedDocRevision(payload(2), deps)).rejects.toThrow(
        "empty publication sparse failure",
      );
      // The empty SQL selection committed; retry must finish external cleanup,
      // not reset that selection to a second mutable publication attempt.
      expect(await db.knowledgeChunk.count()).toBe(0);
      expect(await db.document.findFirst()).toMatchObject({
        indexState: "reconciling",
        status: "failed",
        errorMessage: "empty publication sparse failure",
      });
      __resetBM25IndexSingleton();
      await expect(publishGeneratedDocRevision(payload(2), deps)).resolves.toMatchObject({
        status: "published",
        chunkCount: 0,
      });
      expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
    });

    it.each(["warm", "cold"])(
      "real route keeps quarantine after %s MiniSearch failure and retries successfully",
      async (temperature) => {
        await seedQuarantine();
        if (temperature === "warm") await getBM25Index().ensureProject("project");
        const app = approvalApp();
        const token = authorization("developer", ["workspace"]);
        vi.spyOn(MiniSearch.prototype, "addAll").mockImplementationOnce(() => {
          throw new Error("sparse unavailable");
        });
        const failed = await request(app)
          .post("/projects/project/documents/ordinary/approve")
          .set("Authorization", token);
        expect(failed.status).toBe(409);
        expect(await db.quarantineChunk.count({ where: { ord: { gte: 0 } } })).toBe(1);
        expect(
          (await db.document.findUniqueOrThrow({ where: { id: "ordinary" } })).indexState,
        ).toBe("quarantined");
        // Simulated restart: SQL quarantine and disk vectors survive; sparse singleton does not.
        __resetBM25IndexSingleton();
        state.vector = new LocalVectorStore({ root: join(directory, "vectors") });
        expect(
          (
            await request(app)
              .post("/projects/project/documents/ordinary/approve")
              .set("Authorization", token)
          ).status,
        ).toBe(200);
        await assertLive("alpha");
        expect(await db.quarantineChunk.count({ where: { ord: { gte: 0 } } })).toBe(0);
      },
    );

    it("publication cleanup retries a real MiniSearch discard failure", async () => {
      await publishGeneratedDocRevision(payload(1), deps);
      await db.$executeRaw`UPDATE generated_documents SET deletedAt = CURRENT_TIMESTAMP WHERE id = 'doc'`;
      vi.spyOn(MiniSearch.prototype, "discard").mockImplementationOnce(() => {
        throw new Error("sparse discard failed");
      });
      await expect(publishGeneratedDocRevision(payload(1), deps)).rejects.toThrow(
        "sparse discard failed",
      );
      await expect(publishGeneratedDocRevision(payload(1), deps)).resolves.toMatchObject({
        status: "skipped",
        reason: "deleted",
      });
      expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
      expect(await db.knowledgeChunk.count()).toBe(0);
    });

    it("lists live project quarantine and generated or ordinary cleanup attempts", async () => {
      await seedQuarantine();
      const ordinary = await db.document.findUniqueOrThrow({ where: { id: "ordinary" } });
      for (const [id, overrides] of [
        ["manual", {}],
        [`gendoc-doc:${payload(1).revisionId}`, {}],
        ["gendoc-legacy", {}],
        ["deleted", { deletedAt: new Date() }],
        ["other-project", { projectId: "other" }],
        ["indexed", { indexState: "indexed" }],
        ["rejected", { indexState: "rejected" }],
        ["pending", { indexState: "pending" }],
        ["no-winner", {}],
      ] as const) {
        await db.document.create({
          data: {
            ...ordinary,
            id,
            indexState: "reconciling",
            status: "failed",
            errorMessage: "cleanup failed",
            ...overrides,
          },
        });
        await db.quarantineChunk.create({
          data: {
            id: `attempt-${id}`,
            documentId: id,
            projectId: id === "other-project" ? "other" : "project",
            ord: id === "no-winner" ? -1 : -3,
            text: "",
            embedding: "[]",
          },
        });
      }
      const rows = await listQuarantine("project");
      expect(rows.map((row) => row.documentId).sort()).toEqual([
        `gendoc-doc:${payload(1).revisionId}`,
        "gendoc-legacy",
        "manual",
        "ordinary",
      ]);
      expect(rows.find((row) => row.documentId === "manual")).toMatchObject({
        indexState: "reconciling",
        errorMessage: "cleanup failed",
      });
    });

    it("empty quarantine must remove stale sparse entries and propagate failure", async () => {
      await seedQuarantine(false);
      await getBM25Index().upsertDocumentChunks("project", "ordinary", "ordinary.md", [
        { id: "old", position: 0, text: "alpha" },
      ]);
      vi.spyOn(MiniSearch.prototype, "discard").mockImplementationOnce(() => {
        throw new Error("empty discard failed");
      });
      await expect(approveDocument("ordinary", { id: "actor" })).rejects.toThrow(
        "empty discard failed",
      );
      expect(await db.document.findFirst()).toMatchObject({
        indexState: "reconciling",
        status: "failed",
        errorMessage: "empty discard failed",
      });
      // A fresh list after a cold reload must still expose the manual retry.
      __resetBM25IndexSingleton();
      state.vector = new LocalVectorStore({ root: join(directory, "vectors") });
      expect(await listQuarantine("project")).toEqual([
        expect.objectContaining({
          documentId: "ordinary",
          indexState: "reconciling",
          errorMessage: "empty discard failed",
        }),
      ]);
      await expect(approveDocument("ordinary", { id: "actor" })).resolves.toEqual({
        chunkCount: 0,
      });
      expect(await getBM25Index().search("project", "alpha", 20)).toEqual([]);
      expect(await listQuarantine("project")).toEqual([]);
    });
  });
});
