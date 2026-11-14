/**
 * #2346 — rename-stable symbol vectors, measured on a fixture repository
 * through the real ingest and the real embed job, against a real SQLite
 * database and the local vector store.
 *
 * Ingest gives every symbol of a re-parsed file a NEW id, and the embedding
 * text names the file (`function f in src/a.ts`, plus a `package:` line of the
 * directory), so before #2346 a pure rename or move re-embedded every symbol
 * of the file. The "today" arm measures that: it runs the same job on a store
 * that cannot read a stored vector back, which is exactly the pipeline before
 * the change. The other arm is production's store.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
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
const { embedProjectSymbols, createSymbolVectorStore } =
  await import("../src/lib/code-graph/symbol-embedding-service.js");
const { LocalVectorStore } = await import("../src/lib/rag/vector-store.js");
const { MemoryReindexLeaseBackend } = await import("../src/lib/rag/reindex-lease.js");
const { createDefaultCodeSearcher, createDefaultSymbolLineLookup, createRunScopedSymbolIndex } =
  await import("../src/lib/code-graph/project-code-searcher.js");
const { createSearchSymbolsTool } = await import("../src/lib/analysis/tools/search-symbols.js");
const { loadCodeVersions } = await import("../src/lib/code-graph/code-version.js");

const USER = "u-2346";
const MODEL = "test-embed-2346";
const DIM = 16;

/** A deterministic vector per text, so a reused vector is recognisable. */
function vectorOf(text: string): number[] {
  const digest = createHash("sha256").update(text).digest();
  return Array.from({ length: DIM }, (_, i) => (digest[i]! - 127.5) / 127.5);
}

