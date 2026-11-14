/**
 * #2435 — an ACL edit made while a document is being indexed survives the
 * ingest, on real SQLite (the migration chain), the real local vector store and
 * a real BM25 index. Only the embedder and the document storage are doubles.
 *
 * Ingest reads the document when it starts and, before this fix, wrote that
 * list back onto the document and into every quarantine chunk when it
 * finished, so a restriction saved mid-ingest (`PATCH /documents/:id/acl`,
 * `saveDocumentAcl`) was reverted and the chunks were indexed unrestricted.
 * Every assertion reads back through what a consumer uses: the `Document` row,
 * the `QuarantineChunk` and `KnowledgeChunk` rows, and an ACL-filtered search.
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
const { saveDocumentAcl } = await import("../src/lib/rag/acl.js");
const { approveDocument, writeQuarantine } = await import("../src/lib/rag/quarantine.js");
type Embedder = import("../src/lib/rag/embedder.js").Embedder;
type StorageBackend = import("../src/lib/documents/storage-backend.js").StorageBackend;
type SymbolEmbeddingsPort =
  import("../src/lib/code-graph/symbol-embedding-service.js").SymbolEmbeddingsPort;
type AclSubject = import("@metis/shared").AclSubject;

const DIM = 32;
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

const PROJECT = "proj-2435";
const USER = "u-2435";
const TEXT = [
  "# Salary bands",
  "",
  "Band A pays the base salary and band B pays the base salary plus a premium.",
  "",
  "## Review",
  "",
  "Salary bands are reviewed every year by the remuneration committee.",
  "",
].join("\n");
const RESTRICTED: AclSubject[] = [{ kind: "user", value: "alice" }];
const LATER: AclSubject[] = [{ kind: "role", value: "admin-only-reviewers" }];

const symbolsStub = {
  coverage: async () => ({ totalSymbols: 0, modelCounts: {} }),
  deploymentCoverage: async () => new Map(),
  reindexProject: async () => ({ totalSymbols: 0 }),
  dropProject: async () => {},
  retagToActiveModel: async () => 0,
  isBusy: () => false,
} as unknown as SymbolEmbeddingsPort;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2435 — an ACL edit made during ingest survives it (real SQLite)",
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

    /**
     * An embedder that runs `during` once, inside its first call: after ingest
     * read the document and before it writes the quarantine.
     */
    function service(during?: () => Promise<void>) {
      let pending = during;
      const embedder = {
        model: "bow-2435",
        dimension: DIM,
        embed: async (texts: string[]) => {
          const hook = pending;
          pending = undefined;
          await hook?.();
          return { vectors: texts.map(bow), model: "bow-2435", dimension: DIM };
        },
      };
      const bm25 = new BM25Index();
      const store = new LocalVectorStore({ root: vectorRoot });
      return {
        bm25,
        store,
        knowledge: new KnowledgeService({
          embedder: embedder as unknown as Embedder,
          vectorStore: store,
          storage,
          bm25,
          chunkOptions: { chunkSize: 128, overlap: 0 },
          symbolEmbeddings: symbolsStub,
          contextualChunks: { mode: "off" },
        }),
      };
    }

    async function seedDocument(id: string, autoApproveTrusted: boolean): Promise<void> {
      const storagePath = `mem://${id}`;
      blobs.set(storagePath, Buffer.from(TEXT, "utf8"));
      await db.document.create({
        data: {
          id,
          projectId: PROJECT,
          filename: "salary-bands.md",
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(TEXT),
          storagePath,
          checksum: id,
          status: "pending",
          uploadedById: USER,
          autoApproveTrusted,
        },
      });
    }

    const restrict = (documentId: string, aclSubjects: AclSubject[]) => async () => {
      await saveDocumentAcl({ documentId, projectId: PROJECT, aclSubjects });
    };
    const documentAcl = async (id: string) =>
      (await db.document.findUniqueOrThrow({ where: { id } })).aclSubjects;
    const metaAcl = (metadata: string | null) =>
      JSON.parse(metadata ?? "{}").aclSubjects as AclSubject[] | undefined;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2435-ingest-acl");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: "U", email: "u2435@example.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: "P", slug: "p-2435", createdById: USER },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      await db.knowledgeChunk.deleteMany({});
      await db.quarantineChunk.deleteMany({});
      await db.document.deleteMany({});
      vectorRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2435-vectors-"));
    });

    afterEach(() => {
      rmSync(vectorRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a restriction saved mid-ingest stands on the document and on every indexed chunk", async () => {
      await seedDocument("doc-auto", true);
      const { knowledge } = service(restrict("doc-auto", RESTRICTED));

      const result = await knowledge.ingestDocument("doc-auto");

      expect(result.status).toBe("ready");
      expect(result.chunkCount).toBeGreaterThan(1);
      expect(await documentAcl("doc-auto")).toBe(JSON.stringify(RESTRICTED));
      const chunks = await db.knowledgeChunk.findMany({ where: { documentId: "doc-auto" } });
      expect(chunks).toHaveLength(result.chunkCount);
      for (const c of chunks) {
        expect(c.aclSubjects).toBe(JSON.stringify(RESTRICTED));
        expect(metaAcl(c.metadata)).toEqual(RESTRICTED);
      }
      // What a reader is handed: another member's search finds nothing, alice's finds it.
      const bob = await knowledge.search(PROJECT, "salary bands", {
        k: 10,
        actor: { userId: "bob", role: "viewer" },
      });
      expect(bob.hits).toEqual([]);
      const alice = await knowledge.search(PROJECT, "salary bands", {
        k: 10,
        actor: { userId: "alice", role: "viewer" },
      });
      expect(alice.hits.length).toBeGreaterThan(0);
    });

    it("parked for review: the quarantine chunks carry the edit, and approval applies the ACL held then", async () => {
      await seedDocument("doc-review", false);
      const { knowledge, store, bm25 } = service(restrict("doc-review", RESTRICTED));

      await knowledge.ingestDocument("doc-review");

      const doc = await db.document.findUniqueOrThrow({ where: { id: "doc-review" } });
      expect(doc.indexState).toBe("quarantined");
      expect(doc.aclSubjects).toBe(JSON.stringify(RESTRICTED));
      const parked = await db.quarantineChunk.findMany({
        where: { documentId: "doc-review", ord: { gte: 0 } },
      });
      expect(parked.length).toBeGreaterThan(1);
      for (const q of parked) expect(metaAcl(q.metadata)).toEqual(RESTRICTED);

      // Edited again while it waits for review: approval indexes under that list.
      await saveDocumentAcl({ documentId: "doc-review", projectId: PROJECT, aclSubjects: LATER });
      await approveDocument("doc-review", { id: USER }, { vectorStore: store, bm25 });

      const chunks = await db.knowledgeChunk.findMany({ where: { documentId: "doc-review" } });
      expect(chunks).toHaveLength(parked.length);
      for (const c of chunks) {
        expect(c.aclSubjects).toBe(JSON.stringify(LATER));
        expect(metaAcl(c.metadata)).toEqual(LATER);
      }
    });

    it("an edit that lands while approval writes the external stores stands on every chunk", async () => {
      await seedDocument("doc-race", false);
      const { knowledge, store, bm25 } = service();
      await knowledge.ingestDocument("doc-race");
      expect(await documentAcl("doc-race")).toBe("[]");

      // Approval read the document already; the save lands during its vector write,
      // before its chunk rows exist, so the save itself updates no chunk.
      let raced = false;
      const racingStore = Object.assign(Object.create(store) as typeof store, {
        upsert: async (...args: Parameters<typeof store.upsert>) => {
          if (!raced) {
            raced = true;
            await saveDocumentAcl({
              documentId: "doc-race",
              projectId: PROJECT,
              aclSubjects: RESTRICTED,
            });
          }
          return store.upsert(...args);
        },
      });
      await approveDocument("doc-race", { id: USER }, { vectorStore: racingStore, bm25 });

      expect(raced).toBe(true);
      expect(await documentAcl("doc-race")).toBe(JSON.stringify(RESTRICTED));
      const chunks = await db.knowledgeChunk.findMany({ where: { documentId: "doc-race" } });
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.aclSubjects).toBe(JSON.stringify(RESTRICTED));
        expect(metaAcl(c.metadata)).toEqual(RESTRICTED);
      }
    });

    it("a caller that names the ACL (docs-gen publication) still sets it", async () => {
      await seedDocument("doc-owned", false);
      await writeQuarantine({
        documentId: "doc-owned",
        projectId: PROJECT,
        filename: "salary-bands.md",
        chunks: [{ ord: 0, text: "band A", md5: "m", embedding: bow("band A") }],
        embeddingModel: "bow-2435",
        aclSubjects: RESTRICTED,
      });

      expect(await documentAcl("doc-owned")).toBe(JSON.stringify(RESTRICTED));
      const parked = await db.quarantineChunk.findMany({
        where: { documentId: "doc-owned", ord: { gte: 0 } },
      });
      expect(parked.map((q) => metaAcl(q.metadata))).toEqual([RESTRICTED]);
    });
  },
);
