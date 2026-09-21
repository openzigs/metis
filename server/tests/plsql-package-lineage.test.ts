/**
 * Tests for the Tier-2 PL/SQL package lineage orchestrator — Epic #881 Phase 3
 * (#893): per-statement sqlglot lineage attributed to the specific package
 * MEMBER, #892's unresolved (`EXECUTE IMMEDIATE`) passthrough, and Tier-1
 * (#890 `catalog-deps`) vs Tier-2 (`sqlglot`) cross-validation.
 *
 * The package body is supplied by an injected READ-ONLY fetcher (never a real
 * DB), the sql-lineage client is stubbed (no live sidecar / network), and the
 * schema graph writer is in-memory. No PL/SQL is ever executed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { DbDependencyInfo, DbPackageInfo } from "@metis/shared";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";
import {
  extractPlsqlPackageLineage,
  type PackageBodyFetcher,
} from "../src/lib/code-graph/plsql-package-lineage.js";
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

const ORDER_PKG: DbPackageInfo = {
  schema: "APP",
  name: "ORDER_PKG",
  hasSpec: true,
  hasBody: true,
  members: ["RECALC_TOTALS", "ARCHIVE_ORDER"],
};

/** Real-shaped body: one member with a plain UPDATE, one with an
 * EXECUTE IMMEDIATE dynamic statement followed by a concrete DELETE. */
const ORDER_PKG_BODY = `
CREATE PACKAGE BODY order_pkg AS

  PROCEDURE recalc_totals(p_order_id IN NUMBER) IS
  BEGIN
    UPDATE orders SET total = 1 WHERE id = p_order_id;
  END recalc_totals;

  PROCEDURE archive_order(p_order_id IN NUMBER, p_table_name IN VARCHAR2) IS
  BEGIN
    EXECUTE IMMEDIATE 'INSERT INTO ' || p_table_name || ' SELECT * FROM orders WHERE id = :1' USING p_order_id;
    DELETE FROM order_audit WHERE order_id = p_order_id;
  END archive_order;

END order_pkg;
`;

/** Routes each per-statement sqlglot call by a keyword in the SQL text — lets
 * one stub answer every statement the preprocessor isolates from the fixture
 * above without depending on call order. */
function fixtureClient(): SqlLineageClient {
  return stubClient((params) => {
    if (/UPDATE\s+orders/i.test(params.sql)) {
      return {
        ...EMPTY,
        tables: [{ schema: "APP", name: "ORDERS", qualifiedName: "APP.ORDERS", access: "write" }],
      };
    }
    if (/DELETE\s+FROM\s+order_audit/i.test(params.sql)) {
      return {
        ...EMPTY,
        tables: [
          {
            schema: "APP",
            name: "ORDER_AUDIT",
            qualifiedName: "APP.ORDER_AUDIT",
            access: "write",
          },
        ],
      };
    }
    return { ...EMPTY };
  });
}

/** Tier-1 catalog-deps rows for `order_pkg`: ORDERS (also seen by Tier-2),
 * ORDER_AUDIT (also seen by Tier-2), and CUSTOMERS — which Tier-2 never
 * resolves because it's only referenced inside the EXECUTE IMMEDIATE dynamic
 * statement `archive_order` builds. */
const TIER1_DEPS: DbDependencyInfo[] = [
  {
    schema: "APP",
    name: "ORDER_PKG",
    type: "PACKAGE BODY",
    referencedSchema: "APP",
    referencedName: "ORDERS",
    referencedType: "TABLE",
  },
  {
    schema: "APP",
    name: "ORDER_PKG",
    type: "PACKAGE BODY",
    referencedSchema: "APP",
    referencedName: "ORDER_AUDIT",
    referencedType: "TABLE",
  },
  {
    schema: "APP",
    name: "ORDER_PKG",
    type: "PACKAGE BODY",
    referencedSchema: "APP",
    referencedName: "CUSTOMERS",
    referencedType: "TABLE",
  },
];

beforeEach(() => {
  process.env.SQL_LINEAGE_MODE = "sidecar"; // enable the gate; client is stubbed
});

