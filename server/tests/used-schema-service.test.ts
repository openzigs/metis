/**
 * Unit tests for the used-schema orchestration service — Epic #292 (#297).
 *
 * `readInboundSchemaEdges` projects persisted `CodeEdge`/`CodeSymbol` rows into
 * the {@link InboundSchemaEdge} shape the reconciler consumes — scoped to one
 * project. `computeUsageClassification` wires introspection → reconciler →
 * classifier → persistence. Prisma and the introspector are fully mocked; no DB,
 * no network (the #289 stale-DB lesson).
 */
import { describe, expect, it, vi } from "vitest";
import type { DbRoutineInfo, DbTableInfo } from "@metis/shared";
import {
  readInboundRoutineEdges,
  readInboundSchemaEdges,
  computeUsageClassification,
} from "../src/lib/impact-analysis/used-schema-service.js";

function liveTable(schema: string, name: string, cols: string[]): DbTableInfo {
  return {
    schema,
    name,
    columns: cols.map((c) => ({
      name: c,
      dataType: "text",
      nullable: true,
      isPrimaryKey: false,
      isForeignKey: false,
    })),
    foreignKeys: [],
    indexes: [],
  };
}

describe("readInboundSchemaEdges", () => {
  it("joins schema edges to their target table/column symbols, scoped to project", async () => {
    const edgeFindMany = vi.fn(async () => [
      {
        fromSymbolId: "s_code",
        toSymbolId: "s_tab",
        kind: "reads",
        source: "mybatis",
      },
      {
        fromSymbolId: "s_code2",
        toSymbolId: "s_col",
        kind: "writes",
        source: "orm",
      },
    ]);
    const symbolFindMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => {
      const map: Record<string, unknown> = {
        s_tab: {
          id: "s_tab",
          kind: "table",
          name: "users",
          qualifiedName: "public.users",
          source: "mybatis",
        },
        s_col: {
          id: "s_col",
          kind: "column",
          name: "email",
          qualifiedName: "public.users.email",
          source: "orm",
        },
        s_code: {
          id: "s_code",
          kind: "method",
          name: "find",
          qualifiedName: "M.find",
          source: null,
        },
        s_code2: {
          id: "s_code2",
          kind: "method",
          name: "save",
          qualifiedName: "M.save",
          source: null,
        },
      };
      return args.where.id.in.map((id) => map[id]).filter(Boolean);
    });
    const prisma = {
      codeEdge: { findMany: edgeFindMany },
      codeSymbol: { findMany: symbolFindMany },
    };

    const edges = await readInboundSchemaEdges(prisma as never, "proj_1");

    // Project scoping is enforced in the edge query.
    expect(edgeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: "proj_1" }) }),
    );
    expect(edges).toHaveLength(2);
    const tableEdge = edges.find((e) => e.columnName === null);
    expect(tableEdge).toMatchObject({
      kind: "reads",
      tableQualifiedName: "public.users",
      columnName: null,
      fromQualifiedName: "M.find",
    });
    const colEdge = edges.find((e) => e.columnName !== null);
    expect(colEdge).toMatchObject({
      kind: "writes",
      tableQualifiedName: "public.users",
      columnName: "email",
      fromQualifiedName: "M.save",
    });
  });

  it("returns an empty list when the project has no schema edges", async () => {
    const prisma = {
      codeEdge: { findMany: vi.fn(async () => []) },
      codeSymbol: { findMany: vi.fn(async () => []) },
    };
    expect(await readInboundSchemaEdges(prisma as never, "p")).toEqual([]);
  });

  it("falls back through the source chain and tolerates a missing from-symbol", async () => {
    const prisma = {
      codeEdge: {
        findMany: vi.fn(async () => [
          // target.source null → fall back to edge.source ("ddl-file").
          { fromSymbolId: "missing-from", toSymbolId: "t1", kind: "reads", source: "ddl-file" },
          // both target.source and edge.source null → fall back to "mybatis".
          { fromSymbolId: "missing-from", toSymbolId: "t2", kind: "reads", source: null },
        ]),
      },
      codeSymbol: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
          const map: Record<string, unknown> = {
            t1: { id: "t1", kind: "table", name: "a", qualifiedName: "public.a", source: null },
            t2: { id: "t2", kind: "table", name: "b", qualifiedName: "public.b", source: null },
          };
          return args.where.id.in.map((id) => map[id]).filter(Boolean);
        }),
      },
    };
    const edges = await readInboundSchemaEdges(prisma as never, "p");
    expect(edges.find((e) => e.tableQualifiedName === "public.a")?.source).toBe("ddl-file");
    expect(edges.find((e) => e.tableQualifiedName === "public.b")?.source).toBe("mybatis");
    // from-symbol absent → fromQualifiedName is null, not a throw.
    expect(edges.every((e) => e.fromQualifiedName === null)).toBe(true);
  });

  it("skips edges whose target is not a table/column symbol", async () => {
    const prisma = {
      codeEdge: {
        findMany: vi.fn(async () => [
          { fromSymbolId: "c", toSymbolId: "m", kind: "reads", source: "mybatis" },
        ]),
      },
      codeSymbol: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
          const map: Record<string, unknown> = {
            m: { id: "m", kind: "method", name: "x", qualifiedName: "C.x", source: null },
            c: { id: "c", kind: "method", name: "y", qualifiedName: "C.y", source: null },
          };
          return args.where.id.in.map((id) => map[id]).filter(Boolean);
        }),
      },
    };
    expect(await readInboundSchemaEdges(prisma as never, "p")).toEqual([]);
  });
});

