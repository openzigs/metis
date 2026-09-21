/**
 * Issue #898 (Epic #883) — guards that SQLAlchemy Core/ORM query-lineage
 * extraction is WIRED into the ingest pipeline, and that raw psycopg string SQL
 * still reaches the schema graph through the sqlglot sidecar path. The extractor
 * itself is covered by `sqlalchemy-extractor.test.ts`; this test covers the seam
 * (`extractSqlAlchemySchema` actually being called from `ingestCodeGraph`),
 * mirroring the jOOQ/ORM/MyBatis wiring reachability tests. Remove the
 * `extractSqlAlchemySchema` call from `ingestCodeGraph` and the neuter-and-red
 * assertions below fail.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractSqlAlchemySchema,
  ingestCodeGraph,
  type IngestStats,
} from "../src/lib/code-graph/ingest.js";
import { extractEmbeddedSql } from "../src/lib/code-graph/embedded-sql-extractor.js";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";
import type {
  ExtractUsageParams,
  ExtractUsageResult,
  SqlLineageClient,
} from "../src/lib/code-graph/sql-lineage-client.js";

const FIX = join(__dirname, "fixtures", "sqlalchemy");
const modelsPy = readFileSync(join(FIX, "models.py"), "utf8");
const queriesPy = readFileSync(join(FIX, "queries.py"), "utf8");

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

// A wide persisted function symbol spanning the whole queries fixture — mirrors
// how persistParsed would have stored the DAO functions by the time Step 5e runs.
const queryFnSymbols = [
  { id: "fn-queries", kind: "function", filePath: "queries.py", startLine: 1, endLine: 400 },
];

describe("extractSqlAlchemySchema wiring (#898)", () => {
  it("is a no-op with no Python sources", async () => {
    const { prisma, symbols, edges } = fakePrisma();
    await extractSqlAlchemySchema(prisma as never, "g1", "p1", new Map(), [], stats());
    expect(symbols).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(prisma.codeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("is a no-op when models are captured but no call site references them", async () => {
    const { prisma, edges } = fakePrisma();
    await extractSqlAlchemySchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["models.py", modelsPy]]),
      [{ filePath: "models.py", language: "py" }] as never,
      stats(),
      new Map([["models.py", modelsPy]]),
    );
    expect(edges).toHaveLength(0);
  });

  it("turns captured models + query call sites into reads/writes edges (source orm)", async () => {
    const { prisma, edges } = fakePrisma(queryFnSymbols);
    const s = stats();
    await extractSqlAlchemySchema(
      prisma as never,
      "g1",
      "p1",
      new Map([
        ["models.py", modelsPy],
        ["queries.py", queriesPy],
      ]),
      [
        { filePath: "models.py", language: "py" },
        { filePath: "queries.py", language: "py" },
      ] as never,
      s,
      new Map([
        ["models.py", modelsPy],
        ["queries.py", queriesPy],
      ]),
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.source === "orm")).toBe(true);
    expect(edges.some((e) => e.kind === "reads")).toBe(true);
    expect(edges.some((e) => e.kind === "writes")).toBe(true);
    expect(s.schemaEdges).toBe(edges.length);
  });

  it("never throws when persistence fails — a SQLAlchemy problem must not fail ingest", async () => {
    const { prisma } = fakePrisma(queryFnSymbols);
    prisma.codeEdge.create = vi.fn(async () => {
      throw new Error("db down");
    }) as never;
    const s = stats();
    await expect(
      extractSqlAlchemySchema(
        prisma as never,
        "g1",
        "p1",
        new Map([
          ["models.py", modelsPy],
          ["queries.py", queriesPy],
        ]),
        [
          { filePath: "models.py", language: "py" },
          { filePath: "queries.py", language: "py" },
        ] as never,
        s,
        new Map([
          ["models.py", modelsPy],
          ["queries.py", queriesPy],
        ]),
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

describe("ingestCodeGraph wires SQLAlchemy query-lineage end-to-end (#898)", () => {
  it("a Python function calling session.query(User) gets a reads edge to the users table (source orm)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlalchemy-ingest-"));
    writeFileSync(join(dir, "models.py"), modelsPy);
    writeFileSync(join(dir, "queries.py"), queriesPy);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // The REAL parsed function symbol for list_users, persisted by the Py parser.
    const listUsers = created.find((s) => s.kind === "function" && s.name === "list_users");
    expect(listUsers).toBeDefined();
    const usersTable = created.find((s) => s.kind === "table" && s.name === "users");
    expect(usersTable).toBeDefined();

    // The #898 edge: application code -> table, kind reads, source orm. Remove
    // the extractSqlAlchemySchema call from ingestCodeGraph and this fails
    // (the neuter-and-red reachability guard).
    const readEdge = edgesCreated.find(
      (e) =>
        e.kind === "reads" &&
        e.source === "orm" &&
        e.fromSymbolId === listUsers?.id &&
        e.toSymbolId === usersTable?.id,
    );
    expect(readEdge).toBeDefined();

    // A delete() ORM write resolves too.
    const purge = created.find((s) => s.kind === "function" && s.name === "purge_user");
    const writeEdge = edgesCreated.find(
      (e) => e.kind === "writes" && e.source === "orm" && e.fromSymbolId === purge?.id,
    );
    expect(writeEdge).toBeDefined();

    // Core Table lineage resolves too: select(orders) reads, orders.insert() writes.
    const ordersTable = created.find((s) => s.kind === "table" && s.name === "orders");
    expect(ordersTable).toBeDefined();
    const listOrders = created.find((s) => s.kind === "function" && s.name === "list_orders");
    expect(
      edgesCreated.some(
        (e) =>
          e.kind === "reads" &&
          e.source === "orm" &&
          e.fromSymbolId === listOrders?.id &&
          e.toSymbolId === ordersTable?.id,
      ),
    ).toBe(true);
  });

  it("a repo with SQLAlchemy models but no query call sites produces zero orm call-site edges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlalchemy-ingest-unused-"));
    writeFileSync(join(dir, "models.py"), modelsPy);
    const { prisma, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // Only models.py present — no call site, so no orm reads/writes edge to users/orders.
    expect(
      edgesCreated.filter((e) => e.source === "orm" && (e.kind === "reads" || e.kind === "writes")),
    ).toHaveLength(0);
  });
});

// ---- psycopg raw-SQL AC (verified through the existing sqlglot path) --------

interface Recorded {
  symbols: SchemaSymbolCreateData[];
  edges: SchemaEdgeCreateData[];
}

function fakeSchemaPrisma(): { prisma: SchemaGraphPrisma; recorded: Recorded } {
  const recorded: Recorded = { symbols: [], edges: [] };
  let n = 0;
  const prisma: SchemaGraphPrisma = {
    codeSymbol: {
      create: async ({ data }) => {
        recorded.symbols.push(data);
        return { id: `sym-${++n}` };
      },
    },
    codeEdge: {
      create: async ({ data }) => {
        recorded.edges.push(data);
        return undefined;
      },
    },
  } as unknown as SchemaGraphPrisma;
  return { prisma, recorded };
}

function stubClient(responder: (p: ExtractUsageParams) => ExtractUsageResult): SqlLineageClient {
  return {
    extractUsage: async (p: ExtractUsageParams) => responder(p),
  } as unknown as SqlLineageClient;
}

describe("psycopg cursor.execute string SQL reaches the schema graph via sqlglot (#898 AC)", () => {
  it("yields a table edge (source sqlglot) for an already-parseable psycopg statement", async () => {
    const { prisma, recorded } = fakeSchemaPrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const client = stubClient((p) =>
      /audit_log/i.test(p.sql)
        ? {
            tables: [{ schema: "", name: "audit_log", qualifiedName: "audit_log", access: "read" }],
            columns: [],
            lineage_edges: [],
            uncertain: [],
            routines: [],
          }
        : { tables: [], columns: [], lineage_edges: [], uncertain: [], routines: [] },
    );

    const res = await extractEmbeddedSql(writer, "queries.py", queriesPy, {
      client,
      sqlLineageOverride: true,
    });

    expect(res.edges).toBeGreaterThan(0);
    expect(recorded.edges.some((e) => e.source === "sqlglot")).toBe(true);
    expect(recorded.symbols.some((s) => s.kind === "table" && s.name === "audit_log")).toBe(true);
  });
});
