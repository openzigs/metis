/**
 * Issue #887 (epic #879) — end-to-end / neuter-and-red traceability guard.
 *
 * #884 wired MyBatis statements into the schema graph, but each statement's
 * `reads`/`writes`/`persists-to` edges only originated from a SYNTHETIC
 * per-statement symbol with no connection to real Java code — a requirement
 * crossing into a Java service class could never reach a MyBatis statement's
 * tables. This test proves the full traceability chain now exists, for both
 * XML mappers and annotation mappers:
 *
 *   service (real code symbol)
 *     -- calls -->        FooMapper.findAccount (real Java interface method)
 *     -- executes -->     the statement's synthetic origin symbol
 *     -- reads -->        the `accounts` table symbol
 *
 * Mirrors the layout of `ingest-mybatis-wiring.test.ts` (#884) and
 * `ingest-orm-wiring.test.ts` (#872, the ORM analog of this same gap).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestCodeGraph } from "../src/lib/code-graph/ingest.js";

const FIX = join(__dirname, "fixtures", "mybatis");
const fooMapperJava = readFileSync(join(FIX, "FooMapper.java"), "utf8");
const fooMapperXml = readFileSync(join(FIX, "FooMapper.xml"), "utf8");
const fooServiceJava = readFileSync(join(FIX, "FooService.java"), "utf8");
const orderMapperJava = readFileSync(join(FIX, "OrderMapper.java"), "utf8");
const orderServiceJava = readFileSync(join(FIX, "OrderService.java"), "utf8");
const barMapperJava = readFileSync(join(FIX, "BarMapper.java"), "utf8");
const barServiceJava = readFileSync(join(FIX, "BarService.java"), "utf8");

/** Minimal in-memory Prisma covering exactly the surface a MyBatis-only ingest touches. */
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
      },
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
    codeSymbolEmbedding: { createMany: async () => ({ count: 0 }) },
    finding: { create: async () => ({}), findFirst: async () => null },
  };
  return { prisma, created, edgesCreated };
}

/** Walk `edgesCreated` to find a hop `fromId -[kind]-> toId`. */
function findEdge(edges: any[], fromId: string, kind: string, toId?: string): any | undefined {
  return edges.find(
    (e) =>
      e.fromSymbolId === fromId && e.kind === kind && (toId === undefined || e.toSymbolId === toId),
  );
}

