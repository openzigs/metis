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
const { rejectDocument } = await import("../src/lib/rag/quarantine.js");
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
    /** #2355 — runs once, inside the next storage read, then clears itself. */
    let onNextRead: (() => Promise<void>) | undefined;
    const storage = {
      read: async (p: string) => {
        const hook = onNextRead;
        onNextRead = undefined;
        await hook?.();
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
      const store = new LocalVectorStore({ root: vectorRoot });
      return {
        embedder,
        bm25,
        store,
        knowledge: new KnowledgeService({
          embedder: embedder as unknown as Embedder,
          vectorStore: store,
          storage,
          bm25,
          chunkOptions: CHUNKING,
          symbolEmbeddings: symbolsStub,
          contextualChunks: { mode, ...(generator ? { generator } : {}) },
        }),
      };
    }

    async function seedDocument(
      id: string,
      filename: string,
      text = DOC,
      autoApproveTrusted = true,
    ): Promise<void> {
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
          autoApproveTrusted,
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
    function scriptedModel(
      onCall: (call: number) => Promise<void> = async () => {},
      budget: Pick<
        Parameters<typeof modelChunkContextGenerator>[0],
        "remainingTokens" | "onResponse"
      > = {},
    ) {
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
        generator: modelChunkContextGenerator({
          provider: () => provider,
          concurrency: 1,
          ...budget,
        }),
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

    /**
     * #2355 — a re-ingest's old chunks answer searches until its new chunks commit,
     * then leave every index. One service throughout, so the vector store and the
     * warm BM25 index read here are the ones the ingest writes.
     */
    describe("#2355 — a re-ingest replaces the live chunks only when its own chunks commit", () => {
      const QUERY = "payroll reconciliation mismatch";
      const CHANGED = `${DOC}\nA new closing line.\n`;

      async function liveIds(id: string): Promise<Set<string>> {
        return new Set((await storedChunks(id)).map((r) => r.id));
      }

      it("model: every call of the re-ingest runs while the old chunks still answer", async () => {
        await seedDocument("doc-gap", "leave-policy.md");
        let watching = false;
        const seenDuring: string[][] = [];
        const box: { s?: ReturnType<typeof service> } = {};
        const model = scriptedModel(async () => {
          if (!watching) return;
          const found = await box.s!.knowledge.search(PROJECT, QUERY, { k: 20 });
          seenDuring.push(found.hits.map((h) => h.chunkId));
        });
        box.s = service("model", recordingEmbedder(), model.generator);
        await box.s.knowledge.ingestDocument("doc-gap");
        const before = await liveIds("doc-gap");
        expect(before.size).toBe(expected.length);

        blobs.set("mem://doc-gap", Buffer.from(CHANGED, "utf8"));
        watching = true;
        expect((await box.s.knowledge.ingestDocument("doc-gap")).status).toBe("ready");

        expect(seenDuring).toHaveLength(chunkMarkdown(CHANGED, CHUNKING).length);
        for (const hits of seenDuring) {
          expect(hits.length).toBeGreaterThan(0);
          for (const id of hits) expect(before.has(id)).toBe(true);
        }
        // Committed: the new generation alone is live, in SQL, the vectors and BM25.
        const after = await liveIds("doc-gap");
        expect([...after].some((id) => before.has(id))).toBe(false);
        expect(await box.s.store.count(PROJECT)).toBe(after.size);
        const warm = await box.s.bm25.search(PROJECT, "reconciliation", 50);
        for (const h of warm) expect(before.has(h.chunkId)).toBe(false);
        const found = await box.s.knowledge.search(PROJECT, QUERY, { k: 20 });
        expect(found.hits.length).toBeGreaterThan(0);
        for (const h of found.hits) expect(after.has(h.chunkId)).toBe(true);
      });

      it("a re-ingest that fails leaves no live chunks, as a failed ingest always has", async () => {
        await seedDocument("doc-fail", "leave-policy.md");
        const s = service("headings");
        await s.knowledge.ingestDocument("doc-fail");
        expect((await liveIds("doc-fail")).size).toBe(expected.length);

        s.embedder.embed = async () => {
          throw new Error("embedder down");
        };
        const result = await s.knowledge.ingestDocument("doc-fail");
        expect(result.status).toBe("failed");
        expect((await liveIds("doc-fail")).size).toBe(0);
        expect(await s.store.count(PROJECT)).toBe(0);
        expect(await s.bm25.search(PROJECT, "reconciliation", 50)).toEqual([]);
      });

      it("a re-ingest parked for review takes the old chunks out of search", async () => {
        await seedDocument("doc-review", "leave-policy.md");
        const s = service("headings");
        await s.knowledge.ingestDocument("doc-review");
        expect((await liveIds("doc-review")).size).toBe(expected.length);

        await db.document.update({
          where: { id: "doc-review" },
          data: { autoApproveTrusted: false },
        });
        const result = await s.knowledge.ingestDocument("doc-review");
        expect(result.status).toBe("ready");
        const doc = await db.document.findUniqueOrThrow({ where: { id: "doc-review" } });
        expect(doc.indexState).toBe("quarantined");
        expect((await liveIds("doc-review")).size).toBe(0);
        expect(await s.store.count(PROJECT)).toBe(0);
        expect(
          await db.quarantineChunk.count({ where: { documentId: "doc-review", ord: { gte: 0 } } }),
        ).toBe(expected.length);
      });

      it("model: contexts saved on chunks still parked for review are reused", async () => {
        await seedDocument("doc-parked", "leave-policy.md", DOC, false);
        const model = scriptedModel();
        const first = service("model", recordingEmbedder(), model.generator);
        await first.knowledge.ingestDocument("doc-parked");
        expect(model.calls()).toBe(expected.length);
        // Nothing was approved: the contexts exist only on the quarantined rows.
        expect(await storedChunks("doc-parked")).toEqual([]);

        const again = scriptedModel();
        const second = service("model", recordingEmbedder(), again.generator);
        await second.knowledge.ingestDocument("doc-parked");
        expect(again.calls()).toBe(0);
      });

      it("model: a budget stop tags the rows model-partial, so they read as needing a re-ingest", async () => {
        await seedDocument("doc-budget", "leave-policy.md");
        // One call's worth of budget: the first reply spends it.
        const capped = scriptedModel(async () => {}, {
          remainingTokens: async () => 1,
          onResponse: async () => 1,
        });
        const s = service("model", recordingEmbedder(), capped.generator);
        expect((await s.knowledge.ingestDocument("doc-budget")).status).toBe("ready");
        expect(capped.calls()).toBe(1);
        const identities = async () =>
          new Set((await storedChunks("doc-budget")).map((r) => r.chunkerIdentity));
        expect(await identities()).toEqual(new Set(["doc:v3:256/0;ctx=model-partial"]));
        const partial = await s.knowledge.coverageReport(PROJECT);
        expect(partial.currentChunkerIdentity).toBe("doc:v3:256/0;ctx=model");
        expect(partial.needsReingest).toBe(true);

        // Once the budget allows, a re-ingest asks only for what the stop left out.
        const full = scriptedModel();
        const t = service("model", recordingEmbedder(), full.generator);
        await t.knowledge.ingestDocument("doc-budget");
        expect(full.calls()).toBe(expected.length - 1);
        expect(await identities()).toEqual(new Set(["doc:v3:256/0;ctx=model"]));
        expect((await t.knowledge.coverageReport(PROJECT)).needsReingest).toBe(false);
      });

      it("model: a document no model context was written for (no provider) is tagged model-partial too", async () => {
        await seedDocument("doc-noprov", "leave-policy.md");
        const generator = modelChunkContextGenerator({
          provider: () => {
            throw new Error("no provider configured");
          },
        });
        const s = service("model", recordingEmbedder(), generator);
        expect((await s.knowledge.ingestDocument("doc-noprov")).status).toBe("ready");
        const rows = await storedChunks("doc-noprov");
        expect(new Set(rows.map((r) => r.chunkerIdentity))).toEqual(
          new Set(["doc:v3:256/0;ctx=model-partial"]),
        );
        expect((await s.knowledge.coverageReport(PROJECT)).needsReingest).toBe(true);
      });

      /** Every chunk without a model context; `during` runs inside the call when armed. */
      function hookedGenerator(during: () => Promise<void>) {
        const hook = { armed: false };
        const generator: ChunkContextGenerator = async (input) => {
          if (hook.armed) {
            hook.armed = false;
            await during();
          }
          return input.chunks.map(() => null);
        };
        return { hook, generator };
      }

      async function searchIds(s: ReturnType<typeof service>): Promise<string[]> {
        return (await s.knowledge.search(PROJECT, QUERY, { k: 20 })).hits.map((h) => h.chunkId);
      }

      it("a document rejected while a re-ingest is in flight keeps no searchable chunks", async () => {
        await seedDocument("doc-reject", "leave-policy.md");
        const box: { s?: ReturnType<typeof service> } = {};
        const { hook, generator } = hookedGenerator(() =>
          rejectDocument("doc-reject", { id: USER }, "not this one", {
            vectorStore: box.s!.store,
            bm25: box.s!.bm25,
          }),
        );
        box.s = service("model", recordingEmbedder(), generator);
        await box.s.knowledge.ingestDocument("doc-reject");
        expect((await liveIds("doc-reject")).size).toBe(expected.length);

        hook.armed = true;
        await expect(box.s.knowledge.ingestDocument("doc-reject")).rejects.toThrow(
          /ingest generation revoked/,
        );

        const doc = await db.document.findUniqueOrThrow({ where: { id: "doc-reject" } });
        expect(doc.indexState).toBe("rejected");
        expect((await liveIds("doc-reject")).size).toBe(0);
        expect(await box.s.store.count(PROJECT)).toBe(0);
        expect(await box.s.bm25.search(PROJECT, "reconciliation", 50)).toEqual([]);
        expect(await searchIds(box.s)).toEqual([]);
      });

      /**
       * Ingest A is superseded by ingest B (B's start revokes A's generation marker and
       * sets the document `pending` again), then A ends on a path that retires. B is
       * held inside its model call, so the old chunks are still the live ones: A must
       * leave them alone, or the search gap #2355 closes comes back mid-B.
       */
      describe("an ingest superseded by a newer one never retires the chunks that one keeps live", () => {
        function supersede(id: string) {
          const box: { s?: ReturnType<typeof service>; b?: Promise<unknown> } = {};
          let release!: () => void;
          const held = new Promise<void>((resolve) => (release = resolve));
          let reached!: () => void;
          const bInModel = new Promise<void>((resolve) => (reached = resolve));
          const b = hookedGenerator(async () => {
            reached();
            await held;
          });
          /** Start B and return once it is inside its model call. */
          const startB = async (): Promise<void> => {
            b.hook.armed = true;
            box.b = box.s!.knowledge.ingestDocument(id);
            await bInModel;
          };
          box.s = service("model", recordingEmbedder(), b.generator);
          return { box, startB, release };
        }

        async function expectOldStillLive(
          id: string,
          s: ReturnType<typeof service>,
          before: Set<string>,
        ): Promise<void> {
          expect(await liveIds(id)).toEqual(before);
          expect(await s.store.count(PROJECT)).toBe(before.size);
          const hits = await searchIds(s);
          expect(hits.length).toBeGreaterThan(0);
          for (const hit of hits) expect(before.has(hit)).toBe(true);
        }

        it("when A throws 'ingest generation revoked'", async () => {
          await seedDocument("doc-sup-throw", "leave-policy.md");
          const { box, startB, release } = supersede("doc-sup-throw");
          // A's own model call is where B starts; B's generator is a separate hook.
          const a = hookedGenerator(startB);
          const s = box.s!;
          await s.knowledge.ingestDocument("doc-sup-throw");
          const before = await liveIds("doc-sup-throw");
          // One vector store and BM25 index for A and B, as in one process.
          const aService = new KnowledgeService({
            embedder: recordingEmbedder() as unknown as Embedder,
            vectorStore: s.store,
            storage,
            bm25: s.bm25,
            chunkOptions: CHUNKING,
            symbolEmbeddings: symbolsStub,
            contextualChunks: { mode: "model", generator: a.generator },
          });

          a.hook.armed = true;
          await expect(aService.ingestDocument("doc-sup-throw")).rejects.toThrow(
            /ingest generation revoked/,
          );
          await expectOldStillLive("doc-sup-throw", s, before);

          release();
          expect(await box.b).toMatchObject({ status: "ready" });
          const after = await liveIds("doc-sup-throw");
          expect([...after].some((chunkId) => before.has(chunkId))).toBe(false);
          expect(after.size).toBe(expected.length);
        });

        it("when A's bytes no longer parse", async () => {
          await seedDocument("doc-sup-parse", "leave-policy.md");
          const { box, startB, release } = supersede("doc-sup-parse");
          const s = box.s!;
          await s.knowledge.ingestDocument("doc-sup-parse");
          const before = await liveIds("doc-sup-parse");

          // A reads the row as a PDF, so the parser refuses the markdown bytes. Inside
          // A's storage read the row is put back and B starts, reading it as markdown.
          await db.document.update({
            where: { id: "doc-sup-parse" },
            data: { mimeType: "application/pdf" },
          });
          onNextRead = async () => {
            await db.document.update({
              where: { id: "doc-sup-parse" },
              data: { mimeType: "text/markdown" },
            });
            await startB();
          };
          const refused = await s.knowledge.ingestDocument("doc-sup-parse");
          expect(refused.errorMessage).toMatch(/^CONTENT_TYPE_MISMATCH/);
          await expectOldStillLive("doc-sup-parse", s, before);

          release();
          expect(await box.b).toMatchObject({ status: "ready" });
          const after = await liveIds("doc-sup-parse");
          expect([...after].some((chunkId) => before.has(chunkId))).toBe(false);
        });
      });
    });

    afterEach(() => {
      rmSync(vectorRoot, { recursive: true, force: true });
    });
  },
);
