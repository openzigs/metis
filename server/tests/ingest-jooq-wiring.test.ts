/**
 * Issue #897 (Epic #883) — guards that jOOQ table-class lineage extraction is
 * WIRED into the ingest pipeline. The extractor itself (`jooq-extractor.ts`)
 * is covered by `jooq-extractor.test.ts`; this test covers the seam — ingest
 * turning captured generated table-class files + application call sites into
 * schema-graph edges. Mirrors the ORM/MyBatis wiring guards
 * (`ingest-orm-wiring.test.ts`, `ingest-mybatis-wiring.test.ts`).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractJooqSchema,
  ingestCodeGraph,
  type IngestStats,
} from "../src/lib/code-graph/ingest.js";

const FIX = join(__dirname, "fixtures", "jooq");
const bookSrc = readFileSync(join(FIX, "Book.java"), "utf8");
const bookDaoSrc = readFileSync(join(FIX, "BookDao.java"), "utf8");

function fakePrisma(existingSymbols: any[] = []) {
  const symbols: any[] = [];
  const edges: any[] = [];
  let n = 0;
  const prisma = {
    codeSymbol: {
      create: vi.fn(async ({ data }: any) => {
        symbols.push(data);
        return { id: `${data.kind}-${++n}` };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const kinds: string[] = where?.kind?.in ?? [];
        const paths: string[] | undefined = where?.filePath?.in;
        return existingSymbols.filter(
          (s) => kinds.includes(s.kind) && (!paths || paths.includes(s.filePath)),
        );
      }),
    },
    codeEdge: {
      create: vi.fn(async ({ data }: any) => {
        edges.push(data);
        return undefined;
      }),
    },
  };
  return { prisma, symbols, edges };
}

const stats = (): IngestStats => ({ schemaEdges: 0 }) as unknown as IngestStats;

// Simulated persisted method symbols for BookDao.java (line ranges wide enough
// to cover the fixture's four DSL call sites — mirrors how persistParsed would
// have already stored them by the time Step 5d runs).
const bookDaoMethodSymbols = [
  {
    id: "m-findAllBooks",
    kind: "method",
    filePath: "src/BookDao.java",
    startLine: 10,
    endLine: 12,
  },
  { id: "m-createBook", kind: "method", filePath: "src/BookDao.java", startLine: 14, endLine: 16 },
  { id: "m-renameBook", kind: "method", filePath: "src/BookDao.java", startLine: 18, endLine: 20 },
  { id: "m-deleteBook", kind: "method", filePath: "src/BookDao.java", startLine: 22, endLine: 24 },
];

describe("extractJooqSchema wiring (#897)", () => {
  it("is a no-op with no jOOQ sources (no writes, no reads)", async () => {
    const { prisma, symbols, edges } = fakePrisma();
    await extractJooqSchema(prisma as never, "g1", "p1", new Map(), [], stats());
    expect(symbols).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(prisma.codeSymbol.create).not.toHaveBeenCalled();
    expect(prisma.codeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("is a no-op when generated classes are captured but no call site references them", async () => {
    const { prisma, symbols, edges } = fakePrisma();
    await extractJooqSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["src/tables/Book.java", bookSrc]]),
      [{ filePath: "src/tables/Book.java", language: "java" }] as never,
      stats(),
      new Map([["src/tables/Book.java", bookSrc]]),
    );
    expect(symbols).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("turns a captured generated table class + application call sites into reads/writes edges", async () => {
    const { prisma, symbols, edges } = fakePrisma(bookDaoMethodSymbols);
    const s = stats();
    await extractJooqSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([
        ["src/tables/Book.java", bookSrc],
        ["src/BookDao.java", bookDaoSrc],
      ]),
      [
        { filePath: "src/tables/Book.java", language: "java" },
        { filePath: "src/BookDao.java", language: "java" },
      ] as never,
      s,
      new Map([
        ["src/tables/Book.java", bookSrc],
        ["src/BookDao.java", bookDaoSrc],
      ]),
    );
    // No symbol/edge for the untouched generated class file — only the resolved
    // table (lazily materialized at the call site) plus the edges.
    expect(symbols.map((x: any) => x.kind).sort()).toEqual(["table"]);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e: any) => e.source === "jooq")).toBe(true);
    expect(s.schemaEdges).toBe(edges.length);
  });

  it("skips call sites with no enclosing persisted method symbol", async () => {
    const { prisma, edges } = fakePrisma(); // no existing method symbols
    await extractJooqSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([
        ["src/tables/Book.java", bookSrc],
        ["src/BookDao.java", bookDaoSrc],
      ]),
      [
        { filePath: "src/tables/Book.java", language: "java" },
        { filePath: "src/BookDao.java", language: "java" },
      ] as never,
      stats(),
      new Map([
        ["src/tables/Book.java", bookSrc],
        ["src/BookDao.java", bookDaoSrc],
      ]),
    );
    expect(edges).toHaveLength(0);
  });

  it("prewarms existing table/column symbols so ids stay stable across ingests", async () => {
    const { prisma, symbols } = fakePrisma([
      { id: "stable-book", kind: "table", qualifiedName: "book" },
      ...bookDaoMethodSymbols,
    ]);
    await extractJooqSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([
        ["src/tables/Book.java", bookSrc],
        ["src/BookDao.java", bookDaoSrc],
      ]),
      [
        { filePath: "src/tables/Book.java", language: "java" },
        { filePath: "src/BookDao.java", language: "java" },
      ] as never,
      stats(),
      new Map([
        ["src/tables/Book.java", bookSrc],
        ["src/BookDao.java", bookDaoSrc],
      ]),
    );
    // The prewarmed id was reused — no new table symbol created.
    expect(symbols.some((x: any) => x.kind === "table")).toBe(false);
  });

  it("never throws when persistence fails — a jOOQ problem must not fail ingest", async () => {
    const { prisma } = fakePrisma(bookDaoMethodSymbols);
    prisma.codeEdge.create = vi.fn(async () => {
      throw new Error("db down");
    }) as never;
    const s = stats();
    await expect(
      extractJooqSchema(
        prisma as never,
        "g1",
        "p1",
        new Map([
          ["src/tables/Book.java", bookSrc],
          ["src/BookDao.java", bookDaoSrc],
        ]),
        [
          { filePath: "src/tables/Book.java", language: "java" },
          { filePath: "src/BookDao.java", language: "java" },
        ] as never,
        s,
        new Map([
          ["src/tables/Book.java", bookSrc],
          ["src/BookDao.java", bookDaoSrc],
        ]),
      ),
    ).resolves.toBeUndefined();
    expect(s.schemaEdges).toBe(0);
  });
});

/** Minimal in-memory Prisma covering exactly the surface a jOOQ-only ingest touches. */
function fakeIngestPrisma() {
  const created: any[] = [];
  const edgesCreated: any[] = [];
  let n = 0;
  const graph = { id: "cg1" };
  const prisma = {
    // #16 — persistParsed batches per-file writes in a transaction.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    codeGraph: {
      findFirst: async () => null,
      create: async () => graph,
      update: async () => graph,
    },
    codeSymbol: {
      findMany: async ({ where }: any = {}) =>
        created.filter(
          (s) =>
            (!where?.kind?.in || where.kind.in.includes(s.kind)) &&
            (!where?.filePath?.in || where.filePath.in.includes(s.filePath)),
        ),
      findFirst: async () => null,
      create: async ({ data }: any) => {
        const row = { ...data, id: `s${++n}` };
        created.push(row);
        return { id: row.id };
      },
      deleteMany: async () => ({ count: 0 }),
      count: async () => created.length,
      groupBy: async () => [],
    },
    codeEdge: {
      createMany: async ({ data }: any) => {
        for (const d of data) await prisma.codeEdge.create({ data: d });
        return { count: data.length };
      },
      create: async ({ data }: any = {}) => {
        edgesCreated.push(data);
        return undefined;
      },
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
    codeSymbolEmbedding: { createMany: async () => ({ count: 0 }) },
    finding: { create: async () => ({}), findFirst: async () => null },
  };
  return { prisma, created, edgesCreated };
}

