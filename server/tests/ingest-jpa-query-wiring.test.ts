/**
 * Issue #896 (epic #883) — guards that JPA query-lineage extraction is WIRED
 * into the ingest pipeline. The extractor itself (`extractJpaQueries`/
 * `persistJpaQueryFile`) is covered by `jpa-query-extractor.test.ts`; this
 * test covers the seam — `extractJpaQuerySchema` actually being called from
 * `ingestCodeGraph` — mirroring the ORM (#849/#872) and MyBatis (#884/#887)
 * wiring reachability tests. Remove the `extractJpaQuerySchema` call from
 * `ingestCodeGraph` (or the `persistJpaQueryOriginEdges` hop within it) and
 * the neuter-and-red assertions below fail.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractJpaQuerySchema,
  ingestCodeGraph,
  type IngestStats,
} from "../src/lib/code-graph/ingest.js";

const FIX = join(__dirname, "fixtures", "orm");
const customerJava = readFileSync(join(FIX, "Customer.java"), "utf8");
const repoJava = readFileSync(join(FIX, "CustomerRepository.java"), "utf8");

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

describe("extractJpaQuerySchema wiring (#896)", () => {
  it("turns a captured repository + entity into reads/writes table/column edges", async () => {
    const { prisma, edges } = fakePrisma();
    const s = stats();
    await extractJpaQuerySchema(
      prisma as never,
      "g1",
      "p1",
      new Map([
        ["src/Customer.java", customerJava],
        ["src/CustomerRepository.java", repoJava],
      ]),
      s,
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.source === "orm")).toBe(true);
    expect(edges.some((e) => e.kind === "reads")).toBe(true);
    expect(edges.some((e) => e.kind === "writes")).toBe(true);
    expect(s.schemaEdges).toBeGreaterThan(0);
  });

  it("is a no-op with no .java sources (e.g. only a schema.prisma captured)", async () => {
    const { prisma, edges } = fakePrisma();
    await extractJpaQuerySchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["x.prisma", "model X {}"]]),
      stats(),
    );
    expect(edges).toHaveLength(0);
    expect(prisma.codeSymbol.create).not.toHaveBeenCalled();
  });

  it("never throws when persistence fails — a JPA query-lineage problem must not fail ingest", async () => {
    const { prisma } = fakePrisma();
    prisma.codeSymbol.create = vi.fn(async () => {
      throw new Error("db down");
    }) as never;
    const s = stats();
    await expect(
      extractJpaQuerySchema(
        prisma as never,
        "g1",
        "p1",
        new Map([
          ["src/Customer.java", customerJava],
          ["src/CustomerRepository.java", repoJava],
        ]),
        s,
      ),
    ).resolves.toBeUndefined();
    expect(s.schemaEdges).toBe(0);
  });
});

/** Minimal in-memory Prisma covering exactly the surface a real ingest touches. */
function fakeIngestPrisma() {
  const created: any[] = [];
  const edgesCreated: any[] = [];
  let n = 0;
  const graph = { id: "cg1" };
  const prisma = {
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

describe("ingestCodeGraph wires JPA query-lineage extraction end-to-end (#896)", () => {
  it("resolves a derived-query method to the entity's table/column and connects the REAL method via executes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jpa-query-ingest-"));
    writeFileSync(join(dir, "Customer.java"), customerJava);
    writeFileSync(join(dir, "CustomerRepository.java"), repoJava);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // The REAL parsed interface method symbol for findByEmail, persisted by the Java parser.
    const realMethod = created.find((s) => s.kind === "method" && s.name === "findByEmail");
    expect(realMethod).toBeDefined();
    const table = created.find((s) => s.kind === "table" && s.name === "customers");
    expect(table).toBeDefined();
    const column = created.find((s) => s.kind === "column" && s.name === "email_address");
    expect(column).toBeDefined();

    // Synthetic query-origin symbol carries the reads edges to table + column.
    const origin = created.find(
      (s) => s.kind === "method" && s.qualifiedName?.endsWith("::findByEmail#jpa-query"),
    );
    expect(origin).toBeDefined();
    expect(
      edgesCreated.some(
        (e) => e.kind === "reads" && e.fromSymbolId === origin.id && e.toSymbolId === table.id,
      ),
    ).toBe(true);
    expect(
      edgesCreated.some(
        (e) => e.kind === "reads" && e.fromSymbolId === origin.id && e.toSymbolId === column.id,
      ),
    ).toBe(true);

    // The #896 neuter-and-red hop: the REAL repository method → executes → synthetic origin.
    // Remove persistJpaQueryOriginEdges (or its call site) from extractJpaQuerySchema and this fails.
    expect(
      edgesCreated.some(
        (e) =>
          e.kind === "executes" && e.fromSymbolId === realMethod.id && e.toSymbolId === origin.id,
      ),
    ).toBe(true);
  });

  it("classifies a delete-derived method as writes end-to-end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jpa-query-ingest-writes-"));
    writeFileSync(join(dir, "Customer.java"), customerJava);
    writeFileSync(join(dir, "CustomerRepository.java"), repoJava);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    const table = created.find((s) => s.kind === "table" && s.name === "customers");
    const deleteOrigin = created.find(
      (s) => s.kind === "method" && s.qualifiedName?.endsWith("::deleteByEmail#jpa-query"),
    );
    expect(deleteOrigin).toBeDefined();
    expect(
      edgesCreated.some(
        (e) =>
          e.kind === "writes" && e.fromSymbolId === deleteOrigin.id && e.toSymbolId === table.id,
      ),
    ).toBe(true);
  });

  it("a nativeQuery = true @Query never produces a synthetic origin or schema edge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jpa-query-ingest-native-"));
    writeFileSync(join(dir, "Customer.java"), customerJava);
    writeFileSync(join(dir, "CustomerRepository.java"), repoJava);
    const { prisma, created } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    const nativeOrigin = created.find(
      (s) => s.kind === "method" && s.qualifiedName?.endsWith("::findByEmailNative#jpa-query"),
    );
    expect(nativeOrigin).toBeUndefined();
  });
});
