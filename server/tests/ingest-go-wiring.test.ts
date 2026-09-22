/**
 * Issue #899 (Epic #883) — guards that Go GORM model→physical-table lineage
 * extraction is WIRED into the ingest pipeline. The extractor itself
 * (`gorm-extractor.ts`) is covered by `gorm-extractor.test.ts`; this test
 * covers the seam — ingest turning captured `.go` model structs + application
 * GORM call sites into schema-graph edges. Mirrors the jOOQ wiring guard
 * (`ingest-jooq-wiring.test.ts`). The end-to-end case is a NEUTER-AND-RED
 * reachability guard: remove the `extractGoSchema` call from `ingestCodeGraph`
 * and it goes red.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractGoSchema,
  ingestCodeGraph,
  type IngestStats,
} from "../src/lib/code-graph/ingest.js";

const FIX = join(__dirname, "fixtures", "gorm");
const modelsSrc = readFileSync(join(FIX, "models.go"), "utf8");
const repoSrc = readFileSync(join(FIX, "repo.go"), "utf8");

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

// Simulated persisted function symbols for repo.go (line ranges wide enough to
// cover the fixture's GORM call sites — mirrors how persistParsed would have
// stored them by the time Step 5x runs).
const repoFnSymbols = [
  { id: "fn-FindAllUsers", kind: "function", filePath: "repo.go", startLine: 10, endLine: 14 },
  { id: "fn-CreateUser", kind: "function", filePath: "repo.go", startLine: 17, endLine: 19 },
];

describe("extractGoSchema wiring (#899)", () => {
  it("is a no-op with no Go sources (no writes, no reads)", async () => {
    const { prisma, symbols, edges } = fakePrisma();
    await extractGoSchema(prisma as never, "g1", "p1", new Map(), [], stats());
    expect(symbols).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(prisma.codeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("is a no-op when models are captured but no call site references them", async () => {
    const { prisma, edges } = fakePrisma();
    await extractGoSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["models.go", modelsSrc]]),
      [{ filePath: "models.go", language: "go" }] as never,
      stats(),
      new Map([["models.go", modelsSrc]]),
    );
    expect(edges).toHaveLength(0);
  });

  it("turns captured GORM models + application call sites into reads/writes edges (source orm)", async () => {
    const { prisma, edges } = fakePrisma(repoFnSymbols);
    const s = stats();
    await extractGoSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([
        ["models.go", modelsSrc],
        ["repo.go", repoSrc],
      ]),
      [
        { filePath: "models.go", language: "go" },
        { filePath: "repo.go", language: "go" },
      ] as never,
      s,
      new Map([
        ["models.go", modelsSrc],
        ["repo.go", repoSrc],
      ]),
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e: any) => e.source === "orm")).toBe(true);
    expect(edges.find((e: any) => e.fromSymbolId === "fn-FindAllUsers")?.kind).toBe("reads");
    expect(edges.find((e: any) => e.fromSymbolId === "fn-CreateUser")?.kind).toBe("writes");
    expect(s.schemaEdges).toBe(edges.length);
  });

  it("skips call sites with no enclosing persisted function symbol", async () => {
    const { prisma, edges } = fakePrisma(); // no existing function symbols
    await extractGoSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([
        ["models.go", modelsSrc],
        ["repo.go", repoSrc],
      ]),
      [
        { filePath: "models.go", language: "go" },
        { filePath: "repo.go", language: "go" },
      ] as never,
      stats(),
      new Map([
        ["models.go", modelsSrc],
        ["repo.go", repoSrc],
      ]),
    );
    expect(edges).toHaveLength(0);
  });

  it("never throws when persistence fails — a GORM problem must not fail ingest", async () => {
    const { prisma } = fakePrisma(repoFnSymbols);
    prisma.codeEdge.create = vi.fn(async () => {
      throw new Error("db down");
    }) as never;
    const s = stats();
    await expect(
      extractGoSchema(
        prisma as never,
        "g1",
        "p1",
        new Map([
          ["models.go", modelsSrc],
          ["repo.go", repoSrc],
        ]),
        [
          { filePath: "models.go", language: "go" },
          { filePath: "repo.go", language: "go" },
        ] as never,
        s,
        new Map([
          ["models.go", modelsSrc],
          ["repo.go", repoSrc],
        ]),
      ),
    ).resolves.toBeUndefined();
    expect(s.schemaEdges).toBe(0);
  });
});

/** Minimal in-memory Prisma covering exactly the surface a Go-only ingest touches. */
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

describe("ingestCodeGraph wires Go GORM call-site extraction end-to-end (#899)", () => {
  it("a Go func calling db.Model(&User{}).Find(...) gets a reads edge to the users table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gorm-ingest-"));
    writeFileSync(join(dir, "models.go"), modelsSrc);
    writeFileSync(join(dir, "repo.go"), repoSrc);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // The REAL parsed function symbol for FindAllUsers, persisted by persistParsed.
    const fn = created.find((s) => s.kind === "function" && s.name === "FindAllUsers");
    expect(fn).toBeDefined();
    const table = created.find((s) => s.kind === "table" && s.name === "users");
    expect(table).toBeDefined();
    // The #899 edge: application code -> table, kind reads, source orm. Remove
    // the extractGoSchema call from ingestCodeGraph and this fails (the
    // neuter-and-red reachability guard).
    const edge = edgesCreated.find(
      (e) =>
        e.kind === "reads" &&
        e.source === "orm" &&
        e.fromSymbolId === fn?.id &&
        e.toSymbolId === table?.id,
    );
    expect(edge).toBeDefined();

    // A write op (Create) resolves too.
    const createFn = created.find((s) => s.kind === "function" && s.name === "CreateUser");
    const writeEdge = edgesCreated.find(
      (e) => e.kind === "writes" && e.source === "orm" && e.fromSymbolId === createFn?.id,
    );
    expect(writeEdge).toBeDefined();
  });

  it("a repo with GORM models but no application call sites produces zero GORM edges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gorm-ingest-unused-"));
    writeFileSync(join(dir, "models.go"), modelsSrc);
    const { prisma, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    expect(edgesCreated.filter((e) => e.source === "orm")).toHaveLength(0);
  });
});
