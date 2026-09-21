/**
 * Unit tests for the deterministic per-requirement affected-schema context
 * (#823, Epic #820 Phase 1) — the database twin of `affected-code-context`.
 *
 * Pure render/truncation is tested in isolation; `computeAffectedSchemaContext`
 * is driven with an in-memory `SchemaImpactDataSource` + an optional
 * `LiveSchemaIndex`, so no DB/LLM is needed.
 */
import { describe, expect, it } from "vitest";
import type { SchemaEdgeKind, SchemaSource } from "@metis/shared";
import {
  computeAffectedSchemaContext,
  computeRunAffectedSchemaContext,
  renderAffectedSchemaBlock,
  estimateAffectedSchemaTokens,
  AFFECTED_SCHEMA_HEADER,
  DEFAULT_AFFECTED_SCHEMA_MAX_ROWS,
  EMPTY_AFFECTED_SCHEMA_CONTEXT,
} from "../src/lib/analysis/affected-schema-context.js";
import type {
  AffectedTableInput,
  SchemaImpactDataSource,
} from "../src/lib/impact-analysis/schema-impact.js";
import { LiveSchemaIndex, type LiveTable } from "../src/lib/impact-analysis/live-schema-ingest.js";
import { InMemoryCodeGraphDataSource } from "../src/lib/impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../src/lib/code-graph/query-service.js";
import type { RequirementCodeMatch } from "../src/lib/traceability/requirement-code-mapping.js";

// ---- Fixtures --------------------------------------------------------------

interface StubSymbol {
  id: string;
  kind: "table" | "column" | "procedure" | "function";
  name: string;
  qualifiedName: string;
  source: SchemaSource | null;
}
interface StubEdge {
  fromSymbolId: string;
  toSymbolId: string;
  kind: SchemaEdgeKind;
}

/** An in-memory `SchemaImpactDataSource` — the two reads `crossToSchema` makes. */
function stubDataSource(edges: StubEdge[], symbols: StubSymbol[]): SchemaImpactDataSource {
  return {
    async getSchemaEdgesFrom(ids: string[]) {
      return edges.filter((e) => ids.includes(e.fromSymbolId));
    },
    async getSchemaSymbolsByIds(ids: string[]) {
      return symbols.filter((s) => ids.includes(s.id));
    },
  };
}

/** Build one affected row with sensible defaults (overridable per field). */
function row(over: Partial<AffectedTableInput> & { tableName: string }): AffectedTableInput {
  const columnName = over.columnName ?? null;
  return {
    objectKind: columnName ? "column" : "table",
    tableName: over.tableName,
    columnName,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: `-- Verify ${over.tableName}`,
    source: "mybatis",
    reconciliation: null,
    confidence: 0.6,
    ...over,
  };
}

/** A live index containing `public.orders(id, total)`. */
function liveOrdersIndex(): LiveSchemaIndex {
  const tables: LiveTable[] = [
    {
      schema: "public",
      name: "orders",
      columns: new Map([
        ["id", { name: "id", dataType: "int", nullable: false, isPrimaryKey: true }],
        ["total", { name: "total", dataType: "numeric", nullable: true, isPrimaryKey: false }],
      ]),
    },
  ];
  return new LiveSchemaIndex(tables);
}

// ---- renderAffectedSchemaBlock (pure) -------------------------------------

describe("estimateAffectedSchemaTokens", () => {
  it("is 0 for the empty string and ≈len/4 otherwise", () => {
    expect(estimateAffectedSchemaTokens("")).toBe(0);
    expect(estimateAffectedSchemaTokens("abcd")).toBe(1);
    expect(estimateAffectedSchemaTokens("abcde")).toBe(2);
  });
});