describe("readInboundRoutineEdges (#302)", () => {
  it("returns executes edges whose target is a procedure/function, scoped to project", async () => {
    const edgeFindMany = vi.fn(async () => [
      { fromSymbolId: "c1", toSymbolId: "r_fn", kind: "executes", source: "live-db" },
      { fromSymbolId: "c2", toSymbolId: "r_proc", kind: "executes", source: "live-db" },
    ]);
    const symbolFindMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => {
      const map: Record<string, unknown> = {
        r_fn: {
          id: "r_fn",
          kind: "function",
          name: "calc_total",
          qualifiedName: "app.calc_total",
          source: "live-db",
        },
        r_proc: {
          id: "r_proc",
          kind: "procedure",
          name: "do_sync",
          qualifiedName: "app.do_sync",
          source: "live-db",
        },
        c1: { id: "c1", kind: "method", name: "f", qualifiedName: "Svc.f", source: null },
        c2: { id: "c2", kind: "method", name: "g", qualifiedName: "Svc.g", source: null },
      };
      return args.where.id.in.map((id) => map[id]).filter(Boolean);
    });
    const prisma = {
      codeEdge: { findMany: edgeFindMany },
      codeSymbol: { findMany: symbolFindMany },
    };
    const edges = await readInboundRoutineEdges(prisma as never, "proj_1");
    expect(edgeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj_1",
          kind: { in: ["executes", "calls"] },
        }),
      }),
    );
    expect(edges).toHaveLength(2);
    expect(edges.find((e) => e.routineKind === "function")).toMatchObject({
      kind: "executes",
      routineQualifiedName: "app.calc_total",
      fromQualifiedName: "Svc.f",
    });
  });

  it("skips a `calls` edge (routine-originating — Phase 3) and non-routine targets", async () => {
    const prisma = {
      codeEdge: {
        findMany: vi.fn(async () => [
          // `calls` edge — must be skipped here (Phase 2 only consumes executes).
          { fromSymbolId: "r_fn", toSymbolId: "t1", kind: "calls", source: "live-db" },
          // executes edge to a table (wrong target kind) — skipped.
          { fromSymbolId: "c1", toSymbolId: "t1", kind: "executes", source: "live-db" },
        ]),
      },
      codeSymbol: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
          const map: Record<string, unknown> = {
            t1: {
              id: "t1",
              kind: "table",
              name: "orders",
              qualifiedName: "app.orders",
              source: "live-db",
            },
            r_fn: {
              id: "r_fn",
              kind: "function",
              name: "fn",
              qualifiedName: "app.fn",
              source: "live-db",
            },
            c1: { id: "c1", kind: "method", name: "m", qualifiedName: "S.m", source: null },
          };
          return args.where.id.in.map((id) => map[id]).filter(Boolean);
        }),
      },
    };
    expect(await readInboundRoutineEdges(prisma as never, "p")).toEqual([]);
  });

  it("returns an empty list when the project has no routine edges", async () => {
    const prisma = {
      codeEdge: { findMany: vi.fn(async () => []) },
      codeSymbol: { findMany: vi.fn(async () => []) },
    };
    expect(await readInboundRoutineEdges(prisma as never, "p")).toEqual([]);
  });
});