describe("MyBatis mapper call-site traceability (#887, neuter-and-red)", () => {
  it("XML mapper: service -> interface method -> statement -> table is a fully connected path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mybatis-callsite-xml-"));
    writeFileSync(join(dir, "FooMapper.java"), fooMapperJava);
    writeFileSync(join(dir, "FooMapper.xml"), fooMapperXml);
    writeFileSync(join(dir, "FooService.java"), fooServiceJava);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // Every hop's REAL node must exist.
    const serviceMethod = created.find(
      (s) => s.kind === "method" && s.name === "getAccount" && s.filePath === "FooService.java",
    );
    const mapperMethod = created.find(
      (s) => s.kind === "method" && s.name === "findAccount" && s.filePath === "FooMapper.java",
    );
    const table = created.find((s) => s.kind === "table" && s.name === "accounts");
    expect(serviceMethod, "service method symbol").toBeDefined();
    expect(mapperMethod, "mapper interface method symbol").toBeDefined();
    expect(table, "accounts table symbol").toBeDefined();

    // Hop 1: service --calls--> mapper interface method (ordinary code edge).
    // Two producers can legitimately both emit this same (from, kind, to) edge:
    // the generic tree-sitter `method_invocation` pass (`persistParsed`, which
    // resolves a globally-unique bare method name for free) AND this issue's
    // type-aware `persistMapperCallerEdges` pass — both leave `source` falsy
    // (an ordinary code edge, not a schema edge), so either is proof the path
    // exists.
    const callEdge = findEdge(edgesCreated, serviceMethod.id, "calls", mapperMethod.id);
    expect(callEdge, "service -> mapper method `calls` edge").toBeDefined();
    expect(callEdge.source ?? null).toBeNull();

    // Hop 2: mapper interface method --executes--> statement's synthetic origin.
    const executesEdge = findEdge(edgesCreated, mapperMethod.id, "executes");
    expect(executesEdge, "mapper method -> statement origin `executes` edge").toBeDefined();
    expect(executesEdge.source).toBe("mybatis");
    const statementOriginId = executesEdge.toSymbolId as string;
    const statementOrigin = created.find((s) => s.id === statementOriginId);
    expect(statementOrigin?.qualifiedName).toBe("com.acme.FooMapper.findAccount");

    // Hop 3: statement origin --reads--> accounts table (pre-existing #884 behaviour).
    const readsEdge = findEdge(edgesCreated, statementOriginId, "reads", table.id);
    expect(readsEdge, "statement origin -> table `reads` edge").toBeDefined();
    expect(readsEdge.source).toBe("mybatis");
  });

  it("annotation mapper: service -> interface method -> statement -> table is a fully connected path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mybatis-callsite-annotation-"));
    writeFileSync(join(dir, "OrderMapper.java"), orderMapperJava);
    writeFileSync(join(dir, "OrderService.java"), orderServiceJava);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    const serviceMethod = created.find(
      (s) => s.kind === "method" && s.name === "getOrder" && s.filePath === "OrderService.java",
    );
    const mapperMethod = created.find(
      (s) => s.kind === "method" && s.name === "findById" && s.filePath === "OrderMapper.java",
    );
    const table = created.find((s) => s.kind === "table" && s.name === "orders");
    expect(serviceMethod, "service method symbol").toBeDefined();
    expect(mapperMethod, "mapper interface method symbol").toBeDefined();
    expect(table, "orders table symbol").toBeDefined();

    const callEdge = findEdge(edgesCreated, serviceMethod.id, "calls", mapperMethod.id);
    expect(callEdge, "service -> mapper method `calls` edge").toBeDefined();

    const executesEdge = findEdge(edgesCreated, mapperMethod.id, "executes");
    expect(executesEdge, "mapper method -> statement origin `executes` edge").toBeDefined();
    const statementOriginId = executesEdge.toSymbolId as string;

    const readsEdge = findEdge(edgesCreated, statementOriginId, "reads", table.id);
    expect(readsEdge, "statement origin -> table `reads` edge").toBeDefined();
  });

  it("is a no-op addition when no Java interface matches a statement's namespace (graceful degradation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mybatis-callsite-no-interface-"));
    // XML mapper only — no matching FooMapper.java in the repo.
    writeFileSync(join(dir, "FooMapper.xml"), fooMapperXml);
    const { prisma, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // The original #884 behaviour (reads edge from the synthetic origin) still holds...
    expect(edgesCreated.some((e) => e.kind === "reads" && e.source === "mybatis")).toBe(true);
    // ...but no `executes`/`calls` edges are fabricated without a real interface.
    expect(edgesCreated.some((e) => e.kind === "executes")).toBe(false);
    expect(edgesCreated.some((e) => e.kind === "calls")).toBe(false);
  });

  it("disambiguates a same-named method across two DIFFERENT mapper interfaces by the caller's declared type", async () => {
    // Both OrderMapper and BarMapper declare a `findById` method — a name
    // collision the GENERIC project-wide by-name resolver (`persistParsed`'s
    // `resolveByName`) cannot safely bind (ambiguous -> leaves `toSymbolId`
    // null), which is exactly the gap `persistMapperCallerEdges` closes by
    // using the receiver's DECLARED TYPE to disambiguate.
    const dir = mkdtempSync(join(tmpdir(), "mybatis-callsite-ambiguous-"));
    writeFileSync(join(dir, "OrderMapper.java"), orderMapperJava);
    writeFileSync(join(dir, "OrderService.java"), orderServiceJava);
    writeFileSync(join(dir, "BarMapper.java"), barMapperJava);
    writeFileSync(join(dir, "BarService.java"), barServiceJava);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    const orderServiceMethod = created.find(
      (s) => s.kind === "method" && s.name === "getOrder" && s.filePath === "OrderService.java",
    );
    const orderMapperMethod = created.find(
      (s) => s.kind === "method" && s.name === "findById" && s.filePath === "OrderMapper.java",
    );
    const barServiceMethod = created.find(
      (s) => s.kind === "method" && s.name === "getBar" && s.filePath === "BarService.java",
    );
    const barMapperMethod = created.find(
      (s) => s.kind === "method" && s.name === "findById" && s.filePath === "BarMapper.java",
    );
    expect(orderServiceMethod).toBeDefined();
    expect(orderMapperMethod).toBeDefined();
    expect(barServiceMethod).toBeDefined();
    expect(barMapperMethod).toBeDefined();
    expect(orderMapperMethod.id).not.toBe(barMapperMethod.id);

    // Each service reaches its OWN mapper's `findById` — never the other one.
    const orderCallsEdges = edgesCreated.filter(
      (e) => e.kind === "calls" && e.fromSymbolId === orderServiceMethod.id,
    );
    const barCallsEdges = edgesCreated.filter(
      (e) => e.kind === "calls" && e.fromSymbolId === barServiceMethod.id,
    );
    expect(orderCallsEdges.some((e) => e.toSymbolId === orderMapperMethod.id)).toBe(true);
    expect(orderCallsEdges.some((e) => e.toSymbolId === barMapperMethod.id)).toBe(false);
    expect(barCallsEdges.some((e) => e.toSymbolId === barMapperMethod.id)).toBe(true);
    expect(barCallsEdges.some((e) => e.toSymbolId === orderMapperMethod.id)).toBe(false);
  });
});
