import { describe, expect, it } from "vitest";
import {
  columnQualifiedName,
  DYNAMIC_PLACEHOLDER_PREFIX,
  dynamicPlaceholderName,
  LIVE_SCHEMA_FILE,
  normalizeIdentifier,
  routineQualifiedName,
  schemaSymbolHash,
  SchemaGraphWriter,
  tableQualifiedName,
  unresolvedRefMetadata,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";

interface Recorded {
  symbols: SchemaSymbolCreateData[];
  edges: SchemaEdgeCreateData[];
}

function fakePrisma(): { prisma: SchemaGraphPrisma; recorded: Recorded } {
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
  };
  return { prisma, recorded };
}

describe("schema-graph normalizers", () => {
  it("normalizes quoted/cased identifiers", () => {
    expect(normalizeIdentifier('"Users"')).toBe("users");
    expect(normalizeIdentifier("`orders`")).toBe("orders");
    expect(normalizeIdentifier("[Items]")).toBe("items");
    expect(normalizeIdentifier("  Foo  ")).toBe("foo");
    expect(normalizeIdentifier("")).toBe("");
  });

  it("builds schema-qualified table names", () => {
    expect(tableQualifiedName("public", "Users")).toBe("public.users");
    expect(tableQualifiedName(undefined, "Users")).toBe("users");
  });

  it("builds schema-qualified column names", () => {
    expect(columnQualifiedName("public", "Users", "Email")).toBe("public.users.email");
    expect(columnQualifiedName(undefined, "Users", "Email")).toBe("users.email");
  });

  it("builds schema-qualified routine names (#301)", () => {
    expect(routineQualifiedName("app", "Calc_Total")).toBe("app.calc_total");
    expect(routineQualifiedName(undefined, "DoSync")).toBe("dosync");
  });

  it("produces a stable, provenance-aware hash", () => {
    const a = schemaSymbolHash("table", "public.users", "live-db");
    const b = schemaSymbolHash("table", "public.users", "live-db");
    const c = schemaSymbolHash("table", "public.users", "mybatis");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("unresolved/dynamic reference model (#886)", () => {
  it("builds a canonical synthetic placeholder name that can't collide with a real table", () => {
    expect(dynamicPlaceholderName("tableName")).toBe(`${DYNAMIC_PLACEHOLDER_PREFIX}tablename`);
    // SQL identifiers can never start with `?` — the prefix guarantees no collision.
    expect(dynamicPlaceholderName("tableName").startsWith("?")).toBe(true);
  });

  it("normalizes whitespace/casing so equivalent placeholders collapse to one name", () => {
    expect(dynamicPlaceholderName("  Table Name  ")).toBe(
      `${DYNAMIC_PLACEHOLDER_PREFIX}table_name`,
    );
  });

  it("falls back to 'unknown' for an empty placeholder instead of an empty name", () => {
    expect(dynamicPlaceholderName("")).toBe(`${DYNAMIC_PLACEHOLDER_PREFIX}unknown`);
  });

  it("builds the shared unresolved-ref metadata marker shape", () => {
    expect(
      unresolvedRefMetadata({
        placeholder: "tableName",
        statementId: "findDynamic",
        mapper: "com.example.DynamicMapper",
      }),
    ).toEqual({
      unresolved: true,
      placeholder: "tableName",
      statementId: "findDynamic",
      mapper: "com.example.DynamicMapper",
    });
  });

  it("allows a null mapper when the extractor has no mapper/class identity", () => {
    expect(
      unresolvedRefMetadata({ placeholder: "col", statementId: "s1", mapper: null }).mapper,
    ).toBeNull();
  });
});

describe("SchemaGraphWriter", () => {
  it("creates and caches table symbols by qualified name", async () => {
    const { prisma, recorded } = fakePrisma();
    const w = new SchemaGraphWriter(prisma, "graph-1", "proj-1");
    const id1 = await w.ensureTable("Users", "live-db", { schema: "public" });
    const id2 = await w.ensureTable("users", "live-db", { schema: "public" });
    expect(id1).toBe(id2);
    expect(recorded.symbols).toHaveLength(1);
    expect(recorded.symbols[0]).toMatchObject({
      kind: "table",
      name: "users",
      qualifiedName: "public.users",
      language: "sql",
      source: "live-db",
      filePath: LIVE_SCHEMA_FILE,
    });
  });

  it("creates and caches column symbols", async () => {
    const { prisma, recorded } = fakePrisma();
    const w = new SchemaGraphWriter(prisma, "graph-1", "proj-1");
    const c1 = await w.ensureColumn("users", "email", "orm", { filePath: "Entity.java", line: 12 });
    const c2 = await w.ensureColumn("users", "email", "orm");
    expect(c1).toBe(c2);
    expect(recorded.symbols).toHaveLength(1);
    expect(recorded.symbols[0]).toMatchObject({
      kind: "column",
      name: "email",
      qualifiedName: "users.email",
      filePath: "Entity.java",
      startLine: 12,
      source: "orm",
    });
  });

  it("persists reads/writes/persists-to edges", async () => {
    const { prisma, recorded } = fakePrisma();
    const w = new SchemaGraphWriter(prisma, "graph-1", "proj-1");
    const stmt = await w.createOriginSymbol(
      "method",
      "findById",
      "com.x.UserMapper.findById",
      "UserMapper.xml",
      3,
    );
    const table = await w.ensureTable("users", "mybatis", { filePath: "UserMapper.xml" });
    await w.addEdge(stmt, "reads", table, "mybatis", {
      toQualifiedName: "users",
      filePath: "UserMapper.xml",
      line: 3,
    });
    expect(recorded.edges).toHaveLength(1);
    expect(recorded.edges[0]).toMatchObject({
      kind: "reads",
      fromSymbolId: stmt,
      toSymbolId: table,
      toQualifiedName: "users",
      source: "mybatis",
    });
  });

  it("JSON-encodes edge metadata when supplied, and omits it when not (#890)", async () => {
    const { prisma, recorded } = fakePrisma();
    const w = new SchemaGraphWriter(prisma, "graph-1", "proj-1");
    const stmt = await w.createOriginSymbol(
      "method",
      "findById",
      "com.x.UserMapper.findById",
      "UserMapper.xml",
      3,
    );
    const table = await w.ensureTable("users", "mybatis", { filePath: "UserMapper.xml" });
    await w.addEdge(stmt, "reads", table, "mybatis", {
      toQualifiedName: "users",
      metadata: { tier: 1, coarse: true, direction: "unknown" },
    });
    await w.addEdge(stmt, "reads", table, "mybatis", { toQualifiedName: "users" });

    expect(recorded.edges[0].metadata).toBe(
      JSON.stringify({ tier: 1, coarse: true, direction: "unknown" }),
    );
    expect(recorded.edges[1].metadata).toBeNull();
  });

  it("rejects empty table/column names", async () => {
    const { prisma } = fakePrisma();
    const w = new SchemaGraphWriter(prisma, "graph-1", "proj-1");
    await expect(w.ensureTable("", "orm")).rejects.toThrow(/empty table/);
    await expect(w.ensureColumn("users", "", "orm")).rejects.toThrow(/empty column/);
  });

  it("creates and caches procedure/function symbols by (kind, qualified name) (#301)", async () => {
    const { prisma, recorded } = fakePrisma();
    const w = new SchemaGraphWriter(prisma, "graph-1", "proj-1");
    const p1 = await w.ensureRoutine("Calc_Total", "function", "live-db", { schema: "app" });
    const p2 = await w.ensureRoutine("calc_total", "function", "live-db", { schema: "app" });
    expect(p1).toBe(p2); // cached
    // A same-named PROCEDURE is a distinct symbol from the FUNCTION.
    const proc = await w.ensureRoutine("calc_total", "procedure", "live-db", { schema: "app" });
    expect(proc).not.toBe(p1);
    expect(recorded.symbols).toHaveLength(2);
    expect(recorded.symbols[0]).toMatchObject({
      kind: "function",
      name: "calc_total",
      qualifiedName: "app.calc_total",
      language: "sql",
      source: "live-db",
      filePath: LIVE_SCHEMA_FILE,
    });
    expect(recorded.symbols[1].kind).toBe("procedure");
  });

  it("rejects an empty routine name (#301)", async () => {
    const { prisma } = fakePrisma();
    const w = new SchemaGraphWriter(prisma, "graph-1", "proj-1");
    await expect(w.ensureRoutine("", "procedure", "live-db")).rejects.toThrow(/empty routine/);
  });

  it("persists an `executes` edge (code → routine) and a `calls` edge (routine → object) (#301)", async () => {
    const { prisma, recorded } = fakePrisma();
    const w = new SchemaGraphWriter(prisma, "graph-1", "proj-1");
    const caller = await w.createOriginSymbol(
      "method",
      "runReport",
      "com.x.ReportService.runReport",
      "ReportService.java",
      10,
    );
    const proc = await w.ensureRoutine("calc_total", "procedure", "live-db", { schema: "app" });
    const table = await w.ensureTable("orders", "live-db", { schema: "app" });

    // code invokes routine
    await w.addEdge(caller, "executes", proc, "live-db", { toQualifiedName: "app.calc_total" });
    // routine references object (Phase 3 will populate these from the body)
    await w.addEdge(proc, "calls", table, "live-db", { toQualifiedName: "app.orders" });

    expect(recorded.edges).toHaveLength(2);
    expect(recorded.edges[0]).toMatchObject({
      kind: "executes",
      fromSymbolId: caller,
      toSymbolId: proc,
      source: "live-db",
    });
    expect(recorded.edges[1]).toMatchObject({
      kind: "calls",
      fromSymbolId: proc,
      toSymbolId: table,
      source: "live-db",
    });
  });
});
