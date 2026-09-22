/**
 * Issue #900 (Epic #883) — guards that EF Core lineage extraction is WIRED into
 * the ingest pipeline on EVERY ingest (NOT behind SQL_LINEAGE_MODE). The
 * extractor internals are covered by `ef-extractor.test.ts`; this covers the
 * seam — `ingestCodeGraph` turning a `.cs` DbSet call site into an app-code→table
 * schema edge. "Reachability != existence": the end-to-end test below fails
 * (neuter-and-red) if the `extractEfCoreSchema` Step 5e call is removed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractEfCoreSchema, type IngestStats } from "../src/lib/code-graph/ingest.js";
import { ingestCodeGraph } from "../src/lib/code-graph/ingest.js";

const ENTITIES_CS = `namespace Shop.Domain;
[Table("customers")]
public class Customer { public int Id { get; set; } }
`;

const CONTEXT_CS = `namespace Shop.Data;
using Shop.Domain;
public class ShopContext : DbContext
{
    public DbSet<Customer> Customers { get; set; }
    public void AddCustomer(Customer c)
    {
        Customers.Add(c);
    }
}
`;

const stats = (): IngestStats => ({ schemaEdges: 0 }) as unknown as IngestStats;

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
        return existingSymbols.filter((s) => kinds.includes(s.kind));
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

describe("extractEfCoreSchema wiring (#900)", () => {
  it("emits an app-code→table edge from a DbSet call site, source=orm", async () => {
    const { prisma, symbols, edges } = fakePrisma([
      // The REAL enclosing method symbol persistParsed would have created.
      { id: "m-add", kind: "method", filePath: "Data/ShopContext.cs", startLine: 6, endLine: 9 },
    ]);
    const s = stats();
    await extractEfCoreSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([
        ["Domain/Customer.cs", ENTITIES_CS],
        ["Data/ShopContext.cs", CONTEXT_CS],
      ]),
      [{ filePath: "Data/ShopContext.cs", language: "cs" }] as never,
      s,
    );
    expect(edges.some((e) => e.kind === "writes" && e.source === "orm")).toBe(true);
    expect(symbols.some((x) => x.kind === "table")).toBe(true);
    expect(s.schemaEdges).toBeGreaterThan(0);
  });

  it("is a no-op with no C# sources", async () => {
    const { prisma, symbols, edges } = fakePrisma();
    await extractEfCoreSchema(prisma as never, "g1", "p1", new Map(), [], stats());
    expect(symbols).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(prisma.codeSymbol.create).not.toHaveBeenCalled();
  });

  it("emits nothing when no DbSet call site resolves (no edges, no throw)", async () => {
    const { prisma, edges } = fakePrisma();
    // Entity file only — no DbContext, so no DbSet map, so no call sites.
    await expect(
      extractEfCoreSchema(
        prisma as never,
        "g1",
        "p1",
        new Map([["Domain/Customer.cs", ENTITIES_CS]]),
        [{ filePath: "Domain/Customer.cs", language: "cs" }] as never,
        stats(),
      ),
    ).resolves.toBeUndefined();
    expect(edges).toHaveLength(0);
  });

  it("never throws when persistence fails — an EF problem must not fail ingest", async () => {
    const { prisma } = fakePrisma([
      { id: "m-add", kind: "method", filePath: "Data/ShopContext.cs", startLine: 6, endLine: 9 },
    ]);
    prisma.codeSymbol.create = vi.fn(async () => {
      throw new Error("db down");
    }) as never;
    const s = stats();
    await expect(
      extractEfCoreSchema(
        prisma as never,
        "g1",
        "p1",
        new Map([
          ["Domain/Customer.cs", ENTITIES_CS],
          ["Data/ShopContext.cs", CONTEXT_CS],
        ]),
        [{ filePath: "Data/ShopContext.cs", language: "cs" }] as never,
        s,
      ),
    ).resolves.toBeUndefined();
    expect(s.schemaEdges).toBe(0);
  });
});

/** Minimal in-memory Prisma covering exactly the surface a `.cs`-only ingest touches. */
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

describe("ingestCodeGraph wires EF Core extraction end-to-end (#900)", () => {
  it("a C# method calling Customers.Add gets a writes edge to the customers table", async () => {
    // Reachability guard: this asserts Step 5e runs on EVERY ingest (it is NOT
    // gated on SQL_LINEAGE_MODE). Remove the extractEfCoreSchema call from
    // ingestCodeGraph and this fails.
    const dir = mkdtempSync(join(tmpdir(), "ef-ingest-"));
    writeFileSync(join(dir, "Customer.cs"), ENTITIES_CS);
    writeFileSync(join(dir, "ShopContext.cs"), CONTEXT_CS);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // The REAL parsed method symbol for AddCustomer, persisted by persistParsed.
    const fn = created.find(
      (s) => (s.kind === "method" || s.kind === "function") && s.name === "AddCustomer",
    );
    expect(fn).toBeDefined();
    const table = created.find((s) => s.kind === "table" && s.name === "customers");
    expect(table).toBeDefined();
    const edge = edgesCreated.find(
      (e) => e.kind === "writes" && e.fromSymbolId === fn?.id && e.toSymbolId === table?.id,
    );
    expect(edge).toBeDefined();
  });
});