describe("computeUsageClassification", () => {
  it("introspects, reconciles, classifies, and persists scoped to the project", async () => {
    const tables = [
      liveTable("public", "users", ["id", "email"]),
      liveTable("public", "orphan", ["id"]),
    ];
    const introspect = vi.fn(async () => tables);

    const edgeFindMany = vi.fn(async () => [
      { fromSymbolId: "c1", toSymbolId: "t_users", kind: "reads", source: "mybatis" },
    ]);
    const symbolFindMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => {
      const map: Record<string, unknown> = {
        t_users: {
          id: "t_users",
          kind: "table",
          name: "users",
          qualifiedName: "public.users",
          source: "mybatis",
        },
        c1: { id: "c1", kind: "method", name: "f", qualifiedName: "C.f", source: null },
      };
      return args.where.id.in.map((id) => map[id]).filter(Boolean);
    });
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const createMany = vi.fn(async () => ({ count: 5 }));
    const tx = { schemaUsageClassification: { deleteMany, createMany } };
    const prisma = {
      codeEdge: { findMany: edgeFindMany },
      codeSymbol: { findMany: symbolFindMany },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };

    const result = await computeUsageClassification(prisma as never, "proj_1", introspect);

    expect(introspect).toHaveBeenCalledWith("proj_1");
    expect(deleteMany).toHaveBeenCalledWith({ where: { projectId: "proj_1" } });
    // users (table) used; users.id/email unreferenced; orphan + orphan.id unreferenced.
    const data = (
      createMany.mock.calls[0][0] as { data: { usageClass: string; tableName: string }[] }
    ).data;
    const usersTable = data.find((d) => d.tableName === "public.users");
    expect(usersTable?.usageClass).toBe("used");
    const orphan = data.find((d) => d.tableName === "public.orphan");
    expect(orphan?.usageClass).toBe("unreferenced");
    expect(result.persisted).toBe(5);
    expect(result.classified.length).toBe(data.length);
  });

  it("never auto-recommends dropping uncertain objects (table-not-found stays uncertain)", async () => {
    const introspect = vi.fn(async () => [liveTable("public", "users", ["id"])]);
    const prisma = {
      codeEdge: {
        findMany: vi.fn(async () => [
          { fromSymbolId: "c1", toSymbolId: "ghost", kind: "writes", source: "ddl-file" },
        ]),
      },
      codeSymbol: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
          const map: Record<string, unknown> = {
            ghost: {
              id: "ghost",
              kind: "table",
              name: "ghost",
              qualifiedName: "public.ghost",
              source: "ddl-file",
            },
            c1: { id: "c1", kind: "method", name: "f", qualifiedName: "C.f", source: null },
          };
          return args.where.id.in.map((id) => map[id]).filter(Boolean);
        }),
      },
      $transaction: vi.fn(
        async (
          fn: (t: {
            schemaUsageClassification: { deleteMany: () => unknown; createMany: () => unknown };
          }) => unknown,
        ) =>
          fn({
            schemaUsageClassification: {
              deleteMany: vi.fn(async () => ({ count: 0 })),
              createMany: vi.fn(async () => ({ count: 0 })),
            },
          }),
      ),
    };
    // A reconciler can't compute reconciliation without a live index here; the
    // ghost table is absent from introspection so it's a phantom with a null
    // reconciliation edge → uncertain (dynamic-reference), never safe-to-review.
    const result = await computeUsageClassification(prisma as never, "p", introspect);
    const ghost = result.classified.find((c) => c.tableName === "public.ghost");
    expect(ghost?.usageClass).toBe("uncertain");
    expect(ghost?.safeToReview).toBe(false);
  });

  it("classifies routines used/unreferenced alongside tables when a routines introspector is given (#302)", async () => {
    const introspect = vi.fn(async () => [liveTable("public", "users", ["id"])]);
    const routines: DbRoutineInfo[] = [
      { schema: "app", name: "calc_total", type: "function", signature: "" },
      { schema: "app", name: "never_called", type: "procedure", signature: "" },
    ];
    const routinesIntrospect = vi.fn(async () => routines);

    // Kind-aware edge mock: object-edge query vs routine-edge query.
    const edgeFindMany = vi.fn(async (args: { where: { kind: { in: string[] } } }) => {
      const kinds = args.where.kind.in;
      if (kinds.includes("executes")) {
        // routine edges: code executes calc_total
        return [{ fromSymbolId: "c1", toSymbolId: "r_fn", kind: "executes", source: "live-db" }];
      }
      return []; // no table/column edges
    });
    const symbolFindMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => {
      const map: Record<string, unknown> = {
        r_fn: {
          id: "r_fn",
          kind: "function",
          name: "calc_total",
          qualifiedName: "app.calc_total",
          source: "live-db",
        },
        c1: { id: "c1", kind: "method", name: "f", qualifiedName: "Svc.f", source: null },
      };
      return args.where.id.in.map((id) => map[id]).filter(Boolean);
    });
    const createMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      codeEdge: { findMany: edgeFindMany },
      codeSymbol: { findMany: symbolFindMany },
      $transaction: vi.fn(
        async (
          fn: (t: {
            schemaUsageClassification: { deleteMany: unknown; createMany: unknown };
          }) => unknown,
        ) =>
          fn({
            schemaUsageClassification: {
              deleteMany: vi.fn(async () => ({ count: 0 })),
              createMany,
            },
          }),
      ),
    };

    const result = await computeUsageClassification(
      prisma as never,
      "proj_r",
      introspect,
      routinesIntrospect,
    );

    expect(routinesIntrospect).toHaveBeenCalledWith("proj_r");
    const fn = result.classified.find((c) => c.tableName === "app.calc_total");
    expect(fn?.kind).toBe("function");
    expect(fn?.usageClass).toBe("used");
    const proc = result.classified.find((c) => c.tableName === "app.never_called");
    expect(proc?.kind).toBe("procedure");
    expect(proc?.usageClass).toBe("unreferenced");
    expect(proc?.safeToReview).toBe(true);
  });

  it("classifies tables only (no routine rows) when no routines introspector is supplied (#302 back-compat)", async () => {
    const introspect = vi.fn(async () => [liveTable("public", "users", ["id"])]);
    const prisma = {
      codeEdge: { findMany: vi.fn(async () => []) },
      codeSymbol: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(
        async (
          fn: (t: {
            schemaUsageClassification: { deleteMany: unknown; createMany: unknown };
          }) => unknown,
        ) =>
          fn({
            schemaUsageClassification: {
              deleteMany: vi.fn(async () => ({ count: 0 })),
              createMany: vi.fn(async () => ({ count: 0 })),
            },
          }),
      ),
    };
    const result = await computeUsageClassification(prisma as never, "p", introspect);
    expect(result.classified.every((c) => c.kind === "table" || c.kind === "column")).toBe(true);
  });
});