/** Counts every text embedded. */
function countingEmbedder() {
  const embedded: string[] = [];
  return {
    embedded,
    async embed(texts: string[]) {
      embedded.push(...texts);
      return { vectors: texts.map(vectorOf), model: MODEL, dimension: DIM };
    },
  };
}

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
  "src/billing/tax.ts": [
    "export function taxOf(amount: number): number {",
    "  return amount * 0.2;",
    "}",
    "",
  ].join("\n"),
  "internal/reader/feed.go": [
    "package reader",
    "",
    "func ParseFeed(body string) string {",
    "\treturn body",
    "}",
    "",
  ].join("\n"),
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2346 — a renamed or moved file re-uses its symbols' vectors (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2346-rename-vectors");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-2346-"));
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    /** A project with the fixture tree ingested and embedded. */
    const fixture = async (opts: { reuse: boolean }) => {
      seq += 1;
      const project = await db.project.create({
        data: { name: `p2346-${seq}`, slug: `p2346-${seq}`, createdById: USER },
      });
      const repo = await db.repoConnection.create({
        data: { projectId: project.id, label: `r2346-${seq}`, ownerOrOrg: "o", repoName: "r" },
      });
      const root = path.join(scratch, `tree-${seq}`);
      for (const [rel, body] of Object.entries(TREE)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), body);
      }
      const local = new LocalVectorStore({ root: path.join(scratch, `vectors-${seq}`) });
      // "Today": the same store with no way to read a stored vector back.
      const store = opts.reuse
        ? local
        : (Object.assign(Object.create(Object.getPrototypeOf(local)), local, {
            getRows: undefined,
          }) as typeof local);
      const leaseBackend = new MemoryReindexLeaseBackend();
      const ingest = () =>
        ingestCodeGraph(db, { projectId: project.id, rootDir: root, repoConnectionId: repo.id });
      const embed = async () => {
        const embedder = countingEmbedder();
        const result = await embedProjectSymbols(project.id, {
          store,
          embedService: embedder,
          model: () => MODEL,
          leaseBackend,
        });
        return { result, embedded: embedder.embedded };
      };
      await ingest();
      const first = await embed();
      return { projectId: project.id, root, store: local, ingest, embed, first };
    };

    const move = async (root: string, from: string, to: string) => {
      await fs.mkdir(path.dirname(path.join(root, to)), { recursive: true });
      await fs.rename(path.join(root, from), path.join(root, to));
    };

    it("measures today: a pure rename re-embeds every symbol of the file", async () => {
      const f = await fixture({ reuse: false });
      const symbolsInFile = await db.codeSymbol.count({
        where: { projectId: f.projectId, filePath: "src/billing/invoice.ts" },
      });
      expect(symbolsInFile).toBeGreaterThan(1);

      await move(f.root, "src/billing/invoice.ts", "src/billing/invoices.ts");
      await f.ingest();
      const after = await f.embed();

      expect(after.result.reused).toBe(0);
      expect(after.result.embedded).toBe(symbolsInFile);
      expect(after.embedded.every((t) => t.includes("src/billing/invoices.ts"))).toBe(true);
    });

    it("a rename within a directory embeds nothing and moves every vector to the new symbol ids", async () => {
      const f = await fixture({ reuse: true });
      expect(f.first.result.embedded).toBeGreaterThan(0);
      const symbolsInFile = await db.codeSymbol.count({
        where: { projectId: f.projectId, filePath: "src/billing/invoice.ts" },
      });

      await move(f.root, "src/billing/invoice.ts", "src/billing/invoices.ts");
      await f.ingest();
      const after = await f.embed();

      expect(after.embedded).toEqual([]);
      expect(after.result).toMatchObject({ embedded: 0, reused: symbolsInFile });

      // Every symbol of the moved file is tagged at the model with its NEW
      // text, and has a vector under its own id whose file is the new path.
      const rows = await db.codeSymbolEmbedding.findMany({
        where: { projectId: f.projectId, symbol: { filePath: "src/billing/invoices.ts" } },
        select: { symbolId: true, text: true, embeddingModel: true },
      });
      expect(rows).toHaveLength(symbolsInFile);
      const stored = await f.store.getRows(
        `${f.projectId}__symbols`,
        rows.map((r) => r.symbolId),
      );
      expect(stored).toHaveLength(symbolsInFile);
      for (const r of rows) {
        expect(r.embeddingModel).toBe(MODEL);
        expect(r.text).toContain("in src/billing/invoices.ts");
        const v = stored.find((s) => s.id === r.symbolId)!;
        expect(v.metadata.filename).toBe("src/billing/invoices.ts");
        expect(v.metadata.text).toBe(r.text);
      }
      // The old ids' vectors are gone: nothing is left without a symbol.
      const refs = await f.store.listChunkRefs(`${f.projectId}__symbols`);
      const live = await db.codeSymbolEmbedding.count({ where: { projectId: f.projectId } });
      expect(refs).toHaveLength(live);

      // A second run has nothing to do.
      const again = await f.embed();
      expect(again.embedded).toEqual([]);
      expect(again.result).toMatchObject({ embedded: 0, reused: 0, deleted: 0 });
    });

    it("a move to another directory (its package line changes) embeds nothing", async () => {
      const f = await fixture({ reuse: true });
      await move(f.root, "src/billing/tax.ts", "src/finance/tax.ts");
      await f.ingest();
      const text = await db.codeSymbolEmbedding.findFirst({
        where: {
          projectId: f.projectId,
          symbol: { filePath: "src/finance/tax.ts", name: "taxOf" },
        },
        select: { text: true },
      });
      expect(text?.text).toContain("package: finance");

      const after = await f.embed();
      expect(after.embedded).toEqual([]);
      expect(after.result.reused).toBeGreaterThan(0);
    });

    it("a Go file moved under its declared package embeds nothing", async () => {
      const f = await fixture({ reuse: true });
      await move(f.root, "internal/reader/feed.go", "internal/fetcher/feed.go");
      await f.ingest();
      const after = await f.embed();
      expect(after.embedded).toEqual([]);
      expect(after.result.reused).toBeGreaterThan(0);
    });

    it("an edited symbol is embedded; its unchanged neighbours in the file are not", async () => {
      const f = await fixture({ reuse: true });
      const file = path.join(f.root, "src/billing/invoice.ts");
      await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("a + b, 0", "a + b, 100"));
      await f.ingest();
      const after = await f.embed();
      // `totalOf` and the file's module symbol (whose text is the file's first
      // lines) changed; `InvoicePrinter` and `print` did not.
      expect(after.embedded.map((t) => t.split("\n")[0])).toEqual(
        expect.arrayContaining([
          "function totalOf in src/billing/invoice.ts",
          "module invoice.ts in src/billing/invoice.ts",
        ]),
      );
      expect(after.embedded).toHaveLength(2);
      expect(after.result.reused).toBe(2);
    });

    it("after a rename, a vector hit's citation points at the new path", async () => {
      const f = await fixture({ reuse: true });
      await move(f.root, "src/billing/invoice.ts", "src/billing/invoices.ts");
      await f.ingest();
      await f.embed();

      // The query's vector IS the stored vector of `totalOf` (its text at the
      // old path), so the dense branch must find it under its new id.
      const oldText = f.first.embedded.find((t) => t.startsWith("function totalOf"))!;
      const searcher = createDefaultCodeSearcher({
        vectorStore: createSymbolVectorStore({ store: f.store, model: () => MODEL }),
        embedService: {
          embed: async (texts: string[]) => ({
            vectors: texts.map(() => vectorOf(oldText)),
            model: MODEL,
            dimension: DIM,
          }),
        },
        symbolIndex: createRunScopedSymbolIndex(db),
        snippetLookup: null,
      });
      const tool = createSearchSymbolsTool({
        searcher,
        lineLookup: createDefaultSymbolLineLookup(),
        loadVersions: loadCodeVersions,
      });
      const r = await tool.execute({ query: "zzz unrelated words" }, { projectId: f.projectId });
      const cite = r.citations?.find(
        (c) => c.path.endsWith("invoices.ts") && c.matchedBy?.includes("dense"),
      );
      expect(cite).toBeDefined();
      expect(r.citations?.some((c) => c.path === "src/billing/invoice.ts")).toBe(false);
      expect(r.content).toContain("src/billing/invoices.ts:1-3");
    });
  },
);
