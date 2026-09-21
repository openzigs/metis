import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DbSchemaSnapshot } from "@metis/shared";
import {
  LiveSchemaIndex,
  loadLiveSchema,
  parseDdlFile,
  persistDdlFile,
  persistLiveRoutines,
  persistLiveSchema,
} from "../src/lib/impact-analysis/live-schema-ingest.js";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";

const ddl = readFileSync(join(__dirname, "fixtures", "ddl", "schema.sql"), "utf8");

function snapshot(): DbSchemaSnapshot {
  return {
    connectorId: "conn-1",
    driver: "postgres",
    schema: "public",
    extractedAt: new Date().toISOString(),
    durationMs: 12,
    tables: [
      {
        schema: "crm",
        name: "customers",
        columns: [
          {
            name: "id",
            dataType: "bigint",
            nullable: false,
            isPrimaryKey: true,
            isForeignKey: false,
          },
          {
            name: "email_address",
            dataType: "varchar(255)",
            nullable: false,
            isPrimaryKey: false,
            isForeignKey: false,
          },
        ],
        foreignKeys: [],
        indexes: [],
      },
    ],
  };
}

function fakeWriter(): {
  writer: SchemaGraphWriter;
  symbols: SchemaSymbolCreateData[];
  edges: SchemaEdgeCreateData[];
} {
  const symbols: SchemaSymbolCreateData[] = [];
  const edges: SchemaEdgeCreateData[] = [];
  let n = 0;
  const prisma: SchemaGraphPrisma = {
    codeSymbol: {
      create: async ({ data }) => {
        symbols.push(data);
        return { id: `${data.kind}-${++n}` };
      },
    },
    codeEdge: { create: async ({ data }) => void edges.push(data) },
  };
  return { writer: new SchemaGraphWriter(prisma, "g", "p"), symbols, edges };
}

describe("LiveSchemaIndex", () => {
  const index = LiveSchemaIndex.fromSnapshot(snapshot());

  it("resolves tables by schema-qualified and bare name", () => {
    expect(index.getTable("customers", "crm")?.name).toBe("customers");
    expect(index.getTable("customers")?.name).toBe("customers");
    expect(index.getTable("CUSTOMERS")?.name).toBe("customers");
  });

  it("resolves columns case-insensitively", () => {
    expect(index.getColumn("customers", "Email_Address")?.dataType).toBe("varchar(255)");
    expect(index.getColumn("customers", "missing")).toBeNull();
  });

  it("reconciles matched / table-not-found / column-not-found", () => {
    expect(index.reconcile({ table: "customers", schema: "crm" })).toBe("matched");
    expect(index.reconcile({ table: "customers", column: "id" })).toBe("matched");
    expect(index.reconcile({ table: "ghosts" })).toBe("table-not-found");
    expect(index.reconcile({ table: "customers", column: "nope" })).toBe("column-not-found");
  });
});

describe("loadLiveSchema", () => {
  it("returns null when no introspector or connector is given", async () => {
    expect(await loadLiveSchema(null, "conn-1")).toBeNull();
    expect(await loadLiveSchema(async () => snapshot(), null)).toBeNull();
  });

  it("returns an index from a successful introspection", async () => {
    const idx = await loadLiveSchema(async () => snapshot(), "conn-1");
    expect(idx?.size).toBe(1);
  });

  it("returns null when introspection throws (never blocks the run)", async () => {
    const idx = await loadLiveSchema(async () => {
      throw new Error("connection refused");
    }, "conn-1");
    expect(idx).toBeNull();
  });
});

describe("persistLiveSchema", () => {
  it("writes live-db table/column symbols with real types", async () => {
    const { writer, symbols } = fakeWriter();
    const index = LiveSchemaIndex.fromSnapshot(snapshot());
    const counts = await persistLiveSchema(writer, [index.getTable("customers")!]);
    expect(counts).toEqual({ tables: 1, columns: 2 });
    expect(symbols.every((s) => s.source === "live-db")).toBe(true);
  });
});

describe("persistLiveRoutines (#301)", () => {
  it("writes live-db procedure/function symbols (body never stored)", async () => {
    const { writer, symbols } = fakeWriter();
    const counts = await persistLiveRoutines(writer, [
      { schema: "app", name: "calc_total", type: "function", signature: "() RETURNS numeric" },
      { schema: "app", name: "do_sync", type: "procedure", signature: "()" },
    ]);
    expect(counts).toEqual({ routines: 2 });
    expect(symbols.map((s) => s.kind)).toEqual(["function", "procedure"]);
    expect(symbols.every((s) => s.source === "live-db")).toBe(true);
    expect(symbols.map((s) => s.qualifiedName)).toEqual(["app.calc_total", "app.do_sync"]);
    // The signature is metadata only — it is NOT persisted as the symbol body.
    expect(symbols.every((s) => !("signature" in s))).toBe(true);
  });

  it("returns a zero count for an empty routine list", async () => {
    const { writer, symbols } = fakeWriter();
    const counts = await persistLiveRoutines(writer, []);
    expect(counts).toEqual({ routines: 0 });
    expect(symbols).toHaveLength(0);
  });
});

describe("parseDdlFile", () => {
  const tables = parseDdlFile(ddl);

  it("parses CREATE TABLE with schema-qualified names", () => {
    expect(tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual([
      "crm.customers",
      "shop.orders",
    ]);
  });

  it("captures columns and types, skipping constraints", () => {
    const orders = tables.find((t) => t.name === "orders")!;
    expect([...orders.columns.keys()].sort()).toEqual(["customer_id", "id", "status", "total"]);
    expect(orders.columns.get("total")?.dataType).toBe("numeric(12,2)");
  });

  it("flags primary keys and not-null", () => {
    const customers = tables.find((t) => t.name === "customers")!;
    expect(customers.columns.get("id")?.isPrimaryKey).toBe(true);
    expect(customers.columns.get("email_address")?.nullable).toBe(false);
    expect(customers.columns.get("display_name")?.nullable).toBe(true);
  });
});

describe("persistDdlFile", () => {
  it("writes ddl-file table/column symbols", async () => {
    const { writer, symbols } = fakeWriter();
    const counts = await persistDdlFile(writer, "db/schema.sql", ddl);
    expect(counts.tables).toBe(2);
    expect(symbols.every((s) => s.source === "ddl-file")).toBe(true);
    expect(symbols.some((s) => s.kind === "table" && s.qualifiedName === "shop.orders")).toBe(true);
  });
});