describe("extractPlsqlPackageLineage (#893)", () => {
  it("emits per-member reads/writes/persists-to edges attributed to the specific package MEMBER, not the package", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = fixtureClient();

    const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], { client });

    expect(res.analyzed).toBe(1);
    const writeEdges = recorded.edges.filter((e) => e.kind === "writes" && e.source === "sqlglot");
    expect(writeEdges.length).toBe(2);
    expect(writeEdges.some((e) => e.toQualifiedName === "APP.ORDERS")).toBe(true);
    expect(writeEdges.some((e) => e.toQualifiedName === "APP.ORDER_AUDIT")).toBe(true);

    // `recalc_totals`'s edge is attributed to the recalc_totals routine symbol...
    const recalcSym = recorded.symbols.find(
      (s) => s.qualifiedName === "app.recalc_totals" && s.kind === "procedure",
    );
    expect(recalcSym?.source).toBe("sqlglot");
    const recalcEdge = recorded.edges.find((e) => e.toQualifiedName === "APP.ORDERS");
    expect(recalcEdge?.fromSymbolId).toBe(recalcSym ? await idOf(recorded, recalcSym) : undefined);

    // ...and `archive_order`'s edge is attributed to the archive_order routine
    // symbol — NOT to a single whole-package symbol.
    const archiveSym = recorded.symbols.find(
      (s) => s.qualifiedName === "app.archive_order" && s.kind === "procedure",
    );
    expect(archiveSym).toBeTruthy();
    expect(recorded.symbols.some((s) => s.qualifiedName === "app.order_pkg")).toBe(false);
  });

  it("canonicalizes table names the same lower-cased way ensureTable/tableQualifiedName already do, so PL/SQL edges dedup onto the same node", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = fixtureClient();

    await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], { client });

    // Table SYMBOL identity is the writer's own canonical (lower-cased)
    // qualifiedName — matching how mybatis/orm/embedded-sql tables dedup.
    const ordersTables = recorded.symbols.filter(
      (s) => s.kind === "table" && s.qualifiedName === "app.orders",
    );
    expect(ordersTables).toHaveLength(1);
  });

  it("passes through #892's EXECUTE IMMEDIATE unresolved statement as a `calls` edge to a synthetic placeholder, tagged with #886 unresolvedRefMetadata — never dropped", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = fixtureClient();

    const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], { client });

    expect(res.unresolved.some((u) => u.reason === "execute-immediate")).toBe(true);
    const dynamicEdge = recorded.edges.find(
      (e) => e.kind === "calls" && (e.toQualifiedName as string)?.startsWith("?dynamic:"),
    );
    expect(dynamicEdge).toBeTruthy();
    expect(dynamicEdge?.source).toBe("sqlglot");
    const meta = JSON.parse(dynamicEdge?.metadata as string);
    expect(meta.unresolved).toBe(true);
    expect(meta.placeholder).toContain("INSERT INTO");
    // Attributed to the archive_order member, not the whole package.
    const archiveSym = recorded.symbols.find((s) => s.qualifiedName === "app.archive_order");
    expect(dynamicEdge?.fromSymbolId).toBe(await idOf(recorded, archiveSym!));
  });

  it("flags a table present in Tier-1 (catalog-deps) but absent from Tier-2 (sqlglot) as an unresolved/dynamic gap", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = fixtureClient();

    const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, TIER1_DEPS, {
      client,
    });

    // ORDERS and ORDER_AUDIT are seen by both tiers — not gaps.
    expect(res.gaps.some((g) => g.table === "app.orders")).toBe(false);
    expect(res.gaps.some((g) => g.table === "app.order_audit")).toBe(false);
    // CUSTOMERS is Tier-1-only (only reachable via the EXECUTE IMMEDIATE dynamic
    // SQL Tier-2 can't see into) — flagged.
    expect(res.gaps).toEqual([{ package: "app.order_pkg", table: "app.customers" }]);

    const gapEdge = recorded.edges.find(
      (e) => e.kind === "calls" && e.toQualifiedName === "app.customers",
    );
    expect(gapEdge).toBeTruthy();
    expect(gapEdge?.source).toBe("sqlglot");
    const meta = JSON.parse(gapEdge?.metadata as string);
    expect(meta.unresolved).toBe(true);
  });

  it("dedupes a Tier-2 table with a table already reached by another source (e.g. MyBatis) onto ONE node", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    // Seed the writer's dedupe cache as if a MyBatis extractor already created
    // `app.orders` earlier in the SAME ingest run (`prewarm`, #872's contract).
    writer.prewarm([{ id: "existing-orders-id", kind: "table", qualifiedName: "app.orders" }]);
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = fixtureClient();

    await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], { client });

    // No NEW `app.orders` table symbol was created — the prewarmed id was reused.
    expect(
      recorded.symbols.some((s) => s.kind === "table" && s.qualifiedName === "app.orders"),
    ).toBe(false);
    const ordersEdge = recorded.edges.find((e) => e.toQualifiedName === "APP.ORDERS");
    expect(ordersEdge?.toSymbolId).toBe("existing-orders-id");
  });

  it("marks a package whose body is unavailable as unanalyzed (never dropped) and still cross-validates against Tier-1", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => null;
    const client = fixtureClient();

    const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, TIER1_DEPS, {
      client,
    });

    expect(res.analyzed).toBe(0);
    expect(res.unanalyzed).toBe(1);
    expect(res.unresolved.some((u) => u.reason === "routine-body-unanalyzed")).toBe(true);
    // With no Tier-2 data at all, every Tier-1 table for this package is a gap.
    expect(res.gaps.map((g) => g.table).sort()).toEqual([
      "app.customers",
      "app.order_audit",
      "app.orders",
    ]);
    expect(recorded.edges.length).toBeGreaterThan(0);
  });

  it("is READ-ONLY / parse-only: the fetcher returns text and is never asked to execute", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let fetchCalls = 0;
    const receivedSqlByClient: string[] = [];
    const fetchBody: PackageBodyFetcher = async () => {
      fetchCalls += 1;
      return ORDER_PKG_BODY;
    };
    const client = stubClient((p) => {
      receivedSqlByClient.push(p.sql);
      return { ...EMPTY };
    });
    await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], { client });
    expect(fetchCalls).toBe(1);
    expect(receivedSqlByClient.some((s) => /UPDATE\s+orders/i.test(s))).toBe(true);
    expect(receivedSqlByClient.every((s) => !/^EXECUTE IMMEDIATE/i.test(s.trim()))).toBe(true);
  });

  it("forwards the Oracle dialect + introspected schema to the sidecar per statement", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const seenDialects: unknown[] = [];
    const seenSchemas: unknown[] = [];
    const client = stubClient((p) => {
      seenDialects.push(p.dialect);
      seenSchemas.push(p.schema);
      return { ...EMPTY };
    });
    await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], {
      client,
      schema: { app: { orders: { total: "NUMBER" } } },
    });
    expect(seenDialects.every((d) => d === "oracle")).toBe(true);
    expect(seenSchemas.every((s) => s && (s as Record<string, unknown>).app)).toBe(true);
  });

  it("isolates a throwing fetcher per-package (one bad body never aborts the rest)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const badPkg: DbPackageInfo = { ...ORDER_PKG, name: "BROKEN_PKG" };
    const fetchBody: PackageBodyFetcher = async (pkg) => {
      if (pkg.name === "BROKEN_PKG") throw new Error("ORA-04063");
      return ORDER_PKG_BODY;
    };
    const client = fixtureClient();
    const res = await extractPlsqlPackageLineage(writer, [badPkg, ORDER_PKG], fetchBody, [], {
      client,
    });
    expect(res.unanalyzed).toBe(1);
    expect(res.analyzed).toBe(1);
    expect(recorded.edges.some((e) => e.toQualifiedName === "APP.ORDERS")).toBe(true);
  });

  it("degrades gracefully to a complete no-op (no fetch, no edges) when the sidecar is disabled", async () => {
    process.env.SQL_LINEAGE_MODE = "in-process"; // isSqlLineageEnabled() -> false
    try {
      const { prisma, recorded } = fakePrisma();
      const writer = new SchemaGraphWriter(prisma, "g1", "p1");
      let fetchCalls = 0;
      const fetchBody: PackageBodyFetcher = async () => {
        fetchCalls += 1;
        return ORDER_PKG_BODY;
      };
      const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, TIER1_DEPS, {});
      expect(res).toEqual({
        edges: 0,
        gapEdges: 0,
        analyzed: 0,
        unanalyzed: 0,
        unresolved: [],
        gaps: [],
      });
      expect(fetchCalls).toBe(0);
      expect(recorded.edges).toHaveLength(0);
    } finally {
      process.env.SQL_LINEAGE_MODE = "sidecar";
    }
  });

  it("returns a zeroed result for an empty package list (no fetch, no sidecar call)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let fetchCalls = 0;
    const fetchBody: PackageBodyFetcher = async () => {
      fetchCalls += 1;
      return ORDER_PKG_BODY;
    };
    const res = await extractPlsqlPackageLineage(writer, [], fetchBody, TIER1_DEPS, {});
    expect(res).toEqual({
      edges: 0,
      gapEdges: 0,
      analyzed: 0,
      unanalyzed: 0,
      unresolved: [],
      gaps: [],
    });
    expect(fetchCalls).toBe(0);
  });

  it("emits column-level reads/writes edges attributed to the same member, alongside the table edge", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = stubClient((params) => {
      if (/UPDATE\s+orders/i.test(params.sql)) {
        return {
          ...EMPTY,
          tables: [{ schema: "APP", name: "ORDERS", qualifiedName: "APP.ORDERS", access: "write" }],
          columns: [
            {
              table: "APP.ORDERS",
              column: "TOTAL",
              qualifiedName: "APP.ORDERS.TOTAL",
              access: "write",
            },
          ],
        };
      }
      return { ...EMPTY };
    });

    const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], { client });

    expect(res.edges).toBeGreaterThanOrEqual(2);
    const colEdge = recorded.edges.find((e) => e.toQualifiedName === "APP.ORDERS.TOTAL");
    expect(colEdge?.kind).toBe("writes");
    expect(colEdge?.source).toBe("sqlglot");
    const colSym = recorded.symbols.find(
      (s) => s.kind === "column" && s.qualifiedName === "app.orders.total",
    );
    expect(colSym).toBeTruthy();
  });

  it("surfaces sidecar-reported `uncertain` refs for a resolved statement into the unresolved list — never dropped", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = stubClient((params) => {
      if (/UPDATE\s+orders/i.test(params.sql)) {
        return {
          ...EMPTY,
          tables: [{ schema: "APP", name: "ORDERS", qualifiedName: "APP.ORDERS", access: "write" }],
          uncertain: [{ reason: "dynamic-reference", detail: "bind variable in WHERE clause" }],
        };
      }
      return { ...EMPTY };
    });

    const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], { client });

    expect(
      res.unresolved.some(
        (u) => u.reason === "dynamic-reference" && u.detail === "bind variable in WHERE clause",
      ),
    ).toBe(true);
  });

  it("degrades one statement to routine-body-unanalyzed (not a thrown error) when the sidecar client rejects mid-package", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = stubClient((params) => {
      if (/UPDATE\s+orders/i.test(params.sql)) throw new Error("sidecar timeout");
      if (/DELETE\s+FROM\s+order_audit/i.test(params.sql)) {
        return {
          ...EMPTY,
          tables: [
            {
              schema: "APP",
              name: "ORDER_AUDIT",
              qualifiedName: "APP.ORDER_AUDIT",
              access: "write",
            },
          ],
        };
      }
      return { ...EMPTY };
    });

    const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, [], { client });

    expect(res.analyzed).toBe(1);
    expect(
      res.unresolved.some(
        (u) => u.member === "recalc_totals" && u.reason === "routine-body-unanalyzed",
      ),
    ).toBe(true);
    // The other member's statement in the same package is still processed.
    expect(recorded.edges.some((e) => e.toQualifiedName === "APP.ORDER_AUDIT")).toBe(true);
  });

  it("skips a Tier-1 dependency row missing a referenced name instead of erroring", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = fixtureClient();
    const depsWithBlank: DbDependencyInfo[] = [
      ...TIER1_DEPS,
      {
        schema: "APP",
        name: "ORDER_PKG",
        type: "PACKAGE BODY",
        referencedSchema: "APP",
        referencedName: "",
        referencedType: "TABLE",
      },
    ];

    const res = await extractPlsqlPackageLineage(writer, [ORDER_PKG], fetchBody, depsWithBlank, {
      client,
    });

    expect(res.gaps).toEqual([{ package: "app.order_pkg", table: "app.customers" }]);
  });

  it("handles a schema-less package/table/dependency (Oracle current-schema resolution) without a schema prefix", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const noSchemaPkg: DbPackageInfo = { ...ORDER_PKG, schema: "" };
    const fetchBody: PackageBodyFetcher = async () => ORDER_PKG_BODY;
    const client = stubClient((params) => {
      if (/UPDATE\s+orders/i.test(params.sql)) {
        return {
          ...EMPTY,
          tables: [{ schema: "", name: "ORDERS", qualifiedName: "ORDERS", access: "write" }],
        };
      }
      return { ...EMPTY };
    });
    const noSchemaDeps: DbDependencyInfo[] = [
      {
        schema: "",
        name: "ORDER_PKG",
        type: "PACKAGE BODY",
        referencedSchema: "",
        referencedName: "CUSTOMERS",
        referencedType: "",
      },
    ];

    const res = await extractPlsqlPackageLineage(writer, [noSchemaPkg], fetchBody, noSchemaDeps, {
      client,
    });

    expect(res.gaps).toEqual([{ package: "order_pkg", table: "customers" }]);
    const ordersEdge = recorded.edges.find((e) => e.toQualifiedName === "ORDERS");
    expect(ordersEdge).toBeTruthy();
    const ordersSym = recorded.symbols.find(
      (s) => s.kind === "table" && s.qualifiedName === "orders",
    );
    expect(ordersSym).toBeTruthy();
  });
});

/** Helper: recover the symbol id assigned to an already-recorded symbol by
 * re-deriving its position (the fake prisma assigns ids in creation order). */
async function idOf(recorded: Recorded, sym: SchemaSymbolCreateData): Promise<string> {
  const idx = recorded.symbols.indexOf(sym);
  return `sym-${idx + 1}`;
}
