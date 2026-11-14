/**
 * #2346 — the symbol index's consistency check and repair, and the per-file
 * outline, against a REAL SQLite database built from the migration chain, a
 * real code-graph ingest of a fixture repository, the real embed job and the
 * local vector store. Each inconsistency is injected into the stores the way
 * a crash or a hand on one store leaves it, then read back through the check,
 * the index status (#2326) and the repair.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});

vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

vi.mock("../src/lib/code-graph/sql-lineage-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/code-graph/sql-lineage-client.js")>();
  return { ...actual, isSqlLineageEnabled: () => false };
});

const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
const { embedProjectSymbols, symbolVectorsId } =
  await import("../src/lib/code-graph/symbol-embedding-service.js");
const consistency = await import("../src/lib/code-graph/index-consistency.js");
const { LocalVectorStore } = await import("../src/lib/rag/vector-store.js");
const { MemoryReindexLeaseBackend } = await import("../src/lib/rag/reindex-lease.js");
const { tryAcquireConnectorIngest } = await import("../src/lib/connectors/ingest-guard.js");
const { loadProjectIndexStatus, formatIndexStatus } = await import("../src/lib/ai/index-status.js");
const { createFileOutlineTool } = await import("../src/lib/analysis/tools/file-outline.js");
const { codeAccessFilterOf, UNRESTRICTED_CODE_ACCESS } =
  await import("../src/lib/analysis/tools/code-access.js");
const { loadCodeVersions } = await import("../src/lib/code-graph/code-version.js");

const USER = "u-2346h";
const MODEL = "test-embed-2346";
const SHA = "703fe82693ef91054f1163435e2495ed118b3f25";
const OTHER_SHA = "c4d54f87a81b30aa173fddf05d7ff83ae7da5796";

const embedService = {
  async embed(texts: string[]) {
    return { vectors: texts.map((t) => [t.length % 7, 1, 2, 3]), model: MODEL, dimension: 4 };
  },
};

const TREE: Record<string, string> = {
  "src/billing/invoice.ts": [
    "export function totalOf(lines: number[]): number {",
    "  return lines.reduce((a, b) => a + b, 0);",
    "}",
    "",
    "export class InvoicePrinter {",
    "  print(total: number): string {",
    "    return `total ${total}`;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/billing/empty.ts": "// nothing declared here\nconst x = 1;\n",
  "README.md": "# fixture\n",
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2346 — index housekeeping (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2346-housekeeping");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-2346h-"));
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    const fixture = async () => {
      seq += 1;
      const project = await db.project.create({
        data: { name: `p2346h-${seq}`, slug: `p2346h-${seq}`, createdById: USER },
      });
      const repo = await db.repoConnection.create({
        data: {
          projectId: project.id,
          label: `r2346h-${seq}`,
          provider: "github",
          ownerOrOrg: "acme",
          repoName: "billing",
        },
      });
      const root = path.join(scratch, `tree-${seq}`);
      for (const [rel, body] of Object.entries(TREE)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), body);
      }
      await ingestCodeGraph(db, {
        projectId: project.id,
        rootDir: root,
        repoConnectionId: repo.id,
        commitSha: SHA,
      });
      const store = new LocalVectorStore({ root: path.join(scratch, `vectors-${seq}`) });
      const deps = {
        store,
        embedService,
        model: () => MODEL,
        leaseBackend: new MemoryReindexLeaseBackend(),
      };
      await embedProjectSymbols(project.id, deps);
      return {
        projectId: project.id,
        repoId: repo.id,
        store,
        deps,
        ns: symbolVectorsId(project.id),
      };
    };

    const summary = async (projectId: string, store: InstanceType<typeof LocalVectorStore>) =>
      consistency.summarizeConsistency(
        await consistency.checkIndexConsistency(projectId, { store }),
      );

    const clean = {
      orphanVectors: 0,
      missingVectors: 0,
      pendingEmbeddings: 0,
      driftedSymbols: 0,
      driftedGraphs: 0,
    };

    /** Inject one of each inconsistency; returns the symbol whose vector went missing. */
    const breakIt = async (f: Awaited<ReturnType<typeof fixture>>) => {
      const rows = await db.codeSymbolEmbedding.findMany({
        where: { projectId: f.projectId },
        select: { symbolId: true },
        orderBy: { symbolId: "asc" },
      });
      const [missing, pending] = [rows[0]!.symbolId, rows[1]!.symbolId];
      // A vector whose symbol is gone, at the active model and at another one.
      await f.store.upsert(f.ns, [
        {
          id: "ghost",
          vector: [1, 0, 0, 0],
          metadata: {
            chunkId: "ghost",
            documentId: "ghost",
            filename: "src/gone.ts",
            position: 0,
            text: "function gone in src/gone.ts\nreturn 0;",
            embeddingModel: MODEL,
          },
        },
        {
          id: "ghost-old",
          vector: [0, 1, 0, 0],
          metadata: {
            chunkId: "ghost-old",
            documentId: "ghost-old",
            filename: "src/old.ts",
            position: 0,
            text: "old",
            embeddingModel: "an-older-model",
          },
        },
      ]);
      // A row tagged embedded whose vector is gone.
      await f.store.deleteByChunkIds(f.ns, [missing]);
      // A row never embedded (as a fresh ingest leaves it).
      await f.store.deleteByChunkIds(f.ns, [pending]);
      await db.codeSymbolEmbedding.update({
        where: { symbolId: pending },
        data: { embeddingModel: "" },
      });
      // The connector moved on without the graph.
      await db.repoConnection.update({
        where: { id: f.repoId },
        data: { lastCommitSha: OTHER_SHA },
      });
      return { missing, pending };
    };

    it("a freshly indexed project is consistent", async () => {
      const f = await fixture();
      expect(await summary(f.projectId, f.store)).toEqual(clean);
    });

    it("reports each injected inconsistency, read-only", async () => {
      const f = await fixture();
      const { missing } = await breakIt(f);
      const symbols = await db.codeSymbol.count({ where: { projectId: f.projectId } });
      const refsBefore = await f.store.listChunkRefs(f.ns);

      const check = await consistency.checkIndexConsistency(f.projectId, { store: f.store });
      expect(check.orphanVectorIds.sort()).toEqual(["ghost", "ghost-old"]);
      expect(check.missingVectorIds).toEqual([missing]);
      expect(check.pendingEmbeddings).toBe(1);
      expect(check.commitDrift).toEqual([
        { repoConnectionId: f.repoId, graphCommit: SHA, indexedCommit: OTHER_SHA, symbols },
      ]);
      expect(consistency.isConsistent(consistency.summarizeConsistency(check))).toBe(false);

      // Nothing moved.
      expect(await f.store.listChunkRefs(f.ns)).toEqual(refsBefore);
      expect(
        await db.codeSymbolEmbedding.findUnique({ where: { symbolId: missing } }),
      ).toMatchObject({ embeddingModel: MODEL });
    });

    it("--repair re-queues the missing vectors, removes the orphans, and is idempotent", async () => {
      const f = await fixture();
      const { missing, pending } = await breakIt(f);
      const symbols = await db.codeSymbol.count({ where: { projectId: f.projectId } });

      const r = await consistency.repairIndexConsistency(f.projectId, f.deps);
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.before).toEqual({
        orphanVectors: 2,
        missingVectors: 1,
        pendingEmbeddings: 1,
        driftedSymbols: symbols,
        driftedGraphs: 1,
      });
      expect(r.requeued).toBe(1);
      expect(r.removedOrphans).toBe(2);
      expect(r.embed?.embedded).toBe(2);
      // Commit drift needs a re-sync: reported, not "repaired".
      expect(r.after).toEqual({ ...clean, driftedSymbols: symbols, driftedGraphs: 1 });

      // Read back through the stores a search uses.
      const refs = new Map((await f.store.listChunkRefs(f.ns)).map((x) => [x.chunkId, x]));
      expect(refs.get(missing)?.embeddingModel).toBe(MODEL);
      expect(refs.get(pending)?.embeddingModel).toBe(MODEL);
      expect(refs.has("ghost")).toBe(false);
      expect(refs.has("ghost-old")).toBe(false);
      expect(
        await db.codeSymbolEmbedding.findUnique({ where: { symbolId: missing } }),
      ).toMatchObject({ embeddingModel: MODEL });

      const again = await consistency.repairIndexConsistency(f.projectId, f.deps);
      expect(again).toMatchObject({
        status: "repaired",
        requeued: 0,
        removedOrphans: 0,
        embed: null,
        before: r.after,
        after: r.after,
      });
    });

    it("--repair runs the embed job before deleting orphans, so a matching active-model orphan is reused, not re-embedded", async () => {
      const f = await fixture();
      const { symbolId } = await db.codeSymbolEmbedding.findFirstOrThrow({
        where: { projectId: f.projectId },
        select: { symbolId: true },
        orderBy: { symbolId: "asc" },
      });
      // The symbol's vector survives only under an id no row holds (as a crash
      // between a re-ingest's vector write and its row write can leave it).
      const [stored] = await f.store.getRows(f.ns, [symbolId]);
      await f.store.upsert(f.ns, [
        {
          ...stored!,
          id: "orphan-copy",
          metadata: { ...stored!.metadata, chunkId: "orphan-copy" },
        },
      ]);
      await f.store.deleteByChunkIds(f.ns, [symbolId]);
      const r = await consistency.repairIndexConsistency(f.projectId, f.deps);
      expect(r).toMatchObject({ status: "repaired", requeued: 1, removedOrphans: 1 });
      if (r.status !== "repaired") return;
      expect(r.embed).toMatchObject({ reused: 1, embedded: 0 });
      const refs = new Map((await f.store.listChunkRefs(f.ns)).map((x) => [x.chunkId, x]));
      expect(refs.get(symbolId)?.embeddingModel).toBe(MODEL);
      expect(refs.has("orphan-copy")).toBe(false);
    });

    it("a row tagged at one model whose vector is another model's is missing its vector", async () => {
      const f = await fixture();
      const row = await db.codeSymbolEmbedding.findFirstOrThrow({
        where: { projectId: f.projectId },
        select: { symbolId: true },
      });
      const [stored] = await f.store.getRows(f.ns, [row.symbolId]);
      await f.store.upsert(f.ns, [
        { ...stored!, metadata: { ...stored!.metadata, embeddingModel: "an-older-model" } },
      ]);
      const check = await consistency.checkIndexConsistency(f.projectId, { store: f.store });
      expect(check.missingVectorIds).toEqual([row.symbolId]);
      expect(check.orphanVectorIds).toEqual([]);
    });

    it("a repair whose embed fails leaves the re-queued rows PENDING, never claiming a vector", async () => {
      const f = await fixture();
      const { missing } = await breakIt(f);
      await expect(
        consistency.repairIndexConsistency(f.projectId, {
          ...f.deps,
          embed: () => Promise.reject(new Error("embedder down")),
        }),
      ).rejects.toThrow("embedder down");
      expect(
        await db.codeSymbolEmbedding.findUnique({ where: { symbolId: missing } }),
      ).toMatchObject({ embeddingModel: "" });
      const after = await summary(f.projectId, f.store);
      expect(after).toMatchObject({ missingVectors: 0, pendingEmbeddings: 2 });
      // The leases were released on the way out.
      const free = tryAcquireConnectorIngest(f.repoId, "after a failed repair");
      expect(free).not.toBeNull();
      free?.release();
    });

    it("--repair refuses, changing nothing, while a connector of the project is being ingested", async () => {
      const f = await fixture();
      await breakIt(f);
      const lease = tryAcquireConnectorIngest(f.repoId, "a running sync")!;
      try {
        const before = await summary(f.projectId, f.store);
        expect(await consistency.repairIndexConsistency(f.projectId, f.deps)).toEqual({
          status: "ingest-in-progress",
          connectorIds: [f.repoId],
        });
        expect(await summary(f.projectId, f.store)).toEqual(before);
      } finally {
        lease.release();
      }
      // The repair released nothing it did not take, and holds nothing after.
      const after = tryAcquireConnectorIngest(f.repoId, "next sync");
      expect(after).not.toBeNull();
      after?.release();
    });

    /** The persisted state a source ingest writes when it starts (#182), as another process sees it. */
    const recordedIngest = (status: string, heartbeatAt: Date) =>
      JSON.stringify({
        version: 1,
        runId: "run-2346",
        status,
        startedAt: heartbeatAt.toISOString(),
        heartbeatAt: heartbeatAt.toISOString(),
        finishedAt: null,
      });

    it("--repair refuses, changing nothing, while the database records a running ingest of the project (any process)", async () => {
      const f = await fixture();
      await breakIt(f);
      // No lease in this process: the ingest runs in the API server.
      await db.repoConnection.update({
        where: { id: f.repoId },
        data: { sourceIngestState: recordedIngest("running", new Date()) },
      });
      const before = await summary(f.projectId, f.store);
      expect(await consistency.repairIndexConsistency(f.projectId, f.deps)).toEqual({
        status: "ingest-in-progress",
        connectorIds: [f.repoId],
      });
      expect(await summary(f.projectId, f.store)).toEqual(before);
      const free = tryAcquireConnectorIngest(f.repoId, "next sync");
      expect(free).not.toBeNull();
      free?.release();
    });

    it("a recorded run whose heartbeat went stale (its process died) does not block the repair", async () => {
      const f = await fixture();
      await breakIt(f);
      await db.repoConnection.update({
        where: { id: f.repoId },
        data: {
          sourceIngestState: recordedIngest("running", new Date(Date.now() - 60 * 60 * 1000)),
        },
      });
      expect((await consistency.repairIndexConsistency(f.projectId, f.deps)).status).toBe(
        "repaired",
      );
    });

    it("a finished recorded run, or one on a deleted connection, does not block the repair", async () => {
      const f = await fixture();
      await breakIt(f);
      await db.repoConnection.update({
        where: { id: f.repoId },
        data: { sourceIngestState: recordedIngest("completed", new Date()) },
      });
      const gone = await db.repoConnection.create({
        data: {
          projectId: f.projectId,
          label: "deleted",
          provider: "github",
          ownerOrOrg: "acme",
          repoName: "gone",
          deletedAt: new Date(),
          sourceIngestState: recordedIngest("running", new Date()),
        },
      });
      expect((await consistency.repairIndexConsistency(f.projectId, f.deps)).status).toBe(
        "repaired",
      );
      expect(gone.id).not.toBe(f.repoId);
    });

    it("the check lists the vectors through the store's id-and-model listing when it has one", async () => {
      const f = await fixture();
      await breakIt(f);
      const listChunkModels = vi.fn((ns: string) =>
        f.store
          .listChunkRefs(ns)
          .then((refs) =>
            refs.map((r) => ({ chunkId: r.chunkId, embeddingModel: r.embeddingModel })),
          ),
      );
      const store = Object.assign(Object.create(f.store) as typeof f.store, {
        listChunkModels,
        listChunkRefs: () => Promise.reject(new Error("reads every vector")),
      });
      const check = await consistency.checkIndexConsistency(f.projectId, { store });
      expect(listChunkModels).toHaveBeenCalledWith(f.ns);
      expect(check.orphanVectorIds.sort()).toEqual(["ghost", "ghost-old"]);
    });

    it("a graph whose connection was deleted is not reported as drifted", async () => {
      const f = await fixture();
      await breakIt(f);
      await db.repoConnection.update({ where: { id: f.repoId }, data: { deletedAt: new Date() } });
      const check = await consistency.checkIndexConsistency(f.projectId, { store: f.store });
      expect(check.commitDrift).toEqual([]);
    });

    it("the repair holds the connector's ingest lease while it runs", async () => {
      const f = await fixture();
      await breakIt(f);
      let heldDuring: boolean | null = null;
      await consistency.repairIndexConsistency(f.projectId, {
        ...f.deps,
        embed: async (projectId, opts) => {
          heldDuring = tryAcquireConnectorIngest(f.repoId, "probe") === null;
          return embedProjectSymbols(projectId, opts);
        },
      });
      expect(heldDuring).toBe(true);
      const free = tryAcquireConnectorIngest(f.repoId, "after");
      expect(free).not.toBeNull();
      free?.release();
    });

    it("the summary is surfaced through the index status (#2326), counts withheld under a restriction", async () => {
      const f = await fixture();
      await breakIt(f);
      const load = () =>
        loadProjectIndexStatus(f.projectId, {
          consistency: () =>
            consistency.loadIndexConsistencySummary(f.projectId, { store: f.store }),
        });
      const status = await load();
      expect(status?.consistency).toMatchObject({ state: "inconsistent" });
      const text = formatIndexStatus(status!);
      expect(text).toContain(
        "Symbol index consistency: inconsistent: 1 code symbol(s) have no vector",
      );
      expect(text).toContain("2 vector(s) belong to no code symbol");
      expect(text).toContain("1 code symbol(s) are not embedded yet");

      // Without the option the status does not run the check at all.
      expect((await loadProjectIndexStatus(f.projectId))?.consistency).toBeUndefined();

      // A restricted repository document: the counts are withheld.
      await db.document.create({
        data: {
          projectId: f.projectId,
          filename: `connector:repo:${f.repoId}:src/src/billing/invoice.ts`,
          source: "repo",
          mimeType: "text/plain",
          sizeBytes: 1,
          storagePath: "x",
          checksum: "x",
          uploadedById: USER,
          aclSubjects: JSON.stringify([{ kind: "user", value: "someone-else" }]),
        },
      });
      const withheld = await load();
      expect(withheld?.consistency).toEqual({ state: "inconsistent", counts: null });
      expect(formatIndexStatus(withheld!)).toContain("counts not shown");

      // A store that cannot be read: said, not thrown.
      const broken = await loadProjectIndexStatus(f.projectId, {
        consistency: () =>
          consistency.loadIndexConsistencySummary(f.projectId, {
            store: {
              listChunkRefs: () => Promise.reject(new Error("lance down")),
            } as unknown as InstanceType<typeof LocalVectorStore>,
          }),
      });
      expect(formatIndexStatus(broken!)).toContain(
        "Symbol index consistency: could not be checked.",
      );
    });

    describe("get_file_outline", () => {
      it("lists a file's symbols with kind, span and parent, in source order, with the citation contract", async () => {
        const f = await fixture();
        const tool = createFileOutlineTool({ loadVersions: loadCodeVersions });
        const r = await tool.execute(
          { path: "./src/billing/invoice.ts" },
          { projectId: f.projectId, codeAccess: UNRESTRICTED_CODE_ACCESS },
        );
        expect(r.isError).toBeUndefined();
        expect(r.content.split("\n")[0]).toContain(SHA.slice(0, 7));
        expect(r.content).toContain("Outline of src/billing/invoice.ts (ts, 3 symbol(s)):");
        const lines = r.content.split("\n").filter((l) => l.trimStart().startsWith("- "));
        expect(lines).toEqual([
          "- function totalOf — src/billing/invoice.ts:1-3",
          "- class InvoicePrinter — src/billing/invoice.ts:5-9",
          "  - method print — src/billing/invoice.ts:6-8 (in InvoicePrinter)",
        ]);
        expect(r.resultCount).toBe(3);
        expect(r.citations).toHaveLength(3);
        expect(r.citations![2]).toMatchObject({
          repoConnectionId: f.repoId,
          path: "src/billing/invoice.ts",
          startLine: 6,
          endLine: 8,
          commitSha: SHA,
          permalink: `https://github.com/acme/billing/blob/${SHA}/src/billing/invoice.ts#L6-L8`,
        });
      });

      it("says so when the file is not in the code graph, by why", async () => {
        const f = await fixture();
        const tool = createFileOutlineTool();
        const md = await tool.execute({ path: "README.md" }, { projectId: f.projectId });
        expect(md).toMatchObject({ resultCount: 0 });
        expect(md.content).toContain(
          "not in this project's code graph: the code graph does not parse files of this type",
        );
        const absent = await tool.execute({ path: "src/nope.ts" }, { projectId: f.projectId });
        expect(absent.content).toContain(
          "not in this project's code graph: no file at this path was indexed",
        );
        expect(absent.content).not.toContain("Outline of");
      });

      it("says a file in the graph that declares nothing declares nothing", async () => {
        const f = await fixture();
        const r = await createFileOutlineTool().execute(
          { path: "src/billing/empty.ts" },
          { projectId: f.projectId },
        );
        expect(r.content).toContain("is in the code graph and declares no functions");
        expect(r.resultCount).toBe(0);
      });

      it("answers a file hidden from the caller exactly as one the graph does not hold", async () => {
        const f = await fixture();
        const hidden = codeAccessFilterOf([
          { connectorId: f.repoId, path: "src/billing/invoice.ts" },
        ]);
        const tool = createFileOutlineTool();
        const r = await tool.execute(
          { path: "src/billing/invoice.ts" },
          { projectId: f.projectId, codeAccess: hidden },
        );
        const absent = await tool.execute(
          { path: "src/billing/invoices.ts" },
          { projectId: f.projectId, codeAccess: hidden },
        );
        expect(r.content).toBe(absent.content.replace("invoices.ts", "invoice.ts"));
        expect(r.citations).toBeUndefined();
      });

      it("never reads another project's graph", async () => {
        const f = await fixture();
        const other = await db.project.create({
          data: { name: "other-2346", slug: "other-2346", createdById: USER },
        });
        const r = await createFileOutlineTool().execute(
          { path: "src/billing/invoice.ts" },
          { projectId: other.id },
        );
        expect(r.content).toContain("not in this project's code graph");
        expect(f.projectId).not.toBe(other.id);
      });

      it.each([
        ["/etc/passwd", "absolute"],
        ["../other/a.ts", "'..'"],
        ["src\\a.ts", "backslash"],
      ])("refuses the path %s", async (p, why) => {
        const r = await createFileOutlineTool().execute({ path: p }, { projectId: "any" });
        expect(r.isError).toBe(true);
        expect(r.content).toContain(why);
      });

      it("refuses a credential file and a missing path", async () => {
        const tool = createFileOutlineTool();
        expect(await tool.execute({ path: ".env" }, { projectId: "any" })).toMatchObject({
          isError: true,
          content: "Error: File not found or not accessible: .env",
        });
        const r = await tool.execute({}, { projectId: "any" });
        expect(r.isError).toBe(true);
        expect(r.content).toContain('"path"');
      });
    });
  },
);
