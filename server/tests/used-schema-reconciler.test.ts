/**
 * Unit tests for the full-schema vs code-edge reconciler — Epic #292 (#296).
 *
 * The reconciler is a PURE function: it joins introspected `DbTableInfo[]` with
 * the schema-graph edges (keyed by schema/table/column) and emits one
 * {@link ReconciledObject} per table AND column, carrying inbound-edge evidence.
 * No DB, no network. We assert the join, evidence preservation (including
 * unmatched `table-not-found`/`column-not-found` edges), and determinism.
 */
import { describe, expect, it } from "vitest";
import type { DbRoutineInfo, DbTableInfo } from "@metis/shared";
import {
  reconcileUsedRoutines,
  reconcileUsedSchema,
  type InboundRoutineEdge,
  type InboundSchemaEdge,
} from "../src/lib/impact-analysis/used-schema-reconciler.js";

function table(
  schema: string,
  name: string,
  cols: { name: string; dataType?: string }[],
): DbTableInfo {
  return {
    schema,
    name,
    columns: cols.map((c) => ({
      name: c.name,
      dataType: c.dataType ?? "text",
      nullable: true,
      isPrimaryKey: false,
      isForeignKey: false,
    })),
    foreignKeys: [],
    indexes: [],
  };
}

const SCHEMA: DbTableInfo[] = [
  table("public", "users", [{ name: "id", dataType: "uuid" }, { name: "email" }]),
  table("public", "orders", [{ name: "id" }, { name: "total" }]),
  table("public", "audit_log", [{ name: "id" }]),
];