describe("renderAffectedSchemaBlock", () => {
  it("returns an empty block for no rows", () => {
    expect(renderAffectedSchemaBlock([], 1000)).toEqual({
      block: "",
      tokens: 0,
      truncated: false,
    });
  });

  it("renders one line per object with the verbatim safety label", () => {
    const rows = [
      row({ tableName: "public.orders", confidence: 0.95, changeKind: "reference" }),
      row({
        tableName: "public.orders",
        columnName: "total",
        reconciliation: "matched",
        confidence: 0.85,
        suggestedDdl: "-- Verify column public.orders.total — referenced by impacted code",
      }),
    ];
    const { block, tokens, truncated } = renderAffectedSchemaBlock(rows, 100000);
    expect(truncated).toBe(false);
    // Verbatim label required by the acceptance criteria.
    expect(block).toContain("TEXT ONLY");
    expect(block).toContain("never executed");
    expect(block).toContain(AFFECTED_SCHEMA_HEADER);
    // Object identity, change kind, reconciliation, confidence, DDL text.
    expect(block).toContain(
      "public.orders [table, change=reference, reconciliation=unreconciled, conf 0.95]",
    );
    expect(block).toContain(
      "public.orders.total [column, change=reference, reconciliation=matched, conf 0.85]",
    );
    expect(block).toContain("-- Verify column public.orders.total");
    expect(tokens).toBe(estimateAffectedSchemaTokens(block));
  });

  it("de-dupes per (table, column), keeping the highest-confidence row", () => {
    const rows = [
      row({
        tableName: "public.orders",
        columnName: "total",
        confidence: 0.4,
        suggestedDdl: "-- low",
      }),
      row({
        tableName: "public.orders",
        columnName: "total",
        confidence: 0.85,
        suggestedDdl: "-- high",
      }),
    ];
    const { block } = renderAffectedSchemaBlock(rows, 100000);
    expect(block).toContain("-- high");
    expect(block).not.toContain("-- low");
    // Exactly one data line (plus the header line).
    expect(block.split("\n")).toHaveLength(2);
  });

  it("keeps the highest-confidence row regardless of input order (dedupe)", () => {
    // High row FIRST → the later low row must not displace it.
    const rows = [
      row({
        tableName: "public.orders",
        columnName: "total",
        confidence: 0.85,
        suggestedDdl: "-- high",
      }),
      row({
        tableName: "public.orders",
        columnName: "total",
        confidence: 0.4,
        suggestedDdl: "-- low",
      }),
    ];
    const { block } = renderAffectedSchemaBlock(rows, 100000);
    expect(block).toContain("-- high");
    expect(block).not.toContain("-- low");
    expect(block.split("\n")).toHaveLength(2);
  });

  it("breaks confidence ties by object identity (stable, deterministic)", () => {
    // Same table + same confidence, differing only by column → columnName tiebreak.
    const rows = [
      row({ tableName: "public.orders", columnName: "zeta", confidence: 0.7 }),
      row({ tableName: "public.orders", columnName: "alpha", confidence: 0.7 }),
    ];
    const { block } = renderAffectedSchemaBlock(rows, 100000);
    expect(block.indexOf("alpha")).toBeLessThan(block.indexOf("zeta"));
  });

  it("orders rows by confidence descending (highest signal first)", () => {
    const rows = [
      row({ tableName: "a_low", confidence: 0.4 }),
      row({ tableName: "z_high", confidence: 0.95 }),
      row({ tableName: "m_mid", confidence: 0.6 }),
    ];
    const { block } = renderAffectedSchemaBlock(rows, 100000);
    const idxHigh = block.indexOf("z_high");
    const idxMid = block.indexOf("m_mid");
    const idxLow = block.indexOf("a_low");
    expect(idxHigh).toBeLessThan(idxMid);
    expect(idxMid).toBeLessThan(idxLow);
  });

  it("caps the number of rendered rows and flags truncation (highest kept)", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ tableName: `t${i}`, confidence: 0.5 + i * 0.05 }),
    );
    const { block, truncated } = renderAffectedSchemaBlock(rows, 100000, 2);
    expect(truncated).toBe(true);
    // Only the two highest-confidence rows (t4=0.70, t3=0.65) survive the cap.
    expect(block).toContain("t4");
    expect(block).toContain("t3");
    expect(block).not.toContain("t2");
  });

  it("truncates deterministically at the token-budget boundary", () => {
    const rows = [
      row({ tableName: "public.orders", confidence: 0.9 }),
      row({ tableName: "public.customers", confidence: 0.8 }),
      row({ tableName: "public.invoices", confidence: 0.7 }),
    ];
    const full = renderAffectedSchemaBlock(rows, 100000);
    expect(full.truncated).toBe(false);

    // Exactly at the full cost → identical, not truncated (inclusive boundary).
    expect(renderAffectedSchemaBlock(rows, full.tokens)).toEqual(full);

    // One token below the full cost → must truncate, stay within budget, and be
    // byte-identical across repeated calls (determinism).
    const tight = renderAffectedSchemaBlock(rows, full.tokens - 1);
    expect(tight.truncated).toBe(true);
    expect(tight.tokens).toBeLessThanOrEqual(full.tokens - 1);
    expect(tight.block.length).toBeLessThan(full.block.length);
    expect(renderAffectedSchemaBlock(rows, full.tokens - 1)).toEqual(tight);
  });

  it("emits an empty block when not even the first row fits", () => {
    const { block, truncated } = renderAffectedSchemaBlock(
      [row({ tableName: "public.orders" })],
      1,
    );
    expect(block).toBe("");
    expect(truncated).toBe(true);
  });

  it("renders a placeholder when a row carries no suggested DDL", () => {
    const { block } = renderAffectedSchemaBlock(
      [row({ tableName: "public.orders", suggestedDdl: null })],
      100000,
    );
    expect(block).toContain("(no DDL suggested)");
  });

  it("defaults maxRows to the documented cap", () => {
    const rows = Array.from({ length: DEFAULT_AFFECTED_SCHEMA_MAX_ROWS + 3 }, (_, i) =>
      row({ tableName: `t${String(i).padStart(2, "0")}`, confidence: 0.9 - i * 0.01 }),
    );
    const { block, truncated } = renderAffectedSchemaBlock(rows, 100000);
    expect(truncated).toBe(true);
    // Header + exactly DEFAULT_AFFECTED_SCHEMA_MAX_ROWS data lines.
    expect(block.split("\n")).toHaveLength(DEFAULT_AFFECTED_SCHEMA_MAX_ROWS + 1);
  });
});

