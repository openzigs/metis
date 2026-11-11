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
        return input.chunks.map((_, i) => (i === 0 ? null : `Model context ${i}.`));
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

    afterEach(() => {
      rmSync(vectorRoot, { recursive: true, force: true });
    });
  },
);
