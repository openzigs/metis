/**
 * Tests for the Tier-1 routine-dependency extractor — Epic #881 Phase 1 (#890).
 *
 * The schema graph writer is in-memory (fake Prisma); no real DB, no sidecar.
 * Verifies coarse `calls` edges land with `source = "catalog-deps"` and the
 * explicit `{ tier: 1, coarse: true, direction: "unknown" }` marker, that a
 * referenced routine (PACKAGE/PROCEDURE/FUNCTION) lands on a routine symbol
 * while a referenced table/view lands on a table symbol, canonical-name
 * dedupe across rows, and per-row resilience to malformed input.
 */
import { describe, expect, it } from "vitest";
import type { DbDependencyInfo } from "@metis/shared";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";
import {
  extractRoutineDependencies,
  TIER1_COARSE_METADATA,
} from "../src/lib/code-graph/routine-dependency-extractor.js";

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

const PACKAGE_TO_TABLE: DbDependencyInfo = {
  schema: "APP",
  name: "CALC_TOTAL",
  type: "PACKAGE",
  referencedSchema: "APP",
  referencedName: "ORDERS",
  referencedType: "TABLE",
};

describe("extractRoutineDependencies (#890)", () => {
  it("emits a coarse `calls` edge (routine → table), source catalog-deps", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");

    const res = await extractRoutineDependencies(writer, [PACKAGE_TO_TABLE]);

    expect(res).toEqual({ edges: 1, routines: 1 });
    expect(recorded.edges).toHaveLength(1);
    expect(recorded.edges[0]).toMatchObject({
      kind: "calls",
      source: "catalog-deps",
      toQualifiedName: "app.orders",
    });
    // The `from` side is a routine symbol (kind defaults to "procedure" for PACKAGE).
    const fromSym = recorded.symbols.find((s) => s.qualifiedName === "app.calc_total");
    expect(fromSym).toMatchObject({ kind: "procedure", source: "catalog-deps" });
    // The `to` side is a table symbol.
    const toSym = recorded.symbols.find((s) => s.qualifiedName === "app.orders");
    expect(toSym).toMatchObject({ kind: "table", source: "catalog-deps" });
  });

  it("carries the explicit Tier-1 coarse marker on CodeEdge.metadata (direction unknown)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");

    await extractRoutineDependencies(writer, [PACKAGE_TO_TABLE]);

    expect(recorded.edges[0].metadata).toBe(JSON.stringify(TIER1_COARSE_METADATA));
    expect(JSON.parse(recorded.edges[0].metadata as string)).toEqual({
      tier: 1,
      coarse: true,
      direction: "unknown",
    });
  });

  it("routes a referenced FUNCTION to a routine symbol, not a table", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const dep: DbDependencyInfo = {
      schema: "APP",
      name: "ORCHESTRATOR",
      type: "PROCEDURE",
      referencedSchema: "APP",
      referencedName: "CALC_TOTAL",
      referencedType: "FUNCTION",
    };

    await extractRoutineDependencies(writer, [dep]);

    const toSym = recorded.symbols.find((s) => s.qualifiedName === "app.calc_total");
    expect(toSym).toMatchObject({ kind: "function", source: "catalog-deps" });
    expect(recorded.edges[0].toQualifiedName).toBe("app.calc_total");
  });

  it("routes a referenced routine with no referencedSchema onto the USER_-scoped identity", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const dep: DbDependencyInfo = {
      schema: "APP",
      name: "ORCHESTRATOR",
      type: "PROCEDURE",
      referencedSchema: "",
      referencedName: "CALC_TOTAL",
      referencedType: "FUNCTION",
    };

    await extractRoutineDependencies(writer, [dep]);

    const toSym = recorded.symbols.find((s) => s.qualifiedName === "calc_total");
    expect(toSym).toMatchObject({ kind: "function", source: "catalog-deps" });
    expect(recorded.edges[0].toQualifiedName).toBe("calc_total");
  });

  it("routes a referenced PACKAGE BODY dependency onto the same procedure-kind symbol as PACKAGE", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const specDep: DbDependencyInfo = {
      schema: "APP",
      name: "PKG",
      type: "PACKAGE",
      referencedSchema: "APP",
      referencedName: "ORDERS",
      referencedType: "TABLE",
    };
    const bodyDep: DbDependencyInfo = {
      schema: "APP",
      name: "PKG",
      type: "PACKAGE BODY",
      referencedSchema: "APP",
      referencedName: "ORDER_ITEMS",
      referencedType: "TABLE",
    };

    const res = await extractRoutineDependencies(writer, [specDep, bodyDep]);

    // PACKAGE and PACKAGE BODY dependency rows fold onto ONE routine symbol.
    expect(res.routines).toBe(1);
    expect(res.edges).toBe(2);
    const routineSymbols = recorded.symbols.filter((s) => s.qualifiedName === "app.pkg");
    expect(routineSymbols).toHaveLength(1);
  });

  it("canonicalizes qualified names the same way the rest of the schema graph does (lower-cased, schema-qualified)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const dep: DbDependencyInfo = {
      schema: "APP",
      name: "Calc_Total",
      type: "PACKAGE",
      referencedSchema: "APP",
      referencedName: "Orders",
      referencedType: "TABLE",
    };

    await extractRoutineDependencies(writer, [dep]);

    expect(recorded.symbols.some((s) => s.qualifiedName === "app.calc_total")).toBe(true);
    expect(recorded.symbols.some((s) => s.qualifiedName === "app.orders")).toBe(true);
    expect(recorded.edges[0].toQualifiedName).toBe("app.orders");
  });

  it("dedupes the routine count across multiple dependency rows for the same routine", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const depA: DbDependencyInfo = { ...PACKAGE_TO_TABLE };
    const depB: DbDependencyInfo = {
      ...PACKAGE_TO_TABLE,
      referencedName: "ORDER_ITEMS",
    };

    const res = await extractRoutineDependencies(writer, [depA, depB]);

    expect(res.routines).toBe(1);
    expect(res.edges).toBe(2);
    // Both edges originate from the SAME `from` symbol id.
    expect(recorded.edges[0].fromSymbolId).toBe(recorded.edges[1].fromSymbolId);
  });

  it("falls back to no-schema (USER_-scoped identity) when schema/referencedSchema are empty strings", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const dep: DbDependencyInfo = {
      schema: "",
      name: "CALC_TOTAL",
      type: "FUNCTION",
      referencedSchema: "",
      referencedName: "ORDERS",
      referencedType: "TABLE",
    };

    const res = await extractRoutineDependencies(writer, [dep]);

    expect(res).toEqual({ edges: 1, routines: 1 });
    expect(
      recorded.symbols.some((s) => s.qualifiedName === "calc_total" && s.kind === "function"),
    ).toBe(true);
    expect(recorded.symbols.some((s) => s.qualifiedName === "orders" && s.kind === "table")).toBe(
      true,
    );
    expect(recorded.edges[0].toQualifiedName).toBe("orders");
  });

  it("skips a row missing a name or referencedName without aborting the rest", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const badName: DbDependencyInfo = { ...PACKAGE_TO_TABLE, name: "" };
    const badReferenced: DbDependencyInfo = { ...PACKAGE_TO_TABLE, referencedName: "" };

    const res = await extractRoutineDependencies(writer, [
      badName,
      badReferenced,
      PACKAGE_TO_TABLE,
    ]);

    expect(res).toEqual({ edges: 1, routines: 1 });
    expect(recorded.edges).toHaveLength(1);
  });

  it("returns a zeroed result for an empty dependency list (no writer calls)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");

    const res = await extractRoutineDependencies(writer, []);

    expect(res).toEqual({ edges: 0, routines: 0 });
    expect(recorded.symbols).toHaveLength(0);
    expect(recorded.edges).toHaveLength(0);
  });
});
