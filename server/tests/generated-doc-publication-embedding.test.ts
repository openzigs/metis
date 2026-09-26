/**
 * Issue #189 — generated-document RAG ingest: bounded chunks, bounded embed
 * batches off the main thread, a recorded outcome, and startup repair of rows
 * that no task will ever finish.
 *
 * Real SQLite (same shape as `generated-doc-publication-ownership.test.ts`), a
 * file-backed vector store and MiniSearch; only auth setup is substituted.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPermissionsForRole } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import { probeHealthzDuring } from "./helpers/healthz-prober.js";
import type { LocalVectorStore as LocalStore } from "../src/lib/rag/vector-store.js";

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
import { __resetBM25IndexSingleton } from "../src/lib/rag/bm25-index.js";
import { XenovaEmbedder } from "../src/lib/rag/embedder.js";
import {
  CHUNK_SIZE,
  DOCSGEN_CHUNKER_IDENTITY,
  GENERATED_DOC_EVIDENCE_CLASS,
  PUBLICATION_EMBED_BATCH_SIZE,
  chunkGeneratedMarkdown,
  enqueueGeneratedDocPublication,
  publishGeneratedDocRevision,
  settleCancelledGeneratedDocPublication,
  splitOversized,
} from "../src/lib/docs-gen/generated-doc-publication.js";
import { TaskQueue } from "../src/lib/scheduler/task-queue.js";
import { createPrismaTaskStore } from "../src/lib/scheduler/task-store.js";
import {
  InMemoryTaskHandlerRegistry,
  registerBuiltInHandlers,
} from "../src/lib/scheduler/task-handlers.js";
import type { TaskRecord } from "../src/lib/scheduler/types.js";
import {
  parseSyntheticDocumentId,
  reconcileStrandedGeneratedDocPublications,
} from "../src/lib/docs-gen/generated-doc-publication-recovery.js";
import { generatedDocOutboxId } from "../src/lib/docs-gen/generated-doc-outbox.js";
import { approveDocument, listQuarantine } from "../src/lib/rag/quarantine.js";
import {
  createEvidencePolicy,
  resolveEvidencePolicy,
} from "../src/lib/docs-gen/evidence-policy.js";
import { filterPrimaryEvidence } from "../src/lib/docs-gen/evidence-filter.js";
import { generatedDocRevisionId } from "../src/lib/docs-gen/generated-doc-provenance.js";
import { TaskAbortError, type TaskAbortSource } from "../src/lib/scheduler/task-abort.js";
import {
  EMBED_INPUT_MAX_BYTES,
  MAX_EMBED_SEQUENCE_TOKENS,
} from "../src/lib/rag/embed-input-budget.js";

const FIXTURE_URL = new URL("./fixtures/busy-transformers.mjs", import.meta.url).href;

/** A paragraph with no blank line in it — the shape v1 emitted as ONE chunk. */
function hugeTable(chars: number): string {
  const rows: string[] = ["| column a | column b |", "| --- | --- |"];
  let i = 0;
  while (rows.join("\n").length < chars) rows.push(`| row ${i} value | ${"x".repeat(40)} ${i++} |`);
  return rows.join("\n");
}

/** A ~`chars`-character generated document: prose sections plus one huge table. */
function largeDocument(chars: number, opts: { longRowMarker?: boolean } = {}): string {
  const parts = ["# Generated documentation", "## Data model", hugeTable(51_081)];
  if (opts.longRowMarker)
    parts.push("## Hot path", "__long__ this chunk stands for one 8,192-token row");
  let n = 0;
  while (parts.join("\n\n").length < chars) {
    parts.push(`## Section ${n}`);
    for (let p = 0; p < 4; p += 1) {
      parts.push(`Paragraph ${n}.${p} ${"lorem ipsum dolor sit amet ".repeat(12)}`);
    }
    n += 1;
  }
  return parts.join("\n\n");
}

describe("chunkGeneratedMarkdown (#189)", () => {
  it("never emits a chunk longer than CHUNK_SIZE, even for a 51,081-character paragraph", () => {
    const markdown = largeDocument(120_000);
    const chunks = chunkGeneratedMarkdown(markdown);
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(CHUNK_SIZE);
    // Nothing is dropped: every non-whitespace character survives, in order.
    expect(
      chunks
        .map((c) => c.text)
        .join("")
        .replace(/\s+/g, ""),
    ).toBe(markdown.replace(/\s+/g, ""));
    const table = chunks.filter((c) => c.heading === "Data model");
    expect(table.length).toBeGreaterThan(30);
    // Split on row boundaries: after the heading chunk, every piece starts a row.
    expect(table.slice(1).every((c) => c.text.startsWith("|"))).toBe(true);
  });

  it("keeps ordinary sections byte-identical to the v1 chunker", () => {
    const markdown = "## One\n\nshort body\n\n## Two\n\n" + "para\n\n".repeat(3);
    expect(chunkGeneratedMarkdown(markdown).map((c) => c.text)).toEqual([
      "## One\n\nshort body",
      "## Two\n\npara\n\npara\n\npara",
    ]);
    expect(chunkGeneratedMarkdown("   ")).toEqual([]);
    expect(DOCSGEN_CHUNKER_IDENTITY).toBe("docsgen:v3:1500");
  });

  it("splits a single over-long line without cutting a surrogate pair", () => {
    const line = "a".repeat(9) + "😀" + "b".repeat(10);
    const pieces = splitOversized(line, 10);
    expect(pieces.every((p) => p.length <= 10)).toBe(true);
    expect(pieces.join("")).toBe(line);
    expect(pieces[0]).toBe("a".repeat(9));
    expect(splitOversized("x\ny", 10)).toEqual(["x\ny"]);
    expect(splitOversized("aaaa\nbbbb\ncccc", 9)).toEqual(["aaaa\nbbbb", "cccc"]);
  });
});

