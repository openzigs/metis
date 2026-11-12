/**
 * Issue #2234 — contextual chunks through the REAL ingest, over a REAL SQLite
 * database (the real migration chain), the real local vector store and a real
 * BM25 index. Only the embedder (a recording bag-of-words) and the document
 * storage (bytes in memory) are doubles.
 *
 * Every assertion reads back through a path a consumer uses: the persisted
 * `KnowledgeChunk` rows, a FRESH `BM25Index` that lazy-loads those rows (no state
 * shared with the ingest), `KnowledgeService.search`, and `reindexProject` — the
 * two readers that rebuild an index from stored rows and would silently revert to
 * the bare chunk if the prefix were not persisted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { KnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
const { BM25Index } = await import("../src/lib/rag/bm25-index.js");
const { LocalVectorStore } = await import("../src/lib/rag/vector-store.js");
const { chunkMarkdown } = await import("../src/lib/rag/chunker.js");
const { modelChunkContextGenerator } = await import("../src/lib/rag/contextual-chunks.js");
type AIProvider = import("../src/lib/ai/types.js").AIProvider;
type ChatResponse = import("../src/lib/ai/types.js").ChatResponse;
type Embedder = import("../src/lib/rag/embedder.js").Embedder;
type StorageBackend = import("../src/lib/documents/storage-backend.js").StorageBackend;
type ContextualChunksMode = import("../src/lib/rag/contextual-chunks.js").ContextualChunksMode;
type ChunkContextGenerator = import("../src/lib/rag/contextual-chunks.js").ChunkContextGenerator;
type SymbolEmbeddingsPort =
  import("../src/lib/code-graph/symbol-embedding-service.js").SymbolEmbeddingsPort;

const DIM = 64;
function bow(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
/** A bag-of-words embedder that records every text it was asked to embed. */
function recordingEmbedder(model = "bow-2234") {
  const seen: string[] = [];
  const embedder = {
    model,
    dimension: DIM,
    seen,
    embed: async (texts: string[]) => {
      seen.push(...texts);
      return { vectors: texts.map(bow), model, dimension: DIM };
    },
  };
  return embedder;
}

const PROJECT = "proj-2234";
const USER = "u-2234";
const CHUNKING = { chunkSize: 256, overlap: 0 };
const FILLER =
  "Each ledger line is matched against the bank statement by amount and date, and " +
  "the matcher records the line it chose so an auditor can follow the decision. ";
/**
 * The second chunk of the long section never names "reconciliation": only its
 * heading path does. That is the case contextual chunks exist for.
 */
const DOC = [
  "# Leave Request Policy",
  "",
  "Employees request leave through the HR portal and their manager approves it.",
  "",
  "## Payroll reconciliation",
  "",
  FILLER.repeat(3),
  "The system shall notify them within one working day of a mismatch.",
  "",
].join("\n");