describe("reconcileUsedSchema", () => {
  it("emits one object per table and per column from the full schema", () => {
    const objects = reconcileUsedSchema(SCHEMA, []);
    const tables = objects.filter((o) => o.kind === "table");
    const columns = objects.filter((o) => o.kind === "column");
    expect(tables.map((t) => t.tableName)).toEqual([
      "public.audit_log",
      "public.orders",
      "public.users",
    ]);
    // 1 + 2 + 2 columns
    expect(columns).toHaveLength(5);
    // Every full-schema object is marked as existing.
    expect(objects.every((o) => o.existsInSchema)).toBe(true);
  });

  it("attaches inbound-edge evidence to the matching table object", () => {
    const edges: InboundSchemaEdge[] = [
      {
        kind: "reads",
        source: "mybatis",
        fromQualifiedName: "UserMapper.findById",
        tableQualifiedName: "public.users",
        columnName: null,
        reconciliation: "matched",
      },
    ];
    const objects = reconcileUsedSchema(SCHEMA, edges);
    const users = objects.find((o) => o.kind === "table" && o.tableName === "public.users");
    expect(users?.evidence).toHaveLength(1);
    expect(users?.evidence[0]).toMatchObject({
      edgeKind: "reads",
      source: "mybatis",
      fromQualifiedName: "UserMapper.findById",
      reconciliation: "matched",
    });
    // A table with no edge has empty evidence.
    const orders = objects.find((o) => o.kind === "table" && o.tableName === "public.orders");
    expect(orders?.evidence).toEqual([]);
  });

  it("routes a column edge to the column object, not the table", () => {
    const edges: InboundSchemaEdge[] = [
      {
        kind: "writes",
        source: "orm",
        fromQualifiedName: "OrderService.markPaid",
        tableQualifiedName: "public.orders",
        columnName: "total",
        reconciliation: "matched",
      },
    ];
    const objects = reconcileUsedSchema(SCHEMA, edges);
    const totalCol = objects.find(
      (o) => o.kind === "column" && o.tableName === "public.orders" && o.columnName === "total",
    );
    expect(totalCol?.evidence).toHaveLength(1);
    expect(totalCol?.evidence[0].edgeKind).toBe("writes");
    // The table itself gets no direct evidence from a column edge.
    const orders = objects.find((o) => o.kind === "table" && o.tableName === "public.orders");
    expect(orders?.evidence).toEqual([]);
  });

  it("matches case-insensitively and tolerates a bare (schema-less) table name", () => {
    const edges: InboundSchemaEdge[] = [
      {
        kind: "reads",
        source: "mybatis",
        fromQualifiedName: "M.x",
        tableQualifiedName: "USERS", // no schema, different case
        columnName: "EMAIL",
        reconciliation: null,
      },
    ];
    const objects = reconcileUsedSchema(SCHEMA, edges);
    const emailCol = objects.find(
      (o) => o.kind === "column" && o.tableName === "public.users" && o.columnName === "email",
    );
    expect(emailCol?.evidence).toHaveLength(1);
  });

  it("preserves an unmatched table-not-found edge as a synthetic phantom object", () => {
    const edges: InboundSchemaEdge[] = [
      {
        kind: "persists-to",
        source: "ddl-file",
        fromQualifiedName: "LegacyDao.save",
        tableQualifiedName: "public.legacy_thing",
        columnName: null,
        reconciliation: "table-not-found",
      },
    ];
    const objects = reconcileUsedSchema(SCHEMA, edges);
    const phantom = objects.find(
      (o) => o.kind === "table" && o.tableName === "public.legacy_thing",
    );
    expect(phantom).toBeDefined();
    expect(phantom?.existsInSchema).toBe(false);
    expect(phantom?.evidence[0].reconciliation).toBe("table-not-found");
  });

  it("preserves an unmatched column-not-found edge as a phantom column object", () => {
    const edges: InboundSchemaEdge[] = [
      {
        kind: "reads",
        source: "orm",
        fromQualifiedName: "UserDao.read",
        tableQualifiedName: "public.users",
        columnName: "deleted_at",
        reconciliation: "column-not-found",
      },
    ];
    const objects = reconcileUsedSchema(SCHEMA, edges);
    const phantom = objects.find(
      (o) => o.kind === "column" && o.tableName === "public.users" && o.columnName === "deleted_at",
    );
    expect(phantom).toBeDefined();
    expect(phantom?.existsInSchema).toBe(false);
    expect(phantom?.evidence[0].reconciliation).toBe("column-not-found");
  });

  it("carries live column type onto column objects from introspection", () => {
    const objects = reconcileUsedSchema(SCHEMA, []);
    const idCol = objects.find(
      (o) => o.kind === "column" && o.tableName === "public.users" && o.columnName === "id",
    );
    expect(idCol?.columnType).toBe("uuid");
  });

  it("is deterministic — stable sort by table then column regardless of edge order", () => {
    const a = reconcileUsedSchema(SCHEMA, []);
    const b = reconcileUsedSchema([...SCHEMA].reverse(), []);
    expect(a.map((o) => `${o.tableName}.${o.columnName ?? ""}`)).toEqual(
      b.map((o) => `${o.tableName}.${o.columnName ?? ""}`),
    );
  });

  it("aggregates multiple edges onto the same object", () => {
    const edges: InboundSchemaEdge[] = [
      {
        kind: "reads",
        source: "mybatis",
        fromQualifiedName: "A.read",
        tableQualifiedName: "public.users",
        columnName: null,
        reconciliation: "matched",
      },
      {
        kind: "writes",
        source: "orm",
        fromQualifiedName: "B.write",
        tableQualifiedName: "public.users",
        columnName: null,
        reconciliation: "matched",
      },
    ];
    const objects = reconcileUsedSchema(SCHEMA, edges);
    const users = objects.find((o) => o.kind === "table" && o.tableName === "public.users");
    expect(users?.evidence).toHaveLength(2);
  });

  it("returns an empty array for an empty schema and no edges", () => {
    expect(reconcileUsedSchema([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Routine reconciler — Epic #293 Phase 2 (#302).
// ---------------------------------------------------------------------------

function routine(schema: string, name: string, type: DbRoutineInfo["type"]): DbRoutineInfo {
  return { schema, name, type, signature: "" };
}

describe("reconcileUsedRoutines (#302)", () => {
  const ROUTINES: DbRoutineInfo[] = [
    routine("app", "calc_total", "function"),
    routine("app", "do_sync", "procedure"),
  ];

  it("seeds one object per live routine with the routine kind and qualified name", () => {
    const objects = reconcileUsedRoutines(ROUTINES, []);
    expect(objects.map((o) => `${o.kind}:${o.tableName}`)).toEqual([
      "function:app.calc_total",
      "procedure:app.do_sync",
    ]);
    expect(objects.every((o) => o.columnName === null && o.existsInSchema)).toBe(true);
  });

  it("attaches an inbound executes edge as evidence (used routine)", () => {
    const edges: InboundRoutineEdge[] = [
      {
        kind: "executes",
        source: "live-db",
        fromQualifiedName: "svc.runReport",
        routineQualifiedName: "app.calc_total",
        routineKind: "function",
        reconciliation: null,
      },
    ];
    const objects = reconcileUsedRoutines(ROUTINES, edges);
    const fn = objects.find((o) => o.tableName === "app.calc_total");
    expect(fn?.evidence).toHaveLength(1);
    expect(fn?.evidence[0].edgeKind).toBe("executes");
  });

  it("resolves a schema-less edge to the live routine via the bare-name fallback", () => {
    const edges: InboundRoutineEdge[] = [
      {
        kind: "executes",
        source: "live-db",
        fromQualifiedName: "svc.x",
        routineQualifiedName: "calc_total",
        routineKind: "function",
        reconciliation: null,
      },
    ];
    const objects = reconcileUsedRoutines(ROUTINES, edges);
    const fn = objects.find((o) => o.tableName === "app.calc_total");
    expect(fn?.evidence).toHaveLength(1);
  });

  it("creates a phantom (existsInSchema=false) for an executes edge to a vanished routine", () => {
    const edges: InboundRoutineEdge[] = [
      {
        kind: "executes",
        source: "live-db",
        fromQualifiedName: "svc.x",
        routineQualifiedName: "app.gone",
        routineKind: "procedure",
        reconciliation: null,
      },
    ];
    const objects = reconcileUsedRoutines(ROUTINES, edges);
    const phantom = objects.find((o) => o.tableName === "app.gone");
    expect(phantom?.existsInSchema).toBe(false);
    expect(phantom?.evidence).toHaveLength(1);
  });

  it("keeps a procedure and a same-named function as distinct objects", () => {
    const objects = reconcileUsedRoutines(
      [routine("app", "thing", "procedure"), routine("app", "thing", "function")],
      [],
    );
    expect(objects).toHaveLength(2);
    expect(new Set(objects.map((o) => o.kind))).toEqual(new Set(["procedure", "function"]));
  });

  it("returns an empty array for no routines and no edges", () => {
    expect(reconcileUsedRoutines([], [])).toEqual([]);
  });
});