describe.runIf(readGeneratedClientProvider() === "sqlite")(
  "generated-doc publication (#189)",
  () => {
    let db: PrismaClient;
    let directory: string;
    const payload = (version = 1, projectId = "project", generatedDocumentId = "doc") => ({
      projectId,
      generatedDocumentId,
      version,
      revisionId: generatedDocRevisionId({ projectId, generatedDocumentId, version }),
    });
    const syntheticId = (p = payload()) => `gendoc-${p.generatedDocumentId}:${p.revisionId}`;
    const storage = {
      write: async () => ({ storagePath: "doc.md", checksum: "hash", sizeBytes: 20 }),
    } as never;
    const servers: Server[] = [];
    const embedders: XenovaEmbedder[] = [];

    function recordingEmbedder(fail?: Error) {
      const calls: string[][] = [];
      return {
        calls,
        embedder: {
          embed: async (texts: string[]) => {
            calls.push(texts);
            if (fail) throw fail;
            return {
              model: "test",
              identity: "test",
              dimension: 2,
              vectors: texts.map(() => [1, 0]),
            };
          },
        } as never,
      };
    }

    async function version(n: number, content: string, generatedDocumentId = "doc") {
      await db.generatedDocumentVersion.create({
        data: {
          documentId: generatedDocumentId,
          version: n,
          revisionId: payload(n, "project", generatedDocumentId).revisionId,
          content,
        },
      });
    }

    async function autoApprove(on: boolean) {
      await db.$executeRawUnsafe(
        `UPDATE projects SET autoApproveTrustedSources = ${on ? "true" : "false"} WHERE id = 'project'`,
      );
    }

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "metis-publication-embedding-"));
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: `file:${join(directory, "db.sqlite")}` }),
      });
      state.db = db;
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
      scopeFilter TEXT, evidencePolicy TEXT, status TEXT DEFAULT 'ready', deletedAt DATETIME,
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
        `CREATE TABLE tasks (id TEXT PRIMARY KEY, scheduledJobId TEXT, projectId TEXT, type TEXT NOT NULL,
      trigger TEXT DEFAULT 'manual', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 5,
      payload TEXT DEFAULT '{}', result TEXT, errorMessage TEXT, progress INTEGER,
      attempts INTEGER DEFAULT 0, maxAttempts INTEGER DEFAULT 3, scheduledFor DATETIME,
      startedAt DATETIME, completedAt DATETIME, createdById TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      ];
      for (const sql of tables) await db.$executeRawUnsafe(sql);
    });

    afterAll(async () => {
      await db?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.all(embedders.splice(0).map((e) => e.close()));
      await Promise.all(
        servers
          .splice(0)
          .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    });

    beforeEach(async () => {
      for (const table of [
        "tasks",
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
      const policy = createEvidencePolicy({
        userId: "initiator",
        username: "initiator",
        role: "coordinator",
        permissions: getPermissionsForRole("coordinator"),
      });
      for (const [id, status, scope] of [
        ["doc", "degraded", "module"],
        ["doc2", "ready", "full"],
        ["doc3", "ready", "full"],
        ["doc4", "ready", "full"],
      ]) {
        await db.$executeRaw`INSERT INTO generated_documents (id,projectId,title,scope,scopeFilter,evidencePolicy,status)
      VALUES (${id},'project','Example',${scope},'{}',${policy},${status})`;
      }
      await db.$executeRaw`INSERT INTO users (id,username,displayName,email) VALUES
      ('initiator','initiator','Initiator','initiator@example.test')`;
      await db.$executeRaw`INSERT INTO roles (id,key,name) VALUES ('coordinator','coordinator','Coordinator')`;
      await db.$executeRaw`INSERT INTO user_roles (userId,roleId) VALUES ('initiator','coordinator')`;
      await db.$executeRaw`INSERT INTO workspace_members (id,workspaceId,userId) VALUES
      ('initiator-membership','workspace','initiator')`;
      state.vector = new LocalVectorStore({ root: join(directory, "vectors") });
      await state.vector.dropTable("project");
      __resetBM25IndexSingleton();
    });

    describe("publishGeneratedDocRevision", () => {
      it("embeds a 600k-character document in bounded batches of bounded chunks, with progress", async () => {
        await version(1, largeDocument(600_000));
        await autoApprove(false);
        const { calls, embedder } = recordingEmbedder();
        const progress: Array<{ current: number; total: number }> = [];
        const result = await publishGeneratedDocRevision(payload(), {
          storage,
          embedder,
          onProgress: (p) => progress.push({ current: p.current, total: p.total }),
        });

        const total = calls.flat().length;
        expect(result).toMatchObject({ status: "published", chunkCount: total });
        expect(total).toBeGreaterThan(400);
        // Never the whole document in one call.
        expect(calls.length).toBe(Math.ceil(total / PUBLICATION_EMBED_BATCH_SIZE));
        expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(
          PUBLICATION_EMBED_BATCH_SIZE,
        );
        expect(Math.max(...calls.flat().map((t) => t.length))).toBeLessThanOrEqual(CHUNK_SIZE);
        expect(progress.at(-1)).toEqual({ current: total, total });
        expect(progress.map((p) => p.current)).toEqual(
          [...progress.map((p) => p.current)].sort((a, b) => a - b),
        );
      });

      it("finishes a not-auto-approved publication as ready (awaiting review), never processing", async () => {
        await version(1, largeDocument(5_000));
        await autoApprove(false);
        await publishGeneratedDocRevision(payload(), { storage, ...recordingEmbedder() });
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          {
            status: "ready",
            indexState: "quarantined",
            errorMessage: null,
          },
        );
      });

      it("labels every chunk as derived, with the generated document's status and scope", async () => {
        await version(1, largeDocument(5_000));
        await autoApprove(false);
        await publishGeneratedDocRevision(payload(), { storage, ...recordingEmbedder() });
        const parked = await db.quarantineChunk.findMany({
          where: { documentId: syntheticId(), ord: { gte: 0 } },
        });
        expect(parked.length).toBeGreaterThan(1);
        for (const chunk of parked) {
          expect(JSON.parse(chunk.metadata)).toMatchObject({
            source: "generated-doc",
            evidenceClass: GENERATED_DOC_EVIDENCE_CLASS,
            generatedDocumentStatus: "degraded",
            generatedDocumentScope: "module",
          });
        }
      });

      it("an indexed generated doc is never primary evidence for the next generation", async () => {
        await version(1, "## Facts\n\nThe billing service owns invoices.");
        await autoApprove(true);
        await publishGeneratedDocRevision(payload(), { storage, ...recordingEmbedder() });
        const generated = await db.knowledgeChunk.findMany({
          where: { documentId: syntheticId() },
        });
        expect(generated).toHaveLength(1);
        expect(generated[0].chunkerIdentity).toBe(DOCSGEN_CHUNKER_IDENTITY);
        // A control chunk from an ordinary document the same policy DOES accept.
        await db.document.create({
          data: {
            id: "reference",
            projectId: "project",
            filename: "reference.md",
            mimeType: "text/markdown",
            sizeBytes: 5,
            storagePath: "reference.md",
            checksum: "hash",
            status: "ready",
            indexState: "indexed",
            uploadedById: "initiator",
          },
        });
        await db.knowledgeChunk.create({
          data: {
            id: "reference-0",
            projectId: "project",
            documentId: "reference",
            position: 0,
            text: "The billing service owns invoices.",
            md5: "hash",
            embeddingModel: "test",
            metadata: "{}",
          },
        });
        const doc2 = await db.generatedDocument.findUniqueOrThrow({
          where: { id: "doc2" },
          select: {
            id: true,
            projectId: true,
            scope: true,
            scopeFilter: true,
            evidencePolicy: true,
          },
        });
        const policy = await resolveEvidencePolicy(doc2);
        const candidates = [...generated, { id: "reference-0", documentId: "reference" }].map(
          (row) => ({ chunkId: row.id, documentId: row.documentId, filename: "f", text: "t" }),
        );
        const allowed = await filterPrimaryEvidence(candidates, policy);
        expect(allowed.map((c) => c.chunkId)).toEqual(["reference-0"]);
      });

      it("records a failed attempt, and marks the document failed only on the final attempt", async () => {
        await version(1, largeDocument(5_000));
        await expect(
          publishGeneratedDocRevision(payload(), {
            storage,
            ...recordingEmbedder(new Error("model unavailable")),
          }),
        ).rejects.toThrow("model unavailable");
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          {
            status: "processing",
            errorMessage: "generated-doc publication failed: model unavailable",
          },
        );
        await expect(
          publishGeneratedDocRevision(payload(), {
            storage,
            finalAttempt: true,
            ...recordingEmbedder(new Error("model unavailable")),
          }),
        ).rejects.toThrow("model unavailable");
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          {
            status: "failed",
            errorMessage: "generated-doc publication failed: model unavailable",
          },
        );
      });

      it("an aborted publication stops between batches and records nothing", async () => {
        await version(1, largeDocument(60_000));
        const controller = new AbortController();
        const { calls, embedder } = recordingEmbedder();
        const aborting = {
          embed: async (texts: string[]) => {
            const out = await (embedder as { embed(t: string[]): Promise<unknown> }).embed(texts);
            controller.abort(new Error("shutdown"));
            return out;
          },
        } as never;
        await expect(
          publishGeneratedDocRevision(payload(), {
            storage,
            embedder: aborting,
            signal: controller.signal,
            finalAttempt: true,
          }),
        ).rejects.toThrow("shutdown");
        expect(calls).toHaveLength(1);
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          {
            status: "processing",
            errorMessage: null,
          },
        );
      });

      /** An embedder whose first batch triggers `abort(reason)` on `controller`. */
      function abortingAfterFirstBatch(controller: AbortController, reason: unknown) {
        const inner = recordingEmbedder();
        return {
          calls: inner.calls,
          embedder: {
            embed: async (texts: string[]) => {
              const out = await (inner.embedder as { embed(t: string[]): Promise<unknown> }).embed(
                texts,
              );
              controller.abort(reason);
              return out;
            },
          } as never,
        };
      }

      async function publishAborted(
        source: TaskAbortSource,
        message: string,
        finalAttempt: boolean,
      ) {
        const controller = new AbortController();
        const { calls, embedder } = abortingAfterFirstBatch(
          controller,
          new TaskAbortError(source, message),
        );
        await expect(
          publishGeneratedDocRevision(payload(), {
            storage,
            embedder,
            signal: controller.signal,
            finalAttempt,
          }),
        ).rejects.toThrow(message);
        expect(calls).toHaveLength(1);
        return db.document.findUniqueOrThrow({ where: { id: syntheticId() } });
      }

      it("#201 — a user's cancellation is terminal and says so, even before the last attempt", async () => {
        await version(1, largeDocument(60_000));
        expect(await publishAborted("user", "cancelled by user", false)).toMatchObject({
          status: "failed",
          errorMessage: "generated-doc publication cancelled: cancelled by user",
        });
      });

      it("#201 — a timeout on the final attempt marks the document failed with the timeout", async () => {
        await version(1, largeDocument(60_000));
        const row = await publishAborted("timeout", "task timeout after 600000ms", true);
        expect(row).toMatchObject({
          status: "failed",
          errorMessage: "generated-doc publication failed: task timeout after 600000ms",
        });
        expect(row.processedAt).not.toBeNull();
      });

      it("#201 — a timeout before the final attempt records the reason and stays processing", async () => {
        await version(1, largeDocument(60_000));
        expect(await publishAborted("timeout", "task timeout after 600000ms", false)).toMatchObject(
          {
            status: "processing",
            errorMessage: "generated-doc publication failed: task timeout after 600000ms",
          },
        );
      });

      it("#201 — a scheduler shutdown records nothing: the outbox replays it", async () => {
        await version(1, largeDocument(60_000));
        expect(await publishAborted("shutdown", "scheduler shutdown", true)).toMatchObject({
          status: "processing",
          errorMessage: null,
        });
      });

      it("#201 — a cancellation that lands before the first write settles the queued placeholder", async () => {
        await version(1, largeDocument(5_000));
        await db.document.create({
          data: {
            id: syntheticId(),
            projectId: "project",
            filename: "generated-doc-doc.md",
            mimeType: "text/markdown",
            sizeBytes: 5,
            storagePath: "doc.md",
            checksum: "hash",
            status: "pending",
            uploadedById: "initiator",
          },
        });
        const controller = new AbortController();
        controller.abort(new TaskAbortError("user", "cancelled by user"));
        const { calls, embedder } = recordingEmbedder();
        await expect(
          publishGeneratedDocRevision(payload(), { storage, embedder, signal: controller.signal }),
        ).rejects.toThrow("cancelled by user");
        expect(calls).toHaveLength(0);
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          {
            status: "failed",
            errorMessage: "generated-doc publication cancelled: cancelled by user",
          },
        );
      });

      it("#201 — a failure outside the embed step is recorded too, even when not an Error", async () => {
        await version(1, largeDocument(5_000));
        await db.document.create({
          data: {
            id: syntheticId(),
            projectId: "project",
            filename: "generated-doc-doc.md",
            mimeType: "text/markdown",
            sizeBytes: 5,
            storagePath: "doc.md",
            checksum: "hash",
            status: "pending",
            uploadedById: "initiator",
          },
        });
        const failingStorage = {
          write: async () => {
            throw "storage offline";
          },
        } as never;
        const { calls, embedder } = recordingEmbedder();
        await expect(
          publishGeneratedDocRevision(payload(), {
            storage: failingStorage,
            embedder,
            finalAttempt: true,
          }),
        ).rejects.toBe("storage offline");
        expect(calls).toHaveLength(0);
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          {
            status: "failed",
            errorMessage: "generated-doc publication failed: storage offline",
          },
        );
      });

      it("#201 — a row that already has an outcome keeps it when a later step fails", async () => {
        await version(1, largeDocument(5_000));
        await db.document.create({
          data: {
            id: syntheticId(),
            projectId: "project",
            filename: "generated-doc-doc.md",
            mimeType: "text/markdown",
            sizeBytes: 5,
            storagePath: "doc.md",
            checksum: "hash",
            status: "ready",
            indexState: "quarantined",
            uploadedById: "initiator",
          },
        });
        await expect(
          publishGeneratedDocRevision(payload(), {
            storage,
            finalAttempt: true,
            ...recordingEmbedder(new Error("model unavailable")),
          }),
        ).rejects.toThrow("model unavailable");
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          { status: "ready", errorMessage: null },
        );
      });

      it("#201 — CJK and emoji sections are embedded whole: every chunk fits the token budget", async () => {
        const cjk = "検索拡張生成は文書の内容を理解するための仕組みです。".repeat(120);
        const emoji = "😀🚀🎉🧪".repeat(500);
        const markdown = `## 日本語\n\n${cjk}\n\n## Emoji\n\n${emoji}\n\n## English\n\nplain text`;
        await version(1, markdown);
        await autoApprove(false);
        const { calls, embedder } = recordingEmbedder();
        await publishGeneratedDocRevision(payload(), { storage, embedder });
        const texts = calls.flat();
        for (const text of texts) {
          expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(EMBED_INPUT_MAX_BYTES);
        }
        expect(EMBED_INPUT_MAX_BYTES).toBeLessThan(MAX_EMBED_SEQUENCE_TOKENS);
        // Nothing dropped, in order.
        expect(texts.join("").replace(/\s+/g, "")).toBe(markdown.replace(/\s+/g, ""));
        // An emoji is never split across two chunks.
        expect(texts.some((t) => /[\ud800-\udbff]$/.test(t))).toBe(false);
      });

      it("/healthz answers within 1 s while a 600k-character document is published", async () => {
        await version(1, largeDocument(600_000, { longRowMarker: true }));
        await autoApprove(false);
        const server = createServer((req, res) =>
          res.writeHead(req.url === "/healthz" ? 200 : 404).end("ok"),
        );
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`;
        // The production in-process backend, in its default (worker) runtime, over a
        // model stand-in that blocks its thread per row and for 1.5 s on the long row.
        const embedder = new XenovaEmbedder("acme/busy-model@2ms", 4, {
          pooling: "cls",
          runtime: "worker",
          workerModuleUrl: FIXTURE_URL,
        });
        embedders.push(embedder);
        await embedder.warm();
        let result: Awaited<ReturnType<typeof publishGeneratedDocRevision>> | undefined;
        const report = await probeHealthzDuring(url, async () => {
          result = await publishGeneratedDocRevision(payload(), {
            storage,
            embedder: embedder as never,
          });
        });
        expect(result).toMatchObject({ status: "published" });
        expect(report.failures).toBe(0);
        expect(report.probes).toBeGreaterThan(5);
        expect(report.worst).toBeLessThan(1000);
      });
    });

    /**
     * #201 — the cancellation contract travels on the queue's `signal.reason`, so
     * a handler test that builds its own abort signal cannot see a queue that
     * stops providing it. These run the publication through the real TaskQueue,
     * its Prisma store and the built-in handler registration.
     */
    describe("through the real TaskQueue", () => {
      const queues: TaskQueue[] = [];
      afterEach(async () => {
        await Promise.all(queues.splice(0).map((queue) => queue.shutdown()));
      });

      function realQueue(embedder: unknown) {
        const runs: Promise<unknown>[] = [];
        const registry = new InMemoryTaskHandlerRegistry();
        registerBuiltInHandlers(registry, {
          httpWebhookHandler: async () => ({}),
          publishGeneratedDocument: (generatedDocumentId, projectId, v, revisionId, signal, o) => {
            const run = publishGeneratedDocRevision(
              { generatedDocumentId, projectId, version: v, revisionId },
              { signal, storage, embedder: embedder as never, ...o },
            );
            runs.push(run.catch(() => undefined));
            return run;
          },
          settleCancelledGeneratedDocPublication,
        });
        const noop = () => {};
        const queue = new TaskQueue(
          createPrismaTaskStore(),
          registry,
          { schedulerStatus: noop, taskStatus: noop, taskProgress: noop },
          {
            concurrency: 1,
            tickMs: 1000,
            defaultTimeoutMs: 3_600_000,
            retryBackoffMs: 3_600_000,
            retryBackoffMaxMs: 3_600_000,
            minCronIntervalSec: 60,
            enabled: true,
          },
        );
        queues.push(queue);
        return { queue, runs };
      }

      async function enqueueThrough(
        queue: TaskQueue,
        extra: { scheduledFor?: Date } = {},
      ): Promise<TaskRecord> {
        let task: TaskRecord | undefined;
        await enqueueGeneratedDocPublication(
          { ...payload(), markdown: "queued" },
          {
            storage,
            enqueueTask: async (input) => {
              task = await queue.enqueue({ ...input, ...extra });
            },
          },
        );
        return task as TaskRecord;
      }

      it("settles the placeholder of a publication cancelled while still queued", async () => {
        await version(1, largeDocument(5_000));
        const { calls, embedder } = recordingEmbedder();
        const { queue } = realQueue(embedder);
        // Not due for an hour: it is queued, whatever the machine's load.
        const task = await enqueueThrough(queue, {
          scheduledFor: new Date(Date.now() + 3_600_000),
        });
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          { status: "pending", errorMessage: null },
        );

        expect(await queue.cancel(task.id, "cancelled by initiator")).toBe(true);

        expect(calls).toHaveLength(0);
        expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          status: "cancelled",
        });
        const row = await db.document.findUniqueOrThrow({ where: { id: syntheticId() } });
        expect(row).toMatchObject({
          status: "failed",
          errorMessage: "generated-doc publication cancelled: cancelled by initiator",
        });
        expect(row.processedAt).not.toBeNull();
      });

      it("records a user's cancellation of a running publication as cancelled", async () => {
        await version(1, largeDocument(60_000));
        let cancelling: Promise<boolean> | undefined;
        let taskId!: (id: string) => void;
        const enqueued = new Promise<string>((resolve) => {
          taskId = resolve;
        });
        const inner = recordingEmbedder();
        const embedder = {
          embed: async (texts: string[]) => {
            const out = await (inner.embedder as { embed(t: string[]): Promise<unknown> }).embed(
              texts,
            );
            // `real` is initialised long before the first batch is embedded.
            cancelling ??= real.queue.cancel(await enqueued, "cancelled by initiator");
            return out;
          },
        };
        const real = realQueue(embedder);
        const task = await enqueueThrough(real.queue);
        taskId(task.id);
        while (real.runs.length === 0 || !cancelling) await new Promise((r) => setImmediate(r));
        await Promise.all(real.runs);
        expect(await cancelling).toBe(true);

        expect(inner.calls).toHaveLength(1);
        expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          status: "cancelled",
        });
        expect(await db.document.findUniqueOrThrow({ where: { id: syntheticId() } })).toMatchObject(
          {
            status: "failed",
            errorMessage: "generated-doc publication cancelled: cancelled by initiator",
          },
        );
      });
    });

    describe("reconcileStrandedGeneratedDocPublications", () => {
      async function seedSynthetic(
        p: ReturnType<typeof payload>,
        fields: {
          status?: string;
          indexState?: string;
          chunks?: number;
          uploadedById?: string;
        } = {},
      ) {
        await db.document.create({
          data: {
            id: syntheticId(p),
            projectId: p.projectId,
            filename: `generated-doc-${p.generatedDocumentId}.md`,
            mimeType: "text/markdown",
            sizeBytes: 5,
            storagePath: "doc.md",
            checksum: "hash",
            status: fields.status ?? "processing",
            indexState: fields.indexState ?? "pending",
            uploadedById: fields.uploadedById ?? "initiator",
          },
        });
        for (let ord = 0; ord < (fields.chunks ?? 0); ord += 1) {
          await db.quarantineChunk.create({
            data: {
              id: `${syntheticId(p)}#${ord}`,
              documentId: syntheticId(p),
              projectId: p.projectId,
              ord,
              text: `chunk ${ord}`,
              embedding: "[1,0]",
            },
          });
        }
      }
      async function seedTask(
        p: ReturnType<typeof payload>,
        status: string,
        errorMessage: string | null = null,
      ) {
        await db.task.create({
          data: {
            id: generatedDocOutboxId(p),
            type: "publish-generated-document",
            projectId: p.projectId,
            payload: JSON.stringify(p),
            status,
            errorMessage,
            attempts: status === "failed" ? 3 : 1,
          },
        });
      }

      it("settles each stranded shape once and leaves live or user-owned rows alone", async () => {
        // 1. Embedded + parked for review, task completed, row stuck `processing`.
        const parked = payload(1);
        await version(1, "parked");
        await seedSynthetic(parked, { indexState: "quarantined", chunks: 2 });
        await seedTask(parked, "completed");
        // 2. Task exhausted its attempts.
        const exhausted = payload(1, "project", "doc2");
        await version(1, "exhausted", "doc2");
        await seedSynthetic(exhausted);
        await seedTask(exhausted, "failed", "embed worker exited (code 1)");
        // 3. No task at all.
        const orphan = payload(1, "project", "doc3");
        await version(1, "orphan", "doc3");
        await seedSynthetic(orphan);
        // 4. Live task — the scheduler owns it.
        const live = payload(1, "project", "doc4");
        await version(1, "live", "doc4");
        await seedSynthetic(live);
        await seedTask(live, "running");
        // 5. Revision whose generated document was deleted.
        await db.$executeRaw`INSERT INTO generated_documents (id,projectId,title,scope,scopeFilter,deletedAt)
        VALUES ('gone','project','Gone','full','{}',CURRENT_TIMESTAMP)`;
        const deleted = payload(1, "project", "gone");
        await seedSynthetic(deleted, { indexState: "quarantined", chunks: 1 });
        // 6. Legacy unversioned identity.
        await db.document.create({
          data: {
            id: "gendoc-legacy",
            projectId: "project",
            filename: "generated-doc-legacy.md",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: "x",
            checksum: "x",
            status: "processing",
            uploadedById: "initiator",
          },
        });

        const dispatched: string[] = [];
        const report = await reconcileStrandedGeneratedDocPublications({
          dispatchTask: async (id) => {
            dispatched.push(id);
          },
        });

        expect(report).toEqual({
          finalized: [syntheticId(parked)],
          failed: [syntheticId(exhausted)],
          cancelled: [],
          removed: [syntheticId(deleted)],
          rearmed: [syntheticId(orphan)],
          skipped: expect.arrayContaining([syntheticId(live), "gendoc-legacy"]),
        });
        const byId = async (id: string) => db.document.findUniqueOrThrow({ where: { id } });
        expect(await byId(syntheticId(parked))).toMatchObject({
          status: "ready",
          indexState: "quarantined",
        });
        expect(await byId(syntheticId(exhausted))).toMatchObject({
          status: "failed",
          errorMessage: "generated-doc publication failed: embed worker exited (code 1)",
        });
        expect((await byId(syntheticId(deleted))).deletedAt).not.toBeNull();
        expect(
          await db.quarantineChunk.count({ where: { documentId: syntheticId(deleted) } }),
        ).toBe(0);
        expect(await byId(syntheticId(live))).toMatchObject({ status: "processing" });
        expect(dispatched).toEqual([generatedDocOutboxId(orphan)]);
        expect(
          await db.task.findUniqueOrThrow({ where: { id: generatedDocOutboxId(orphan) } }),
        ).toMatchObject({ status: "pending", type: "publish-generated-document" });

        // Idempotent: a second start finds nothing new to settle.
        const again = await reconcileStrandedGeneratedDocPublications({
          dispatchTask: async () => {},
        });
        expect(again.finalized).toEqual([]);
        expect(again.failed).toEqual([]);
        expect(again.removed).toEqual([]);
        // The orphan's task is now pending — owned by the scheduler, not re-armed twice.
        expect(again.rearmed).toEqual([]);
      });

      it("re-arms a completed task that left no outcome, and never overrides a user cancellation", async () => {
        const completed = payload(1);
        await version(1, "completed");
        await seedSynthetic(completed);
        await seedTask(completed, "completed");
        const cancelled = payload(1, "project", "doc2");
        await version(1, "cancelled", "doc2");
        await seedSynthetic(cancelled);
        await seedTask(cancelled, "cancelled", "cancelled by user");

        const dispatched: string[] = [];
        const report = await reconcileStrandedGeneratedDocPublications({
          dispatchTask: async (id) => {
            dispatched.push(id);
          },
        });
        expect(report.rearmed).toEqual([syntheticId(completed)]);
        // #201 — settled as cancelled, never re-run.
        expect(report.cancelled).toEqual([syntheticId(cancelled)]);
        expect(report.skipped).toEqual([]);
        expect(dispatched).toEqual([generatedDocOutboxId(completed)]);
        expect(
          await db.task.findUniqueOrThrow({ where: { id: generatedDocOutboxId(completed) } }),
        ).toMatchObject({ status: "pending", attempts: 0 });
        expect(
          await db.task.findUniqueOrThrow({ where: { id: generatedDocOutboxId(cancelled) } }),
        ).toMatchObject({ status: "cancelled" });
        const row = await db.document.findUniqueOrThrow({ where: { id: syntheticId(cancelled) } });
        expect(row).toMatchObject({
          status: "failed",
          errorMessage: "generated-doc publication cancelled: cancelled by user",
        });
        expect(row.processedAt).not.toBeNull();
        // Idempotent: the settled row is not picked up again.
        const again = await reconcileStrandedGeneratedDocPublications({
          dispatchTask: async () => {},
        });
        expect(again.cancelled).toEqual([]);
      });

      it("#201 — a cancellation outranks parked chunks: the row is never marked ready", async () => {
        const cancelled = payload(1);
        await version(1, "cancelled after parking");
        await seedSynthetic(cancelled, { indexState: "quarantined", chunks: 2 });
        await seedTask(cancelled, "cancelled", "cancelled by user");

        const report = await reconcileStrandedGeneratedDocPublications({
          dispatchTask: async () => {},
        });
        expect(report.cancelled).toEqual([syntheticId(cancelled)]);
        expect(report.finalized).toEqual([]);
        expect(
          await db.document.findUniqueOrThrow({ where: { id: syntheticId(cancelled) } }),
        ).toMatchObject({
          status: "failed",
          errorMessage: "generated-doc publication cancelled: cancelled by user",
        });
      });

      it("removes a synthetic row whose revision names no version", async () => {
        await db.document.create({
          data: {
            id: "gendoc-doc:opaque-revision",
            projectId: "project",
            filename: "generated-doc-doc.md",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: "x",
            checksum: "x",
            status: "processing",
            uploadedById: "initiator",
          },
        });
        const report = await reconcileStrandedGeneratedDocPublications({
          dispatchTask: async () => {},
        });
        expect(report.removed).toEqual(["gendoc-doc:opaque-revision"]);
      });

      it("parses only revisioned synthetic ids", () => {
        expect(parseSyntheticDocumentId("gendoc-doc:gendoc:p:doc:v3")).toEqual({
          generatedDocumentId: "doc",
          revisionId: "gendoc:p:doc:v3",
        });
        expect(parseSyntheticDocumentId("gendoc-doc")).toBeNull();
        expect(parseSyntheticDocumentId("gendoc-doc:")).toBeNull();
        expect(parseSyntheticDocumentId("gendoc-:x")).toBeNull();
        expect(parseSyntheticDocumentId("upload-1")).toBeNull();
      });
    });

    /**
     * #230 — a publication whose run ended `failed` (a user cancelled it, or its
     * last attempt failed) can still hold parked chunks in `quarantine_chunks`
     * with `indexState: quarantined`. Approval gated on `indexState` alone, so a
     * reviewer could publish what the user cancelled. Every read below goes
     * through the same path a consumer uses: `listQuarantine` (the review list),
     * `approveDocument` (the approve route) and the `documents`/`knowledge_chunks`
     * rows.
     */
    describe("#230 — a cancelled or failed publication is never approvable", () => {
      const reviewer = { id: "initiator" };
      const parkedCount = () =>
        db.quarantineChunk.count({ where: { documentId: syntheticId(), ord: { gte: 0 } } });
      const liveCount = () => db.knowledgeChunk.count({ where: { documentId: syntheticId() } });
      const row = () => db.document.findUniqueOrThrow({ where: { id: syntheticId() } });
      const listed = async () => (await listQuarantine("project")).map((d) => d.documentId);

      /** Run the vector upsert, then do `after` — the step a concurrent actor takes. */
      function afterNextVectorUpsert(after: () => unknown) {
        const vector = state.vector as LocalStore;
        const upsert = vector.upsert.bind(vector);
        vi.spyOn(vector, "upsert").mockImplementationOnce(async (projectId, rows) => {
          await upsert(projectId, rows);
          await after();
        });
      }

      /** The issue's shape: cancelled after the chunks were parked, before approval. */
      async function cancelAfterParking() {
        await version(1, largeDocument(5_000));
        const controller = new AbortController();
        afterNextVectorUpsert(() =>
          controller.abort(new TaskAbortError("user", "cancelled by user")),
        );
        await expect(
          publishGeneratedDocRevision(payload(), {
            storage,
            signal: controller.signal,
            ...recordingEmbedder(),
          }),
        ).rejects.toThrow("cancelled by user");
      }

      /** An attempt that parked its chunks, then failed. */
      async function failAfterParking(finalAttempt: boolean) {
        await version(1, largeDocument(5_000));
        vi.spyOn(state.vector as LocalStore, "upsert").mockRejectedValueOnce(
          new Error("vector store offline"),
        );
        await expect(
          publishGeneratedDocRevision(payload(), { storage, finalAttempt, ...recordingEmbedder() }),
        ).rejects.toThrow("vector store offline");
      }

      async function expectCancelledAndUnapprovable(message: string) {
        // The bug's precondition: the chunks are still parked and the row is
        // still `quarantined` — only the guard stands between them and the index.
        expect(await parkedCount()).toBeGreaterThan(0);
        expect(await row()).toMatchObject({
          status: "failed",
          indexState: "quarantined",
          errorMessage: message,
        });
        expect(await listed()).not.toContain(syntheticId());
        await expect(approveDocument(syntheticId(), reviewer)).rejects.toThrow(
          /not in approvable state/,
        );
        expect(await liveCount()).toBe(0);
        // The #201 outcome is kept: a refused approval writes nothing.
        expect(await row()).toMatchObject({
          status: "failed",
          indexState: "quarantined",
          errorMessage: message,
        });
      }

      it("a cancellation that lands after the chunks were parked is not approvable", async () => {
        await cancelAfterParking();
        await expectCancelledAndUnapprovable(
          "generated-doc publication cancelled: cancelled by user",
        );
      });

      it("a queued retry cancelled after an earlier attempt parked chunks is not approvable", async () => {
        await failAfterParking(false);
        // The earlier attempt left the row open for its retry, and reviewable.
        expect(await row()).toMatchObject({ status: "processing", indexState: "quarantined" });
        expect(await listed()).toContain(syntheticId());

        await settleCancelledGeneratedDocPublication(payload(), "cancelled by initiator");

        await expectCancelledAndUnapprovable(
          "generated-doc publication cancelled: cancelled by initiator",
        );
      });

      it("a publication whose last attempt failed after parking is not approvable", async () => {
        await failAfterParking(true);
        await expectCancelledAndUnapprovable(
          "generated-doc publication failed: vector store offline",
        );
      });

      it("a cancellation that lands during a reviewer's approval stops it before it commits", async () => {
        await failAfterParking(false);
        // The reviewer passed every up-front check; the user cancels while the
        // approval is writing to the vector store.
        afterNextVectorUpsert(() =>
          settleCancelledGeneratedDocPublication(payload(), "cancelled by initiator"),
        );
        await expect(approveDocument(syntheticId(), reviewer)).rejects.toThrow(
          /no longer approvable/,
        );

        expect(await liveCount()).toBe(0);
        expect(await (state.vector as LocalStore).count("project")).toBe(0);
        expect(await row()).toMatchObject({
          status: "failed",
          indexState: "quarantined",
          errorMessage: "generated-doc publication cancelled: cancelled by initiator",
        });
        await expect(approveDocument(syntheticId(), reviewer)).rejects.toThrow(
          /not in approvable state/,
        );
      });

      it("a user's retry of the cancelled task reopens the row and publishes it", async () => {
        await cancelAfterParking();
        const result = await publishGeneratedDocRevision(payload(), {
          storage,
          ...recordingEmbedder(),
        });
        expect(result).toMatchObject({ status: "published" });
        expect(await row()).toMatchObject({
          status: "ready",
          indexState: "indexed",
          errorMessage: null,
        });
        expect(await liveCount()).toBeGreaterThan(0);
      });

      it("startup repair leaves a cancelled row cancelled and unapprovable", async () => {
        await cancelAfterParking();
        await db.task.create({
          data: {
            id: generatedDocOutboxId(payload()),
            type: "publish-generated-document",
            projectId: "project",
            payload: JSON.stringify(payload()),
            status: "cancelled",
            errorMessage: "cancelled by user",
          },
        });
        const before = await row();

        const report = await reconcileStrandedGeneratedDocPublications({
          dispatchTask: async () => {},
        });

        expect(Object.values(report).flat()).toEqual([]);
        expect(await row()).toEqual(before);
        await expectCancelledAndUnapprovable(
          "generated-doc publication cancelled: cancelled by user",
        );
      });

      it("startup repair settles an exhausted task with parked chunks as failed, never awaiting review", async () => {
        // An attempt parked the chunks; the process died before the task's last
        // attempt could record the outcome on the row.
        await failAfterParking(false);
        await db.task.create({
          data: {
            id: generatedDocOutboxId(payload()),
            type: "publish-generated-document",
            projectId: "project",
            payload: JSON.stringify(payload()),
            status: "failed",
            errorMessage: "vector store offline",
            attempts: 3,
          },
        });

        const report = await reconcileStrandedGeneratedDocPublications({
          dispatchTask: async () => {},
        });

        expect(report.failed).toEqual([syntheticId()]);
        expect(report.finalized).toEqual([]);
        await expectCancelledAndUnapprovable(
          "generated-doc publication failed: vector store offline",
        );
      });

      it("an uploaded document's approval is unchanged: the guard is generated-doc only", async () => {
        await db.document.create({
          data: {
            id: "upload-1",
            projectId: "project",
            filename: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 5,
            storagePath: "notes.md",
            checksum: "hash",
            status: "failed",
            indexState: "quarantined",
            uploadedById: "initiator",
          },
        });
        await db.quarantineChunk.create({
          data: {
            id: "upload-1#0",
            documentId: "upload-1",
            projectId: "project",
            ord: 0,
            text: "uploaded text",
            embedding: "[1,0]",
            metadata: JSON.stringify({ md5: "hash", embeddingModel: "test" }),
          },
        });
        expect(await listed()).toContain("upload-1");
        await expect(approveDocument("upload-1", reviewer)).resolves.toEqual({ chunkCount: 1 });
      });
    });
  },
);