describe("ingestCodeGraph wires jOOQ call-site extraction end-to-end (#897)", () => {
  it("a Java DAO method calling ctx.select().from(BOOK) gets a reads edge to the book table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jooq-ingest-"));
    writeFileSync(join(dir, "Book.java"), bookSrc);
    writeFileSync(join(dir, "BookDao.java"), bookDaoSrc);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // The REAL parsed method symbol for findAllBooks, persisted by persistParsed.
    const fn = created.find((s) => s.kind === "method" && s.name === "findAllBooks");
    expect(fn).toBeDefined();
    const table = created.find((s) => s.kind === "table" && s.name === "book");
    expect(table).toBeDefined();
    // The #897 edge: application code -> table, kind reads, source jooq. Remove
    // the extractJooqSchema call from ingestCodeGraph and this fails (the
    // neuter-and-red reachability guard).
    const edge = edgesCreated.find(
      (e) =>
        e.kind === "reads" &&
        e.source === "jooq" &&
        e.fromSymbolId === fn?.id &&
        e.toSymbolId === table?.id,
    );
    expect(edge).toBeDefined();

    // A write op (insertInto) resolves too.
    const createFn = created.find((s) => s.kind === "method" && s.name === "createBook");
    const writeEdge = edgesCreated.find(
      (e) => e.kind === "writes" && e.source === "jooq" && e.fromSymbolId === createFn?.id,
    );
    expect(writeEdge).toBeDefined();
  });

  it("a repo with generated table classes but no application call sites produces zero jOOQ edges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jooq-ingest-unused-"));
    writeFileSync(join(dir, "Book.java"), bookSrc);
    const { prisma, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    expect(edgesCreated.filter((e) => e.source === "jooq")).toHaveLength(0);
  });
});
