/**
 * Tests for SAS PROC SQL schema-usage extraction — Epic #294 (#306).
 *
 * The existing data-step / PROC-clause prompt miner (`mineSasRules`) has its own
 * test (`sas-rule-miner.test.ts`) and is asserted UNCHANGED here (no regression).
 * These tests cover the NEW PROC SQL → sidecar → schema-graph path with a stubbed
 * sql-lineage client (no live sidecar / network) and an in-memory writer.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  extractSasProcSql,
  findProcSqlBlocks,
  mineSasRules,
  sanitizeProcSql,
  splitProcSqlStatements,
} from "../src/lib/code-graph/sas-rule-miner.js";
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

function stubClient(
  responder: (params: ExtractUsageParams) => ExtractUsageResult,
): SqlLineageClient {
  return {
    extractUsage: async (p: ExtractUsageParams) => responder(p),
  } as unknown as SqlLineageClient;
}

const EMPTY: ExtractUsageResult = {
  tables: [],
  columns: [],
  lineage_edges: [],
  uncertain: [],
  routines: [],
};

beforeAll(() => {
  // Enable the feature gate so extractUsageSafe routes to the injected (stub)
  // client; the per-test in-process case overrides this locally.
  process.env.SQL_LINEAGE_MODE = "sidecar";
});

// ---------------------------------------------------------------------------

describe("findProcSqlBlocks", () => {
  it("locates a proc sql ... quit block", () => {
    const src = [
      "data work.a; set work.b; run;",
      "proc sql;",
      "  create table work.summary as",
      "  select id, total from work.orders where total > 100;",
      "quit;",
    ].join("\n");
    const blocks = findProcSqlBlocks(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sql).toContain("create table work.summary");
    expect(blocks[0].line).toBe(2); // 1-based line of `proc sql;`
  });

  it("handles proc sql options (noprint) and multiple blocks", () => {
    const src = "proc sql noprint;\nselect a from t1;\nquit;\nproc sql;\nselect b from t2;\nquit;";
    const blocks = findProcSqlBlocks(src);
    expect(blocks).toHaveLength(2);
  });

  it("captures a block missing its terminating quit (end of program)", () => {
    const src = "proc sql;\nselect x from t;";
    const blocks = findProcSqlBlocks(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sql).toContain("select x from t");
  });

  it("returns nothing when there is no PROC SQL", () => {
    expect(findProcSqlBlocks("data a; set b; run;")).toEqual([]);
  });
});

describe("sanitizeProcSql", () => {
  it("replaces SAS macro variables with a literal", () => {
    expect(sanitizeProcSql("select * from &lib..accounts")).not.toContain("&lib");
  });

  it("drops `into :host` capture before FROM", () => {
    expect(sanitizeProcSql("select count(*) into :n from accounts")).toBe(
      "select count(*) from accounts",
    );
  });
});

describe("splitProcSqlStatements", () => {
  it("splits on semicolons and trims", () => {
    expect(splitProcSqlStatements("select a from t1; select b from t2;")).toEqual([
      "select a from t1",
      "select b from t2",
    ]);
  });
});

describe("extractSasProcSql persistence", () => {
  it("writes sqlglot edges for a PROC SQL create-table-as-select", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = "proc sql;\ncreate table summary as select id from orders;\nquit;";
    const client = stubClient(() => ({
      tables: [
        { schema: "", name: "summary", qualifiedName: "summary", access: "persist" },
        { schema: "", name: "orders", qualifiedName: "orders", access: "read" },
      ],
      columns: [{ table: "orders", column: "id", qualifiedName: "orders.id", access: "read" }],
      lineage_edges: [],
      uncertain: [],
      routines: [],
    }));
    const res = await extractSasProcSql(writer, "etl/load.sas", src, { client });
    expect(res.blocks).toBe(1);
    expect(res.resolved).toBe(1);
    const ordersEdge = recorded.edges.find((e) => e.toQualifiedName === "orders");
    expect(ordersEdge?.kind).toBe("reads");
    expect(ordersEdge?.source).toBe("sqlglot");
    const summaryEdge = recorded.edges.find((e) => e.toQualifiedName === "summary");
    expect(summaryEdge?.kind).toBe("persists-to");
    expect(recorded.edges.some((e) => e.toQualifiedName === "orders.id")).toBe(true);
  });

  it("forwards the introspected schema to the sidecar", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let seen: unknown;
    const client = stubClient((p) => {
      seen = p.schema;
      return { ...EMPTY, tables: [{ schema: "", name: "t", qualifiedName: "t", access: "read" }] };
    });
    await extractSasProcSql(writer, "etl/load.sas", "proc sql;\nselect * from t;\nquit;", {
      client,
      schema: { public: { t: { id: "INT" } } },
    });
    expect(seen).toEqual({ public: { t: { id: "INT" } } });
  });

  it("records uncertain refs (never dropped)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const client = stubClient(() => ({
      ...EMPTY,
      uncertain: [{ reason: "dynamic-reference", detail: "macro table name" }],
    }));
    const res = await extractSasProcSql(
      writer,
      "etl/load.sas",
      "proc sql;\nselect * from &t;\nquit;",
      {
        client,
      },
    );
    expect(res.uncertain.some((u) => u.reason === "dynamic-reference")).toBe(true);
  });

  it("returns zeroed result with no PROC SQL (no sidecar call)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let called = false;
    const client = stubClient(() => {
      called = true;
      return EMPTY;
    });
    const res = await extractSasProcSql(writer, "etl/x.sas", "data a; set b; run;", { client });
    expect(res.blocks).toBe(0);
    expect(called).toBe(false);
  });

  it("degrades gracefully when the sidecar is unavailable (mode in-process)", async () => {
    const prev = process.env.SQL_LINEAGE_MODE;
    process.env.SQL_LINEAGE_MODE = "in-process";
    try {
      const { prisma, recorded } = fakePrisma();
      const writer = new SchemaGraphWriter(prisma, "g1", "p1");
      const res = await extractSasProcSql(
        writer,
        "etl/load.sas",
        "proc sql;\nselect id from orders;\nquit;",
        {}, // no client → extractUsageSafe returns null
      );
      expect(res.edges).toBe(0);
      expect(recorded.edges).toHaveLength(0);
    } finally {
      process.env.SQL_LINEAGE_MODE = prev;
    }
  });
});

describe("no regression: mineSasRules still handles non-PROC-SQL data steps", () => {
  it("mines DATA-step subsetting IF / WHERE / RETAIN unchanged", () => {
    const src = [
      "data clean;",
      "  set raw;",
      "  if status = 'A';",
      "  where amount > 0;",
      "  retain running_total;",
      "run;",
    ].join("\n");
    const rules = mineSasRules(src, "etl/clean.sas", 1, "clean");
    const kinds = new Set(rules.map((r) => r.kind));
    expect(kinds.has("subsetting-if")).toBe(true);
    expect(kinds.has("where-filter")).toBe(true);
    expect(kinds.has("retain")).toBe(true);
  });

  it("still mines PROC SQL CLAUSES as prompt rules (the existing behavior)", () => {
    const src = "proc sql;\nselect a, b from t group by a having count(*) > 1 order by b;\nquit;";
    const rules = mineSasRules(src, "etl/agg.sas", 1, null);
    // The clause miner contributes proc-option rules (GROUP BY / HAVING / ORDER BY).
    expect(rules.some((r) => r.kind === "proc-option")).toBe(true);
  });
});
