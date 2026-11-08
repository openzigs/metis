/**
 * #1843 — the project content version, read from a real database, and the
 * chat read-tool cache keyed on it, driven through the REAL
 * `search_code_graph` tool as chat offers it (`codeRuntimeTool`).
 *
 * The ingest's writes are reproduced directly: an in-flight ingest rewrites a
 * graph's symbols and progress columns, and only the finished ingest stamps
 * `commitSha` and `lastIndexedAt` (`code-graph/ingest.ts`, #758). Runs over a
 * real SQLite database built by the real migration chain.
 *
 * #1864 — the version reads the document count, the latest `updatedAt` and the
 * rows written just before it; a reindex retag, a soft-deleted repo and an
 * incomplete graph (for search-knowledge) are covered here too, and the
 * `documents.updatedAt` migration applies up -> reverse -> up.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "../src/lib/ai/types.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({
  db: null as unknown,
  embedModel: "embed-a",
  embedPooling: "mean",
}));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({
    model: state.embedModel,
    // The full identity (`model|pooling`, #792) differs from the bare model.
    knownIdentity: () => `${state.embedModel}|${state.embedPooling}`,
    // #1944 — the version must not probe the sidecar for its identity.
    currentIdentity: async () => {
      throw new Error("content version probed the embedder");
    },
  }),
}));

const { getProjectContentVersion } = await import("../src/lib/projects/content-version.js");
const { codeRuntimeTool, buildSessionToolset } =
  await import("../src/lib/ai/tool-runtime/toolset.js");
const { ToolRegistry } = await import("../src/lib/ai/tool-registry.js");
const { searchCodeGraphTool } = await import("../src/lib/analysis/tools/search-code-graph.js");
const { getToolResultCache, __resetToolResultCacheForTests } =
  await import("../src/lib/ai/tool-runtime/tool-result-cache.js");

const ALICE = "u-alice";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "20261117001864_issue1864_document_updated_at";
const SHA_A1 = "a".repeat(40);
const SHA_A2 = "b".repeat(40);
const SHA_B1 = "c".repeat(40);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1843 — project content version and the chat tool-result cache",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("tool-result-cache-1843");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ALICE, username: "alice", displayName: "alice", email: "a@example.test" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      state.embedModel = "embed-a";
      state.embedPooling = "mean";
      __resetToolResultCacheForTests();
    });

    async function project(): Promise<string> {
      const id = `p-${++seq}`;
      await db.project.create({ data: { id, name: id, slug: id, createdById: ALICE } });
      return id;
    }
    async function repo(projectId: string, label: string): Promise<string> {
      const r = await db.repoConnection.create({ data: { projectId, label } });
      return r.id;
    }
    /** A graph whose first ingest finished at `sha`, holding `symbols`. */
    async function finishedGraph(
      projectId: string,
      repoConnectionId: string,
      sha: string | null,
      symbols: string[],
    ): Promise<string> {
      const g = await db.codeGraph.create({ data: { projectId, repoConnectionId } });
      await putSymbols(g.id, projectId, symbols);
      await db.codeGraph.update({
        where: { id: g.id },
        data: {
          symbolCount: symbols.length,
          lastIndexedAt: new Date(Date.now() - 60_000),
          ...(sha ? { commitSha: sha } : {}),
        },
      });
      return g.id;
    }
    /** What an ingest does while it runs: rewrite the graph's symbols and progress columns. */
    async function putSymbols(codeGraphId: string, projectId: string, names: string[]) {
      await db.codeSymbol.deleteMany({ where: { codeGraphId } });
      for (const name of names) {
        await db.codeSymbol.create({
          data: {
            codeGraphId,
            projectId,
            kind: "function",
            name,
            qualifiedName: `billing/refunds.go::${name}`,
            filePath: "billing/refunds.go",
            startLine: 1,
            endLine: 9,
            language: "go",
            contentHash: name,
          },
        });
      }
    }
    async function inFlightIngest(codeGraphId: string, projectId: string, names: string[]) {
      await putSymbols(codeGraphId, projectId, names);
      await db.codeGraph.update({
        where: { id: codeGraphId },
        data: {
          symbolCount: names.length,
          goBindingIncomplete: JSON.stringify({ inFlight: true }),
        },
      });
    }
    /** What only a FINISHED ingest writes (#758). */
    async function finishIngest(codeGraphId: string, sha: string) {
      await db.codeGraph.update({
        where: { id: codeGraphId },
        data: { commitSha: sha, lastIndexedAt: new Date(), goBindingIncomplete: null },
      });
    }
    async function upload(projectId: string, name: string): Promise<string> {
      const d = await db.document.create({
        data: {
          projectId,
          filename: name,
          mimeType: "text/markdown",
          sizeBytes: 10,
          storagePath: `/docs/${name}`,
          checksum: `sum-${name}`,
          uploadedById: ALICE,
        },
      });
      return d.id;
    }
    const keyOf = async (projectId: string) => (await getProjectContentVersion(projectId)).key;
    const searchTool = () => codeRuntimeTool(searchCodeGraphTool, "search_code_graph");
    const search = (projectId: string, query = "Refund") =>
      searchTool().execute({ query }, { sessionId: "s", userId: ALICE, projectId });

    describe("the content version", () => {
      it("moves when ONE repo's new graph completes, and not while its ingest is in flight", async () => {
        const p = await project();
        const repoA = await repo(p, "a");
        const repoB = await repo(p, "b");
        const graphA = await finishedGraph(p, repoA, SHA_A1, ["Refund"]);
        await finishedGraph(p, repoB, SHA_B1, ["Invoice"]);

        const before = await getProjectContentVersion(p);
        expect(before.complete).toBe(true);
        expect(before.codeShas).toEqual({ [repoA]: SHA_A1, [repoB]: SHA_B1 });

        await inFlightIngest(graphA, p, ["Refund", "RefundApproval"]);
        expect(await keyOf(p)).toBe(before.key);

        await finishIngest(graphA, SHA_A2);
        const after = await getProjectContentVersion(p);
        expect(after.key).not.toBe(before.key);
        expect(after.codeShas).toEqual({ [repoA]: SHA_A2, [repoB]: SHA_B1 });
      });

      it("moves on a finished re-ingest of the SAME commit (lastIndexedAt)", async () => {
        const p = await project();
        const graph = await finishedGraph(p, await repo(p, "a"), SHA_A1, ["Refund"]);
        const before = await keyOf(p);
        await finishIngest(graph, SHA_A1);
        expect(await keyOf(p)).not.toBe(before);
      });

      it("moves when a document is uploaded, edited, soft-deleted or deleted", async () => {
        const p = await project();
        await finishedGraph(p, await repo(p, "a"), SHA_A1, []);
        const k0 = await keyOf(p);

        const doc = await upload(p, "refund-policy.md");
        const k1 = await keyOf(p);
        expect(k1).not.toBe(k0);

        // An edit: new content, re-processed.
        await db.document.update({
          where: { id: doc },
          data: { checksum: "sum-v2", processedAt: new Date(), chunkCount: 3 },
        });
        const k2 = await keyOf(p);
        expect(k2).not.toBe(k1);

        // An ACL edit alone changes what a search may return.
        await db.document.update({
          where: { id: doc },
          data: { aclSubjects: '[{"kind":"role","value":"admin"}]' },
        });
        const k3 = await keyOf(p);
        expect(k3).not.toBe(k2);

        await db.document.update({ where: { id: doc }, data: { deletedAt: new Date() } });
        const k4 = await keyOf(p);
        expect(k4).not.toBe(k3);

        const other = await upload(p, "other.md");
        const k5 = await keyOf(p);
        await db.document.delete({ where: { id: other } });
        const k6 = await keyOf(p);
        expect(k5).not.toBe(k4);
        expect(k6).not.toBe(k5);
        expect(new Set([k0, k1, k2, k3, k4, k5]).size).toBe(6);
      });

      it("moves when symbol embeddings fill in, and when the embedder model flips", async () => {
        const p = await project();
        const graph = await finishedGraph(p, await repo(p, "a"), SHA_A1, ["Refund"]);
        const k0 = await keyOf(p);
        const symbol = await db.codeSymbol.findFirstOrThrow({ where: { codeGraphId: graph } });
        await db.codeSymbolEmbedding.create({
          data: {
            projectId: p,
            codeGraphId: graph,
            symbolId: symbol.id,
            text: "Refund",
            contentHash: "h",
            embeddingModel: "embed-a",
          },
        });
        const k1 = await keyOf(p);
        expect(k1).not.toBe(k0);
        state.embedModel = "embed-b";
        expect(await keyOf(p)).not.toBe(k1);
      });

      it("moves when only the embedder pooling changes (full identity, not the bare model)", async () => {
        const p = await project();
        const k0 = await keyOf(p);
        state.embedPooling = "cls";
        expect(await keyOf(p)).not.toBe(k0);
      });

      it("is incomplete while a repo's graph has no commit SHA", async () => {
        const p = await project();
        await finishedGraph(p, await repo(p, "a"), SHA_A1, ["Refund"]);
        const repoB = await repo(p, "b");
        await finishedGraph(p, repoB, null, ["Invoice"]);
        const v = await getProjectContentVersion(p);
        expect(v.complete).toBe(false);
        expect(v.codeShas[repoB]).toBeNull();
      });

      it("#1864 Prisma stamps updatedAt on create, update and updateMany, and each moves the key", async () => {
        const p = await project();
        const id = await upload(p, "policy.md");
        const stamp = async () =>
          (await db.document.findUniqueOrThrow({ where: { id } })).updatedAt;
        const created = await stamp();
        expect(created).toBeInstanceOf(Date);
        const k0 = await keyOf(p);

        await new Promise((r) => setTimeout(r, 2));
        await db.document.update({ where: { id }, data: { status: "ready" } });
        const updated = await stamp();
        expect(updated!.getTime()).toBeGreaterThan(created!.getTime());
        const k1 = await keyOf(p);
        expect(k1).not.toBe(k0);

        await new Promise((r) => setTimeout(r, 2));
        await db.document.updateMany({
          where: { projectId: p },
          data: { aclSubjects: '[{"kind":"role","value":"admin"}]' },
        });
        expect((await stamp())!.getTime()).toBeGreaterThan(updated!.getTime());
        expect(await keyOf(p)).not.toBe(k1);
      });

      it("#1864 a second write in the same millisecond still moves the key", async () => {
        const p = await project();
        const id = await upload(p, "policy.md");
        const at = new Date();
        await db.document.update({ where: { id }, data: { updatedAt: at } });
        const before = await getProjectContentVersion(p);
        // An ACL edit stamped with the very same instant: count and latest write hold.
        await db.document.update({
          where: { id },
          data: { aclSubjects: '[{"kind":"role","value":"admin"}]', updatedAt: at },
        });
        expect((await db.document.findUniqueOrThrow({ where: { id } })).updatedAt).toEqual(at);
        expect((await getProjectContentVersion(p)).key).not.toBe(before.key);
      });

      it("#1864 moves when a reindex retags the chunks, with no document row touched", async () => {
        const p = await project();
        const documentId = await upload(p, "policy.md");
        await db.knowledgeChunk.create({
          data: {
            projectId: p,
            documentId,
            position: 0,
            text: "t",
            md5: "m",
            embeddingModel: "embed-a",
          },
        });
        const docBefore = await db.document.findUniqueOrThrow({ where: { id: documentId } });
        const before = await getProjectContentVersion(p);
        // What `retagToActiveModel` / the reindex swap write: the chunk tag only.
        await db.knowledgeChunk.updateMany({
          where: { projectId: p },
          data: { embeddingModel: "embed-b" },
        });
        expect(await db.document.findUniqueOrThrow({ where: { id: documentId } })).toEqual(
          docBefore,
        );
        const after = await getProjectContentVersion(p);
        expect(after.docsVersion).toBe(before.docsVersion);
        expect(after.key).not.toBe(before.key);
      });

      it("#1864 moves when a repo connection is soft-deleted; its graph leaves the version", async () => {
        const p = await project();
        const repoA = await repo(p, "a");
        const repoB = await repo(p, "b");
        await finishedGraph(p, repoA, SHA_A1, ["Refund"]);
        await finishedGraph(p, repoB, null, ["Invoice"]);
        const before = await getProjectContentVersion(p);
        expect(before.complete).toBe(false);

        // What `repo-service` does: the connection row is kept with `deletedAt`, and so is its graph.
        await db.repoConnection.update({ where: { id: repoB }, data: { deletedAt: new Date() } });
        expect(await db.codeGraph.count({ where: { repoConnectionId: repoB } })).toBe(1);
        const after = await getProjectContentVersion(p);
        expect(after.key).not.toBe(before.key);
        expect(after.codeShas).toEqual({ [repoA]: SHA_A1 });
        expect(after.complete).toBe(true);
      });

      it("never reads another project's rows", async () => {
        const p1 = await project();
        const p2 = await project();
        await finishedGraph(p1, await repo(p1, "a"), SHA_A1, []);
        await finishedGraph(p2, await repo(p2, "a"), SHA_A1, []);
        const k1 = await keyOf(p1);
        await upload(p2, "p2-only.md");
        await finishIngest(
          (await db.codeGraph.findFirstOrThrow({ where: { projectId: p2 } })).id,
          SHA_A2,
        );
        expect(await keyOf(p1)).toBe(k1);
      });
    });

    describe("search_code_graph through the cache", () => {
      it("a repeated call on unchanged content is served from the cache", async () => {
        const p = await project();
        const graph = await finishedGraph(p, await repo(p, "a"), SHA_A1, ["Refund"]);
        const first = await search(p);
        expect(first.text).toContain("billing/refunds.go::Refund");

        // Rows change underneath WITHOUT a finished ingest: the version holds,
        // so the answer is the cached one, not a re-run.
        await inFlightIngest(graph, p, ["Chargeback"]);
        const second = await search(p);
        expect(second).toEqual(first);
        expect(getToolResultCache().stats()).toMatchObject({ hit: 1, miss: 1 });
      });

      it("after a re-ingest, the same call misses and returns the NEW results", async () => {
        const p = await project();
        const graph = await finishedGraph(p, await repo(p, "a"), SHA_A1, ["Refund"]);
        const first = await search(p);
        expect(first.text).toContain("::Refund");
        expect(first.text).not.toContain("::RefundApproval");

        await inFlightIngest(graph, p, ["Refund", "RefundApproval"]);
        await finishIngest(graph, SHA_A2);

        const after = await search(p);
        expect(after.text).toContain("billing/refunds.go::RefundApproval");
        expect(after.resultCount).toBe(2);
        expect(getToolResultCache().stats()).toMatchObject({ hit: 0, miss: 2 });
      });

      it("two projects with identical arguments never share an entry", async () => {
        const p1 = await project();
        const p2 = await project();
        await finishedGraph(p1, await repo(p1, "a"), SHA_A1, ["RefundOne"]);
        await finishedGraph(p2, await repo(p2, "a"), SHA_A1, ["RefundTwo"]);
        const r1 = await search(p1);
        const r2 = await search(p2);
        expect(r1.text).toContain("::RefundOne");
        expect(r1.text).not.toContain("::RefundTwo");
        expect(r2.text).toContain("::RefundTwo");
        expect(r2.text).not.toContain("::RefundOne");
        expect(getToolResultCache().stats()).toMatchObject({ entries: 2, hit: 0, miss: 2 });
      });

      it("a project whose graph has no commit SHA is never cached: every call runs", async () => {
        const p = await project();
        const graph = await finishedGraph(p, await repo(p, "a"), null, ["Refund"]);

        expect((await search(p)).text).toContain("::Refund");
        await putSymbols(graph, p, ["RefundApproval"]);
        // Same arguments, nothing cached: the second call sees the new rows.
        expect((await search(p)).text).toContain("::RefundApproval");
        expect(getToolResultCache().stats()).toMatchObject({ entries: 0, hit: 0, bypass: 2 });
      });

      it("#1864 search-knowledge is cached on a project whose graph has no commit SHA", async () => {
        const p = await project();
        await finishedGraph(p, await repo(p, "a"), null, ["Refund"]);
        await upload(p, "refund-policy.md");
        const registry = new ToolRegistry();
        const knowledge = vi.fn(async () => ({ text: "refund-policy.md", resultCount: 1 }));
        registry.register({
          name: "search-knowledge",
          description: "search-knowledge",
          schema: z.object({ query: z.string() }),
          risk: "low",
          exec: knowledge,
        } as unknown as ToolDefinition);
        const ctx = { sessionId: "s", userId: ALICE, projectId: p };
        const set = await buildSessionToolset({ ctx, registry });
        await set.resolve("search-knowledge")!.execute({ query: "refund" }, ctx);
        await set.resolve("search-knowledge")!.execute({ query: "refund" }, ctx);
        expect(knowledge).toHaveBeenCalledTimes(1);
        expect(getToolResultCache().stats()).toMatchObject({ hit: 1, miss: 1, bypass: 0 });
      });

      it("search-knowledge from the registry is cached too; a write-capable tool is not", async () => {
        const p = await project();
        await finishedGraph(p, await repo(p, "a"), SHA_A1, []);
        await upload(p, "refund-policy.md");
        const registry = new ToolRegistry();
        const knowledge = vi.fn(async () => ({
          text: "refund-policy.md: refunds within 30 days",
          resultCount: 1,
        }));
        const other = vi.fn(async () => ({ text: "ran" }));
        for (const [name, exec] of [
          ["search-knowledge", knowledge],
          ["inspect_schema", other],
        ] as const) {
          registry.register({
            name,
            description: name,
            schema: z.object({ query: z.string() }),
            risk: "low",
            exec,
          } as unknown as ToolDefinition);
        }
        const ctx = { sessionId: "s", userId: ALICE, projectId: p };
        const set = await buildSessionToolset({ ctx, registry });
        for (const name of [
          "search-knowledge",
          "inspect_schema",
          "search-knowledge",
          "inspect_schema",
        ]) {
          await set.resolve(name)!.execute({ query: "refund" }, ctx);
        }
        expect(knowledge).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(2);

        // A new document moves the version: the next search runs again.
        await upload(p, "refund-policy-v2.md");
        await set.resolve("search-knowledge")!.execute({ query: "refund" }, ctx);
        expect(knowledge).toHaveBeenCalledTimes(2);
      });
    });
  },
);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1864 — documents.updatedAt migration: up -> reverse -> up",
  () => {
    let sqlite: MigratedSqlite;
    const rollback = readFileSync(
      path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
      "utf-8",
    );
    const pgUp = readFileSync(
      path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
      "utf-8",
    );
    const pgDown = readFileSync(
      path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
      "utf-8",
    );
    const withDb = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(sqlite.dbFile);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    const columns = () =>
      withDb((db) =>
        (db.prepare(`PRAGMA table_info("documents")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const indexes = () =>
      withDb((db) =>
        (db.prepare(`PRAGMA index_list("documents")`).all() as Array<{ name: string }>)
          .map((i) => i.name)
          .sort(),
      );
    const chunkIndexes = () =>
      withDb((db) =>
        (db.prepare(`PRAGMA index_list("knowledge_chunks")`).all() as Array<{ name: string }>)
          .map((i) => i.name)
          .sort(),
      );
    const chunkGroupPlan = () =>
      withDb((db) =>
        (
          db
            .prepare(
              `EXPLAIN QUERY PLAN SELECT "embeddingModel", COUNT(*) FROM "knowledge_chunks" WHERE "projectId" = 'p-1' GROUP BY "embeddingModel"`,
            )
            .all() as Array<{ detail: string }>
        )
          .map((r) => r.detail)
          .join(" | "),
      );
    const row = () =>
      withDb((db) =>
        db.prepare(`SELECT "id","projectId","filename","checksum","status" FROM "documents"`).all(),
      );
    let seeded: unknown;
    let before: string[];
    let beforeIndexes: string[];
    let beforeChunkIndexes: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("1864-document-updated-at", { stopBefore: MIGRATION });
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "documents" ("id","projectId","filename","mimeType","sizeBytes","storagePath","checksum","uploadedById")
           VALUES ('d-1','p-1','a.md','text/markdown',1,'/a.md','sum','u-1')`,
        ).run();
      });
      seeded = row();
      before = columns();
      beforeIndexes = indexes();
      beforeChunkIndexes = chunkIndexes();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the nullable column and its index; reverse restores the shape; up again re-applies",
      () => {
        expect(before).not.toContain("updatedAt");
        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...before, "updatedAt"]);
        expect(indexes()).toEqual([...beforeIndexes, "documents_projectId_updatedAt_idx"].sort());
        expect(row()).toEqual(seeded);
        // The chunk-count group-by is answered from the index, not by reading
        // every chunk row and sorting them into a temp B-tree.
        expect(chunkIndexes()).toEqual(
          [...beforeChunkIndexes, "knowledge_chunks_projectId_embeddingModel_idx"].sort(),
        );
        expect(chunkGroupPlan()).toMatch(
          /USING COVERING INDEX knowledge_chunks_projectId_embeddingModel_idx/,
        );
        expect(chunkGroupPlan()).not.toMatch(/TEMP B-TREE/);
        expect(withDb((db) => db.prepare(`SELECT "updatedAt" FROM "documents"`).get())).toEqual({
          updatedAt: null,
        });
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(before);
        expect(indexes()).toEqual(beforeIndexes);
        expect(chunkIndexes()).toEqual(beforeChunkIndexes);
        expect(row()).toEqual(seeded);
        sqlite.applyRemaining();
        expect(columns()).toContain("updatedAt");
        expect(row()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin adds and drops the same column and index, idempotently", () => {
      expect(pgUp).toMatch(/ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP\(3\);/);
      expect(pgUp).toMatch(/CREATE INDEX IF NOT EXISTS "documents_projectId_updatedAt_idx"/);
      expect(pgDown).toMatch(/DROP INDEX IF EXISTS "documents_projectId_updatedAt_idx";/);
      expect(pgUp).toMatch(
        /CREATE INDEX IF NOT EXISTS "knowledge_chunks_projectId_embeddingModel_idx"/,
      );
      expect(pgDown).toMatch(
        /DROP INDEX IF EXISTS "knowledge_chunks_projectId_embeddingModel_idx";/,
      );
      expect(pgDown).toMatch(/DROP COLUMN IF EXISTS "updatedAt";/);
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
