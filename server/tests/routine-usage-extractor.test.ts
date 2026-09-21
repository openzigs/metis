/**
 * Tests for the routine-usage extractor — Epic #294 (#316A): `executes` edges.
 *
 * Uses the REAL tree-sitter parsers to locate SQL string literals, a STUBBED
 * sql-lineage client (no live sidecar / network), and an in-memory schema-graph
 * writer. Verifies code→routine `executes` edges land with source `sqlglot`,
 * built-ins produce nothing, and the extractor degrades gracefully.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initCodeGraphParsers } from "../src/lib/code-graph/parsers.js";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";
import { extractRoutineUsage } from "../src/lib/code-graph/routine-usage-extractor.js";
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

function routineResult(refs: { schema?: string; name: string }[]): ExtractUsageResult {
  return {
    ...EMPTY,
    routines: refs.map((r) => ({
      schema: r.schema ?? "",
      name: r.name,
      qualifiedName: r.schema ? `${r.schema}.${r.name}` : r.name,
    })),
  };
}

beforeAll(async () => {
  await initCodeGraphParsers();
  process.env.SQL_LINEAGE_MODE = "sidecar"; // enable the gate; client is stubbed
});

describe("extractRoutineUsage", () => {
  it("emits an `executes` edge (code → routine) for a CALL invocation in TS", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `db.query("CALL update_inventory(5, 10)");`;
    const client = stubClient(() => routineResult([{ name: "update_inventory" }]));

    const res = await extractRoutineUsage(writer, "src/svc.ts", src, { client });

    expect(res.edges).toBe(1);
    expect(res.routines).toBe(1);
    const edge = recorded.edges.find((e) => e.toQualifiedName === "update_inventory");
    expect(edge?.kind).toBe("executes");
    expect(edge?.source).toBe("sqlglot");
    // The target routine symbol was persisted as a procedure with source sqlglot.
    const routineSym = recorded.symbols.find(
      (s) => s.qualifiedName === "update_inventory" && s.kind === "procedure",
    );
    expect(routineSym?.source).toBe("sqlglot");
    // The `from` side is a synthesized code-origin method, NOT a routine.
    const origin = recorded.symbols.find((s) => s.qualifiedName.includes("::exec@"));
    expect(origin?.kind).toBe("method");
  });

  it("carries the routine schema through to the edge + symbol", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `runner.exec("CALL app.do_sync()");`;
    const client = stubClient(() => routineResult([{ schema: "app", name: "do_sync" }]));

    await extractRoutineUsage(writer, "src/svc.ts", src, { client });

    expect(recorded.edges.some((e) => e.toQualifiedName === "app.do_sync")).toBe(true);
    const sym = recorded.symbols.find((s) => s.qualifiedName === "app.do_sync");
    expect(sym?.name).toBe("do_sync");
  });

  it("emits executes edges for a SELECT fn() call in Python", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = 'q = "SELECT calc_total(o.id) FROM orders o"\ncur.execute(q)\n';
    const client = stubClient(() => routineResult([{ name: "calc_total" }]));

    const res = await extractRoutineUsage(writer, "app/dao.py", src, { client });
    expect(res.edges).toBe(1);
    expect(recorded.edges.some((e) => e.toQualifiedName === "calc_total")).toBe(true);
  });

  it("writes NOTHING when the sidecar reports no routines (e.g. built-ins only)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `const q = "SELECT COUNT(*) FROM users";`;
    const client = stubClient(() => ({ ...EMPTY })); // no routines

    const res = await extractRoutineUsage(writer, "src/svc.ts", src, { client });
    expect(res.edges).toBe(0);
    expect(recorded.edges).toHaveLength(0);
  });

  it("dedupes the same routine referenced twice on one line", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `const q = "CALL do_it()";`;
    const client = stubClient(() => routineResult([{ name: "do_it" }, { name: "do_it" }]));
    const res = await extractRoutineUsage(writer, "src/svc.ts", src, { client });
    expect(res.edges).toBe(1);
    expect(recorded.edges.filter((e) => e.toQualifiedName === "do_it")).toHaveLength(1);
  });

  it("returns a zeroed result for unsupported languages (no sidecar call)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let called = false;
    const client = stubClient(() => {
      called = true;
      return routineResult([{ name: "x" }]);
    });
    const res = await extractRoutineUsage(writer, "notes.md", "CALL x()", { client });
    expect(res.candidates).toBe(0);
    expect(called).toBe(false);
  });

  it("returns a zeroed result when no SQL candidates are present", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let called = false;
    const client = stubClient(() => {
      called = true;
      return routineResult([{ name: "x" }]);
    });
    const res = await extractRoutineUsage(writer, "src/svc.ts", `const x = "hello world";`, {
      client,
    });
    expect(res.candidates).toBe(0);
    expect(called).toBe(false);
  });

  it("forwards the introspected schema to the sidecar (#317)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `const q = "SELECT calc_total(id) FROM users";`;
    let seenSchema: unknown;
    const client = stubClient((p) => {
      seenSchema = p.schema;
      return routineResult([{ name: "calc_total" }]);
    });
    await extractRoutineUsage(writer, "src/svc.ts", src, {
      client,
      schema: { public: { users: { id: "INT" } } },
    });
    expect(seenSchema).toEqual({ public: { users: { id: "INT" } } });
  });

  it("degrades gracefully (zero edges, no throw) when the sidecar is unavailable", async () => {
    const prevMode = process.env.SQL_LINEAGE_MODE;
    process.env.SQL_LINEAGE_MODE = "in-process"; // extractUsageSafe → null
    try {
      const { prisma, recorded } = fakePrisma();
      const writer = new SchemaGraphWriter(prisma, "g1", "p1");
      const res = await extractRoutineUsage(writer, "src/svc.ts", `x("CALL do_it()");`, {});
      expect(res.edges).toBe(0);
      expect(recorded.edges).toHaveLength(0);
    } finally {
      process.env.SQL_LINEAGE_MODE = prevMode;
    }
  });
});