// ---- computeAffectedSchemaContext -----------------------------------------

describe("computeAffectedSchemaContext", () => {
  const symbols: StubSymbol[] = [
    {
      id: "t-orders",
      kind: "table",
      name: "orders",
      qualifiedName: "public.orders",
      source: "mybatis",
    },
    {
      id: "c-total",
      kind: "column",
      name: "total",
      qualifiedName: "public.orders.total",
      source: "mybatis",
    },
    {
      id: "t-customers",
      kind: "table",
      name: "customers",
      qualifiedName: "public.customers",
      source: "live-db",
    },
  ];
  const edges: StubEdge[] = [
    { fromSymbolId: "seed-1", toSymbolId: "t-orders", kind: "reads" },
    { fromSymbolId: "seed-1", toSymbolId: "c-total", kind: "writes" },
    { fromSymbolId: "seed-1", toSymbolId: "t-customers", kind: "reads" },
  ];

  it("crosses impacted symbols into affected tables/columns and renders a block", async () => {
    const ctx = await computeAffectedSchemaContext({
      requirementId: "NR-1",
      affectedSymbolIds: ["seed-1"],
      dataSource: stubDataSource(edges, symbols),
      tokenBudget: 100000,
    });
    expect(ctx.rows.map((r) => r.tableName)).toContain("public.orders");
    expect(ctx.rows.some((r) => r.columnName === "total")).toBe(true);
    expect(ctx.block).toContain("TEXT ONLY");
    expect(ctx.block).toContain("public.orders");
    expect(ctx.block).toContain("public.customers");
    expect(ctx.tokens).toBeGreaterThan(0);
    expect(ctx.truncated).toBe(false);
  });

  it("is deterministic — identical inputs yield byte-identical output", async () => {
    const opts = {
      requirementId: "NR-1",
      affectedSymbolIds: ["seed-1"],
      dataSource: stubDataSource(edges, symbols),
      tokenBudget: 100000,
    } as const;
    const a = await computeAffectedSchemaContext(opts);
    const b = await computeAffectedSchemaContext(opts);
    expect(a).toEqual(b);
  });

  it("reconciles against a live schema index (matched + table-not-found)", async () => {
    const ctx = await computeAffectedSchemaContext({
      requirementId: "NR-1",
      affectedSymbolIds: ["seed-1"],
      dataSource: stubDataSource(edges, symbols),
      liveIndex: liveOrdersIndex(),
      tokenBudget: 100000,
    });
    const orders = ctx.rows.find((r) => r.tableName === "public.orders" && r.columnName === null);
    const total = ctx.rows.find((r) => r.columnName === "total");
    const customers = ctx.rows.find((r) => r.tableName === "public.customers");
    // orders + orders.total exist in the live index → matched.
    expect(orders?.reconciliation).toBe("matched");
    expect(total?.reconciliation).toBe("matched");
    expect(total?.confidence).toBeCloseTo(0.85);
    // customers is absent from the live index → table-not-found + add-table DDL.
    expect(customers?.reconciliation).toBe("table-not-found");
    expect(customers?.changeKind).toBe("add-table");
    expect(customers?.confidence).toBeCloseTo(0.4);
    expect(ctx.block).toContain("CREATE TABLE public.customers");
  });

  it("passes the identity resolver through so rows carry schemaObjectIdentityId", async () => {
    const ctx = await computeAffectedSchemaContext({
      requirementId: "NR-1",
      affectedSymbolIds: ["seed-1"],
      dataSource: stubDataSource(edges, symbols),
      identityResolver: async (obj) => `identity:${obj.tableName}`,
      tokenBudget: 100000,
    });
    expect(ctx.rows.length).toBeGreaterThan(0);
    for (const r of ctx.rows) {
      expect(r.schemaObjectIdentityId).toBe(`identity:${r.tableName}`);
    }
  });

  it("uses the default budget + row cap when none is passed", async () => {
    // No tokenBudget/maxRows → the DEFAULT_* constants (1200 / 8) apply. A single
    // small object comfortably fits, so a block is produced.
    const ctx = await computeAffectedSchemaContext({
      requirementId: "NR-1",
      affectedSymbolIds: ["seed-1"],
      dataSource: stubDataSource(
        [{ fromSymbolId: "seed-1", toSymbolId: "t-orders", kind: "reads" }],
        symbols,
      ),
    });
    expect(ctx.block).toContain("public.orders");
    expect(ctx.tokens).toBeGreaterThan(0);
  });

  it("caps the block at the default max rows while keeping every row on `rows`", async () => {
    // 10 affected tables, all reachable from one seed → rows complete (10),
    // block capped at DEFAULT_AFFECTED_SCHEMA_MAX_ROWS and flagged truncated.
    const manySymbols: StubSymbol[] = Array.from({ length: 10 }, (_, i) => ({
      id: `t-${i}`,
      kind: "table" as const,
      name: `tbl${i}`,
      qualifiedName: `public.tbl${String(i).padStart(2, "0")}`,
      source: "mybatis" as SchemaSource,
    }));
    const manyEdges: StubEdge[] = manySymbols.map((s) => ({
      fromSymbolId: "seed-1",
      toSymbolId: s.id,
      kind: "reads" as SchemaEdgeKind,
    }));
    const ctx = await computeAffectedSchemaContext({
      requirementId: "NR-1",
      affectedSymbolIds: ["seed-1"],
      dataSource: stubDataSource(manyEdges, manySymbols),
      tokenBudget: 100000,
    });
    expect(ctx.rows).toHaveLength(10);
    expect(ctx.truncated).toBe(true);
    expect(ctx.block.split("\n")).toHaveLength(DEFAULT_AFFECTED_SCHEMA_MAX_ROWS + 1);
  });

  it("returns EMPTY when there are no impacted symbols", async () => {
    const ctx = await computeAffectedSchemaContext({
      requirementId: "NR-1",
      affectedSymbolIds: [],
      dataSource: stubDataSource(edges, symbols),
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_SCHEMA_CONTEXT);
  });

  it("returns EMPTY when the impacted symbols have no schema edges", async () => {
    const ctx = await computeAffectedSchemaContext({
      requirementId: "NR-1",
      affectedSymbolIds: ["seed-unmapped"],
      dataSource: stubDataSource(edges, symbols),
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_SCHEMA_CONTEXT);
    expect(ctx.block).toBe("");
  });

  it("degrades to EMPTY (no throw) when the crossing fails", async () => {
    const failing: SchemaImpactDataSource = {
      async getSchemaEdgesFrom() {
        throw new Error("boom");
      },
      async getSchemaSymbolsByIds() {
        return [];
      },
    };
    const ctx = await computeAffectedSchemaContext({
      requirementId: "NR-1",
      affectedSymbolIds: ["seed-1"],
      dataSource: failing,
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_SCHEMA_CONTEXT);
  });
});

// ---- computeRunAffectedSchemaContext (run-level, #824) ---------------------

describe("computeRunAffectedSchemaContext", () => {
  /** An empty code graph → no blast radius (mapper direct hits only). */
  const emptyGraph = new InMemoryCodeGraphDataSource([], []);
  const emptyGraphFor = (): CodeGraphDataSource => emptyGraph;

  /** One mapped code symbol whose id seeds the schema crossing. */
  const oneMatch: RequirementCodeMatch[] = [
    {
      codeSymbolId: "seed-1",
      filePath: "server/src/billing/invoice.ts",
      qualifiedName: "InvoiceService.charge",
      startLine: 20,
      endLine: 40,
      confidence: 0.92,
    },
  ];

  /** Schema graph reachable from `seed-1`: a table + one of its columns. */
  const schemaFor = (): SchemaImpactDataSource =>
    stubDataSource(
      [
        { fromSymbolId: "seed-1", toSymbolId: "t-orders", kind: "reads" },
        { fromSymbolId: "seed-1", toSymbolId: "c-total", kind: "writes" },
      ],
      [
        {
          id: "t-orders",
          kind: "table",
          name: "orders",
          qualifiedName: "public.orders",
          source: "mybatis",
        },
        {
          id: "c-total",
          kind: "column",
          name: "total",
          qualifiedName: "public.orders.total",
          source: "mybatis",
        },
      ],
    );

  it("crosses the run's mapped symbols into a fenced-ready AFFECTED SCHEMA block", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.\n\nAdd a refund endpoint.",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        mapRequirement: async () => oneMatch,
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
      },
    });
    expect(ctx.rows.map((r) => r.tableName)).toContain("public.orders");
    expect(ctx.rows.some((r) => r.columnName === "total")).toBe(true);
    // The verbatim safety label required by the acceptance criteria.
    expect(ctx.block).toContain("TEXT ONLY");
    expect(ctx.block).toContain("never executed");
    expect(ctx.block).toContain("public.orders");
    expect(ctx.tokens).toBeGreaterThan(0);
  });

  it("is deterministic — identical inputs yield byte-identical output across runs", async () => {
    const opts = {
      projectId: "proj-1",
      extraInstructions: "Requirement A about billing.\n\nRequirement B about auth.",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        mapRequirement: async () => oneMatch,
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
      },
    } as const;
    const a = await computeRunAffectedSchemaContext(opts);
    const b = await computeRunAffectedSchemaContext(opts);
    expect(a).toEqual(b);
  });

  it("no-ops when the feature flag is disabled (default OFF)", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.",
      enabled: false,
      deps: {
        mapRequirement: async () => oneMatch,
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
      },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_SCHEMA_CONTEXT);
  });

  it("no-ops (no throw) when extraInstructions is empty", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "   ",
      enabled: true,
      deps: {
        mapRequirement: async () => oneMatch,
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
      },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_SCHEMA_CONTEXT);
  });

  it("degrades cleanly when no code symbols map (no seed ids ⇒ no crossing)", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.\n\nAdd a refund endpoint.",
      enabled: true,
      deps: {
        mapRequirement: async () => [],
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
      },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_SCHEMA_CONTEXT);
  });

  it("degrades cleanly when the mapped symbols touch no schema objects", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.",
      enabled: true,
      deps: {
        mapRequirement: async () => oneMatch,
        dataSourceFor: emptyGraphFor,
        // No schema edges from the seed ⇒ empty crossing.
        schemaDataSourceFor: () => stubDataSource([], []),
      },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_SCHEMA_CONTEXT);
  });

  it("keeps the run alive when one candidate's mapper throws", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "First requirement.\n\nSecond requirement.",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        // First candidate maps to a seed symbol; second throws — the crossing
        // still runs on the survivor and the computation never rejects.
        mapRequirement: async (req) =>
          req.title.startsWith("First") ? oneMatch : Promise.reject(new Error("boom")),
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
      },
    });
    expect(ctx.rows.map((r) => r.tableName)).toContain("public.orders");
  });
  it("reconciles the crossed rows against an injected live schema — table-not-found (#826)", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        mapRequirement: async () => oneMatch,
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
        // Empty live schema ⇒ the crossed `public.orders` cannot be found.
        liveIndex: new LiveSchemaIndex([]),
      },
    });
    const orders = ctx.rows.find((r) => r.tableName === "public.orders" && r.columnName === null);
    expect(orders?.reconciliation).toBe("table-not-found");
  });

  it("reconciles the crossed rows against an injected live schema — matched (#826)", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        mapRequirement: async () => oneMatch,
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
        liveIndex: liveOrdersIndex(),
      },
    });
    const orders = ctx.rows.find((r) => r.tableName === "public.orders" && r.columnName === null);
    const total = ctx.rows.find((r) => r.columnName === "total");
    expect(orders?.reconciliation).toBe("matched");
    expect(total?.reconciliation).toBe("matched");
  });

  it("passes the injected identity resolver through to the crossed rows (#826)", async () => {
    const ctx = await computeRunAffectedSchemaContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        mapRequirement: async () => oneMatch,
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaFor,
        identityResolver: async (o) => `ident:${o.tableName}`,
      },
    });
    expect(ctx.rows.length).toBeGreaterThan(0);
    for (const r of ctx.rows) {
      expect(r.schemaObjectIdentityId).toBe(`ident:${r.tableName}`);
    }
  });
});
