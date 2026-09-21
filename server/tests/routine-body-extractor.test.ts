/**
 * Tests for the routine-body extractor — Epic #294 (#316B): `calls` edges.
 *
 * The routine body is supplied by an injected READ-ONLY fetcher (never a real DB),
 * the sql-lineage client is stubbed (no live sidecar / network), and the schema
 * graph writer is in-memory. Verifies routine→object `calls` edges land with
 * source `sqlglot`, unresolved/unavailable bodies surface `routine-body-unanalyzed`
 * (never dropped), the fetcher is read-only/parse-only, and degradation is safe.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { DbRoutineInfo } from "@metis/shared";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";
import {
  extractRoutineBodies,
  type RoutineBodyFetcher,
} from "../src/lib/code-graph/routine-body-extractor.js";
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
    extractUsage: async (params: ExtractUsageParams) => responder(params),
  } as unknown as SqlLineageClient;
}

const EMPTY: ExtractUsageResult = {
  tables: [],
  columns: [],
  lineage_edges: [],
  uncertain: [],
  routines: [],
};

const PROC: DbRoutineInfo = { schema: "app", name: "recalc", type: "procedure", signature: "" };

beforeEach(() => {
  process.env.SQL_LINEAGE_MODE = "sidecar"; // enable the gate; client is stubbed
});

describe("extractRoutineBodies", () => {
  it("emits `calls` edges (routine → table/column) from a parsed body", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: RoutineBodyFetcher = async () =>
      "CREATE PROCEDURE recalc AS BEGIN UPDATE orders SET total = 1; END;";
    const client = stubClient(() => ({
      ...EMPTY,
      tables: [{ schema: "", name: "orders", qualifiedName: "orders", access: "write" }],
      columns: [
        { table: "orders", column: "total", qualifiedName: "orders.total", access: "write" },
      ],
      uncertain: [{ reason: "routine-body-unanalyzed", detail: "best-effort" }],
    }));

    const res = await extractRoutineBodies(writer, [PROC], fetchBody, { client });

    expect(res.analyzed).toBe(1);
    // table + column `calls` edges, both source sqlglot, both kind "calls".
    const callEdges = recorded.edges.filter((e) => e.kind === "calls");
    expect(callEdges.length).toBe(2);
    expect(callEdges.every((e) => e.source === "sqlglot")).toBe(true);
    expect(callEdges.some((e) => e.toQualifiedName === "orders")).toBe(true);
    expect(callEdges.some((e) => e.toQualifiedName === "orders.total")).toBe(true);
    // The `from` side is the routine symbol (app.recalc), kind procedure.
    const fromSym = recorded.symbols.find(
      (s) => s.qualifiedName === "app.recalc" && s.kind === "procedure",
    );
    expect(fromSym?.source).toBe("sqlglot");
  });

  it("emits a routine→routine `calls` edge when a body invokes another routine", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: RoutineBodyFetcher = async () =>
      "CREATE PROCEDURE recalc AS BEGIN child_proc(); END;";
    const client = stubClient(() => ({
      ...EMPTY,
      tables: [{ schema: "", name: "orders", qualifiedName: "orders", access: "read" }],
      routines: [{ schema: "", name: "child_proc", qualifiedName: "child_proc" }],
      uncertain: [{ reason: "routine-body-unanalyzed", detail: "x" }],
    }));
    const res = await extractRoutineBodies(writer, [PROC], fetchBody, { client });
    expect(res.edges).toBeGreaterThanOrEqual(2);
    expect(
      recorded.edges.some((e) => e.kind === "calls" && e.toQualifiedName === "child_proc"),
    ).toBe(true);
  });

  it("marks a routine whose body is unavailable as routine-body-unanalyzed (never dropped)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: RoutineBodyFetcher = async () => null; // body not available
    const client = stubClient(() => ({ ...EMPTY }));

    const res = await extractRoutineBodies(writer, [PROC], fetchBody, { client });
    expect(res.analyzed).toBe(0);
    expect(res.unanalyzed).toBe(1);
    expect(res.edges).toBe(0);
    expect(recorded.edges).toHaveLength(0);
    expect(res.uncertain).toEqual([
      {
        routine: "app.recalc",
        reason: "routine-body-unanalyzed",
        detail: "routine body unavailable",
      },
    ]);
  });

  it("always records the routine-body caveat even for a fully-resolved body", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: RoutineBodyFetcher = async () =>
      "CREATE PROCEDURE recalc AS BEGIN UPDATE orders SET total = 1; END;";
    const client = stubClient(() => ({
      ...EMPTY,
      tables: [{ schema: "", name: "orders", qualifiedName: "orders", access: "write" }],
      uncertain: [], // sidecar returned no uncertain — extractor still adds the caveat
    }));
    const res = await extractRoutineBodies(writer, [PROC], fetchBody, { client });
    expect(res.uncertain.some((u) => u.reason === "routine-body-unanalyzed")).toBe(true);
  });

  it("is READ-ONLY / parse-only: the fetcher returns text and is never asked to execute", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let fetchCalls = 0;
    let receivedSqlByClient = "";
    const fetchBody: RoutineBodyFetcher = async (r) => {
      fetchCalls += 1;
      return `CREATE PROCEDURE ${r.name} AS BEGIN SELECT 1 FROM dual; END;`;
    };
    const client = stubClient((p) => {
      receivedSqlByClient = p.sql;
      return { ...EMPTY };
    });
    await extractRoutineBodies(writer, [PROC], fetchBody, { client });
    // The body text flows fetcher → client(sidecar) for PARSING; nothing executes.
    expect(fetchCalls).toBe(1);
    expect(receivedSqlByClient).toContain("CREATE PROCEDURE recalc");
  });

  it("forwards the introspected schema + dialect to the sidecar (#317)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: RoutineBodyFetcher = async () => "CREATE PROCEDURE recalc AS BEGIN END;";
    let seenSchema: unknown;
    let seenDialect: unknown;
    const client = stubClient((p) => {
      seenSchema = p.schema;
      seenDialect = p.dialect;
      return { ...EMPTY };
    });
    await extractRoutineBodies(writer, [PROC], fetchBody, {
      client,
      schema: { app: { orders: { total: "DECIMAL" } } },
      dialect: "oracle",
    });
    expect(seenSchema).toEqual({ app: { orders: { total: "DECIMAL" } } });
    expect(seenDialect).toBe("oracle");
  });

  it("isolates a throwing fetcher per-routine (one bad body never aborts the rest)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const good: DbRoutineInfo = { schema: "app", name: "ok", type: "procedure", signature: "" };
    const fetchBody: RoutineBodyFetcher = async (r) => {
      if (r.name === "recalc") throw new Error("ORA-00942");
      return "CREATE PROCEDURE ok AS BEGIN UPDATE t SET x = 1; END;";
    };
    const client = stubClient(() => ({
      ...EMPTY,
      tables: [{ schema: "", name: "t", qualifiedName: "t", access: "write" }],
    }));
    const res = await extractRoutineBodies(writer, [PROC, good], fetchBody, { client });
    // The throwing routine is unanalyzed-uncertain; the good one still produces edges.
    expect(res.unanalyzed).toBe(1);
    expect(res.analyzed).toBe(1);
    expect(recorded.edges.some((e) => e.kind === "calls" && e.toQualifiedName === "t")).toBe(true);
  });

  it("degrades gracefully (every routine uncertain) when the sidecar is disabled", async () => {
    process.env.SQL_LINEAGE_MODE = "in-process"; // extractUsageSafe → null
    try {
      const { prisma, recorded } = fakePrisma();
      const writer = new SchemaGraphWriter(prisma, "g1", "p1");
      const fetchBody: RoutineBodyFetcher = async () => "CREATE PROCEDURE recalc AS BEGIN END;";
      const res = await extractRoutineBodies(writer, [PROC], fetchBody, {});
      expect(res.edges).toBe(0);
      expect(res.unanalyzed).toBe(1);
      expect(recorded.edges).toHaveLength(0);
      expect(res.uncertain.some((u) => u.reason === "routine-body-unanalyzed")).toBe(true);
    } finally {
      process.env.SQL_LINEAGE_MODE = "sidecar";
    }
  });

  it("returns a zeroed result for an empty routine list (no fetch, no sidecar call)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let fetchCalls = 0;
    const fetchBody: RoutineBodyFetcher = async () => {
      fetchCalls += 1;
      return "x";
    };
    const res = await extractRoutineBodies(writer, [], fetchBody, {});
    expect(res).toEqual({ edges: 0, analyzed: 0, unanalyzed: 0, uncertain: [] });
    expect(fetchCalls).toBe(0);
  });
});