const symbolsStub = {
  coverage: async () => ({ totalSymbols: 0, modelCounts: {} }),
  deploymentCoverage: async () => new Map(),
  reindexProject: async () => ({ totalSymbols: 0 }),
  dropProject: async () => {},
  retagToActiveModel: async () => 0,
  isBusy: () => false,
} as unknown as SymbolEmbeddingsPort;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2234 — contextual chunks: indexed with their context, displayed without it (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let vectorRoot: string;
    const blobs = new Map<string, Buffer>();
    const storage = {
      read: async (p: string) => {
        const b = blobs.get(p);
        if (!b) throw new Error(`no blob ${p}`);
        return b;
      },
      write: async () => {
        throw new Error("unused");
      },
      remove: async () => {},
      exists: async (p: string) => blobs.has(p),
      removeProject: async () => {},
    } as unknown as StorageBackend;

    function service(
      mode: ContextualChunksMode,
      embedder = recordingEmbedder(),
      generator?: ChunkContextGenerator,
    ) {
      const bm25 = new BM25Index();
      return {
        embedder,
        bm25,
        knowledge: new KnowledgeService({
          embedder: embedder as unknown as Embedder,
          vectorStore: new LocalVectorStore({ root: vectorRoot }),
          storage,
          bm25,
          chunkOptions: CHUNKING,
          symbolEmbeddings: symbolsStub,
          contextualChunks: { mode, ...(generator ? { generator } : {}) },
        }),
      };
    }

    async function seedDocument(id: string, filename: string, text = DOC): Promise<void> {
      const storagePath = `mem://${id}`;
      blobs.set(storagePath, Buffer.from(text, "utf8"));
      await db.document.create({
        data: {
          id,
          projectId: PROJECT,
          filename,
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(text),
          storagePath,
          checksum: id,
          status: "pending",
          uploadedById: USER,
          autoApproveTrusted: true,
        },
      });
    }

    async function storedChunks(documentId: string) {
      return db.knowledgeChunk.findMany({ where: { documentId }, orderBy: { position: "asc" } });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2234-contextual");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: "U", email: "u2234@example.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: "P", slug: "p-2234", createdById: USER },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      await db.knowledgeChunk.deleteMany({});
      await db.quarantineChunk.deleteMany({});
      await db.document.deleteMany({});
      vectorRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2234-vectors-"));
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const expected = chunkMarkdown(DOC, CHUNKING);
    const tailIndex = expected.findIndex((c) => c.text.includes("notify them"));

    it("the fixture has a chunk that does not name its section", () => {
      expect(tailIndex).toBeGreaterThan(1);
      expect(expected[tailIndex].text.toLowerCase()).not.toContain("reconciliation");
      expect(expected[tailIndex].headings).toEqual([
        "Leave Request Policy",
        "Payroll reconciliation",
      ]);
    });

    it("headings: the embedder and a fresh BM25 index see the prefix; the stored text is the chunker's", async () => {
      await seedDocument("doc-h", "leave-policy.md");
      const { knowledge, embedder, bm25 } = service("headings");
      const result = await knowledge.ingestDocument("doc-h");
      expect(result.status).toBe("ready");

      const rows = await storedChunks("doc-h");
      expect(rows.map((r) => r.text)).toEqual(expected.map((c) => c.text));
      const prefix = JSON.parse(rows[tailIndex].metadata ?? "{}").contextPrefix as string;
      expect(prefix).toBe(
        "Document: Leave Request Policy: Employees request leave through the HR portal and " +
          "their manager approves it.\nSection: Leave Request Policy > Payroll reconciliation",
      );
      expect(embedder.seen[tailIndex]).toBe(`${prefix}\n\n${expected[tailIndex].text}`);

      // A FRESH index lazy-loads the persisted rows: the heading-only word now
      // reaches the chunk that does not contain it.
      const hits = await new BM25Index().search(PROJECT, "reconciliation", 20);
      expect(hits.map((h) => h.chunkId)).toContain(rows[tailIndex].id);
      // ...and so does the service's own warm index, written at approval.
      const warm = await bm25.search(PROJECT, "reconciliation", 20);
      expect(warm.map((h) => h.chunkId)).toContain(rows[tailIndex].id);

      // What a consumer is handed is the display text, never the prefix.
      const found = await knowledge.search(PROJECT, "payroll reconciliation mismatch", { k: 20 });
      expect(found.hits.length).toBeGreaterThan(0);
      for (const hit of found.hits) expect(hit.text).not.toContain("Document:");
      expect(found.hits.map((h) => h.text)).toContain(expected[tailIndex].text);
    });

    it("off: ingest is byte-identical to before — no prefix embedded, persisted or indexed", async () => {
      await seedDocument("doc-o", "leave-policy.md");
      const { knowledge, embedder } = service("off");
      await knowledge.ingestDocument("doc-o");

      expect(embedder.seen).toEqual(expected.map((c) => c.text));
      const rows = await storedChunks("doc-o");
      for (const r of rows)
        expect(JSON.parse(r.metadata ?? "{}")).not.toHaveProperty("contextPrefix");
      const hits = await new BM25Index().search(PROJECT, "reconciliation", 20);
      expect(hits.map((h) => h.chunkId)).not.toContain(rows[tailIndex].id);
    });

    it("a reindex embeds the persisted prefix, not the bare chunk", async () => {
      await seedDocument("doc-r", "leave-policy.md");
      await service("headings").knowledge.ingestDocument("doc-r");
      const rows = await storedChunks("doc-r");

      // A service constructed with contextual chunks OFF still re-embeds what was
      // indexed: the prefix is a property of the stored row, not of the process.
      const { knowledge, embedder } = service("off", recordingEmbedder("bow-2234-v2"));
      const reindexed = await knowledge.reindexProject(PROJECT);
      expect(reindexed.embeddedChunks).toBe(rows.length);
      const prefix = JSON.parse(rows[tailIndex].metadata ?? "{}").contextPrefix as string;
      expect(embedder.seen).toContain(`${prefix}\n\n${rows[tailIndex].text}`);
      expect(embedder.seen).not.toContain(rows[tailIndex].text);
    });

    it("model: each chunk carries its model-written context; the generator is given the whole document", async () => {
      await seedDocument("doc-m", "leave-policy.md");
      const calls: Parameters<ChunkContextGenerator>[0][] = [];
      const generator: ChunkContextGenerator = async (input) => {
        calls.push(input);
        return input.chunks.map((_, i) =>
          i === 0 ? null : { text: `Model context ${i}.`, key: `k${i}` },
        );
      };
      const { knowledge, embedder } = service("model", recordingEmbedder(), generator);
      await knowledge.ingestDocument("doc-m");

      expect(calls).toHaveLength(1);
      expect(calls[0].projectId).toBe(PROJECT);
      expect(calls[0].document).toBe(DOC);
      expect(calls[0].chunks).toEqual(expected.map((c) => c.text));
      const rows = await storedChunks("doc-m");
      const meta = rows.map((r) => JSON.parse(r.metadata ?? "{}").contextPrefix as string);
      expect(meta[tailIndex]).toContain(`\nContext: Model context ${tailIndex}.`);
      // A chunk the model gave nothing for keeps its deterministic prefix.
      expect(meta[0]).toMatch(/^Document: .*\nSection: Leave Request Policy$/);
      expect(embedder.seen[tailIndex]).toBe(`${meta[tailIndex]}\n\n${expected[tailIndex].text}`);
    });

    it("a repository source file is never prefixed, in any mode", async () => {
      await seedDocument("doc-repo", "connector:repo:r1:src/docs/leave-policy.md");
      const { knowledge, embedder } = service("headings");
      await knowledge.ingestDocument("doc-repo");
      expect(embedder.seen).toEqual(expected.map((c) => c.text));
    });

    /**
     * #2268 — the REAL `model` generator over a scripted provider, so the reuse key,
     * the stop check and the prompt are production code; only the reply is scripted.
     */
    function scriptedModel(onCall: (call: number) => Promise<void> = async () => {}) {
      let calls = 0;
      const provider = {
        key: "anthropic",
        model: "claude-2268",
        chat: async () => {
          const call = calls;
          calls += 1;
          await onCall(call);
          return {
            content: `Model context ${call}.`,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          } as ChatResponse;
        },
      } as unknown as AIProvider;
      return {
        calls: () => calls,
        generator: modelChunkContextGenerator({ provider: () => provider, concurrency: 1 }),
      };
    }

    it("#2268 model: re-ingesting an unchanged document reuses every saved context, with no call", async () => {
      await seedDocument("doc-reuse", "leave-policy.md");
      const model = scriptedModel();
      const { knowledge } = service("model", recordingEmbedder(), model.generator);
      await knowledge.ingestDocument("doc-reuse");
      expect(model.calls()).toBe(expected.length);
      const first = (await storedChunks("doc-reuse")).map((r) => JSON.parse(r.metadata ?? "{}"));
      expect(first[tailIndex].chunkContext).toEqual({
        key: expect.stringMatching(/^[0-9a-f]{64}$/),
        text: `Model context ${tailIndex}.`,
      });

      // A NEW service (nothing in memory) re-ingests the same bytes: no model call,
      // and every chunk is indexed with exactly the context it had.
      const again = scriptedModel();
      const second = service("model", recordingEmbedder(), again.generator);
      const result = await second.knowledge.ingestDocument("doc-reuse");
      expect(result.status).toBe("ready");
      expect(again.calls()).toBe(0);
      const reread = (await storedChunks("doc-reuse")).map((r) => JSON.parse(r.metadata ?? "{}"));
      expect(reread.map((m) => m.contextPrefix)).toEqual(first.map((m) => m.contextPrefix));
      expect(reread.map((m) => m.chunkContext)).toEqual(first.map((m) => m.chunkContext));
    });

    it("#2268 model: a changed document is asked again", async () => {
      await seedDocument("doc-change", "leave-policy.md");
      const model = scriptedModel();
      await service("model", recordingEmbedder(), model.generator).knowledge.ingestDocument(
        "doc-change",
      );
      blobs.set("mem://doc-change", Buffer.from(`${DOC}\nA new closing line.\n`, "utf8"));
      const again = scriptedModel();
      await service("model", recordingEmbedder(), again.generator).knowledge.ingestDocument(
        "doc-change",
      );
      // Every chunk's context depends on the whole document, so none is reused.
      expect(again.calls()).toBe(chunkMarkdown(`${DOC}\nA new closing line.\n`, CHUNKING).length);
    });

    it("#2268 model: deleting the document mid-ingest stops the remaining calls", async () => {
      await seedDocument("doc-del", "leave-policy.md");
      const box: { knowledge?: InstanceType<typeof KnowledgeService> } = {};
      const model = scriptedModel(async (call) => {
        if (call === 0) await box.knowledge?.deleteDocument("doc-del");
      });
      box.knowledge = service("model", recordingEmbedder(), model.generator).knowledge;
      await box.knowledge.ingestDocument("doc-del").catch(() => undefined);
      expect(expected.length).toBeGreaterThan(1);
      expect(model.calls()).toBe(1);
      expect(await storedChunks("doc-del")).toEqual([]);
    });

    it("#2268 the contextual mode is in the chunker identity, so a flag change needs a re-ingest", async () => {
      await seedDocument("doc-id", "leave-policy.md");
      await seedDocument("doc-id-repo", "connector:repo:r1:src/docs/leave-policy.md");
      const headings = service("headings").knowledge;
      await headings.ingestDocument("doc-id");
      await headings.ingestDocument("doc-id-repo");
      const identities = async (id: string) =>
        new Set((await storedChunks(id)).map((r) => r.chunkerIdentity));
      expect(await identities("doc-id")).toEqual(new Set(["doc:v3:256/0;ctx=headings"]));
      expect(await identities("doc-id-repo")).toEqual(new Set(["doc:v3:256/0;ctx=none"]));

      // Read back through the report `embeddings:migrate status` prints.
      const sameMode = await headings.coverageReport(PROJECT);
      expect(sameMode.currentChunkerIdentity).toBe("doc:v3:256/0;ctx=headings");
      expect(sameMode.needsReingest).toBe(false);
      const flippedOff = await service("off").knowledge.coverageReport(PROJECT);
      expect(flippedOff.needsReingest).toBe(true);
      // Only the prefixed document is behind: the repository file matches every mode.
      expect(flippedOff.matchingChunkerChunks).toBe((await storedChunks("doc-id-repo")).length);
      const deployment = await service("model").knowledge.deploymentCoverage();
      expect(deployment.projects.find((p) => p.projectId === PROJECT)?.needsReingest).toBe(true);
    });

    it("#2268 off: the chunker identity is unchanged from before", async () => {
      await seedDocument("doc-id-off", "leave-policy.md");
      await seedDocument("doc-id-off-repo", "connector:repo:r1:src/docs/leave-policy.md");
      const off = service("off").knowledge;
      await off.ingestDocument("doc-id-off");
      await off.ingestDocument("doc-id-off-repo");
      for (const id of ["doc-id-off", "doc-id-off-repo"]) {
        for (const r of await storedChunks(id)) expect(r.chunkerIdentity).toBe("doc:v3:256/0");
      }
      expect((await off.coverageReport(PROJECT)).needsReingest).toBe(false);
    });

    afterEach(() => {
      rmSync(vectorRoot, { recursive: true, force: true });
    });
  },
);
