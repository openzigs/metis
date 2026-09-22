import { describe, expect, it, vi } from "vitest";
import type { CodeGraphDataSource, GraphEdge, GraphSymbol } from "../code-graph/query-service.js";
import { heuristicChangeExtractor } from "./extract-changes.js";
import { blastRadius, relationForIncoming, DEFAULT_RADIUS_MIN_CONFIDENCE } from "./blast-radius.js";
import {
  computeProjectImpact,
  executeImpactAnalysis,
  PrismaCodeGraphDataSource,
  triggerImpactAnalysis,
  type ComputeImpactDeps,
} from "./impact-analysis-engine.js";
import { getImpactAnalysisDetail, listImpactAnalyses } from "./impact-analysis-read.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import type { ImpactItemFacts, ImpactRunFacts, ImpactSummarizer } from "./impact-summarizer.js";
import { LiveSchemaIndex } from "./live-schema-ingest.js";

// ---- In-memory graph helper ------------------------------------------------

function sym(id: string, file = `${id}.ts`): GraphSymbol {
  return {
    id,
    qualifiedName: `pkg.${id}`,
    kind: "function",
    filePath: file,
    language: "ts",
    startLine: 1,
    endLine: 10,
  };
}

interface MockGraph {
  symbols: Record<string, GraphSymbol>;
  edges: GraphEdge[];
}

function mockDataSource(graph: MockGraph): CodeGraphDataSource {
  return {
    async getSymbol(id) {
      return graph.symbols[id] ?? null;
    },
    async getEdgesFrom(id) {
      return graph.edges.filter((e) => e.fromSymbolId === id);
    },
    async getEdgesTo(id) {
      return graph.edges.filter((e) => e.toSymbolId === id);
    },
    async getSymbolsByFile(fp) {
      return Object.values(graph.symbols).filter((s) => s.filePath === fp);
    },
    async getSymbolsByIds(ids) {
      return ids.map((id) => graph.symbols[id]).filter(Boolean) as GraphSymbol[];
    },
  };
}

const GRAPH: MockGraph = {
  symbols: {
    A: sym("A"),
    B: sym("B"),
    C: sym("C"),
    M: sym("M"),
    D: sym("D"),
  },
  edges: [
    { id: "e1", fromSymbolId: "B", toSymbolId: "A", kind: "calls" }, // B -> A (caller)
    { id: "e2", fromSymbolId: "M", toSymbolId: "A", kind: "imports" }, // M imports A (importer)
    { id: "e3", fromSymbolId: "A", toSymbolId: "C", kind: "calls" }, // A -> C (dependency)
    { id: "e4", fromSymbolId: "D", toSymbolId: "B", kind: "calls" }, // D -> B (depth 2 caller)
  ],
};

describe("relationForIncoming", () => {
  it("maps imports to importer and everything else to caller", () => {
    expect(relationForIncoming("imports")).toBe("importer");
    expect(relationForIncoming("calls")).toBe("caller");
    expect(relationForIncoming("references")).toBe("caller");
  });
});

describe("blastRadius", () => {
  it("returns [] for empty seeds or zero depth", async () => {
    const ds = mockDataSource(GRAPH);
    expect(await blastRadius(ds, [])).toEqual([]);
    expect(await blastRadius(ds, ["A"], { maxDepth: 0 })).toEqual([]);
  });

  it("captures callers and importers (callers-only default) without downstream deps", async () => {
    const ds = mockDataSource(GRAPH);
    const getEdgesFromSpy = vi.spyOn(ds, "getEdgesFrom");
    const radius = await blastRadius(ds, ["A"], { maxDepth: 2, seedConfidence: 1 });
    const byId = new Map(radius.map((r) => [r.codeSymbolId, r]));

    expect(byId.get("B")?.relation).toBe("caller");
    expect(byId.get("B")?.depth).toBe(1);
    expect(byId.get("M")?.relation).toBe("importer");
    // C is a downstream dependency (reached only via getEdgesFrom) — under the
    // callers-only default it must NOT appear, and getEdgesFrom is never consulted.
    expect(byId.has("C")).toBe(false);
    expect(getEdgesFromSpy).not.toHaveBeenCalled();
    // D reaches A only through B at depth 2 and inherits the caller relation.
    expect(byId.get("D")?.relation).toBe("caller");
    expect(byId.get("D")?.depth).toBe(2);
  });

  it("includes downstream dependencies when includeDependencies is true", async () => {
    const ds = mockDataSource(GRAPH);
    const radius = await blastRadius(ds, ["A"], {
      maxDepth: 2,
      seedConfidence: 1,
      includeDependencies: true,
    });
    const byId = new Map(radius.map((r) => [r.codeSymbolId, r]));
    expect(byId.get("C")?.relation).toBe("dependency");
    expect(byId.get("B")?.relation).toBe("caller");
    expect(byId.get("M")?.relation).toBe("importer");
  });

  it("decays confidence with depth", async () => {
    const ds = mockDataSource(GRAPH);
    const radius = await blastRadius(ds, ["A"], { maxDepth: 2, seedConfidence: 1 });
    const b = radius.find((r) => r.codeSymbolId === "B");
    const d = radius.find((r) => r.codeSymbolId === "D");
    expect(b && d && b.confidence > d.confidence).toBe(true);
  });

  it("does not revisit seed symbols", async () => {
    const ds = mockDataSource(GRAPH);
    const radius = await blastRadius(ds, ["A"], { maxDepth: 3 });
    expect(radius.some((r) => r.codeSymbolId === "A")).toBe(false);
  });

  it("filters out symbols below an explicit high minConfidence floor", async () => {
    // confidence = seedConfidence(1) * weight * 0.7^(depth-1). Depth 1 has no decay:
    //   B (calls,d1)=1.0, M (imports,d1)=0.8, D (calls,d2)=0.7.
    const ds = mockDataSource(GRAPH);
    const radius = await blastRadius(ds, ["A"], { maxDepth: 2, minConfidence: 0.9 });
    const ids = new Set(radius.map((r) => r.codeSymbolId));
    // Depth-1 caller B (1.0) stays; importer M (0.8) and depth-2 D (0.7) are trimmed.
    expect(ids.has("B")).toBe(true);
    expect(ids.has("M")).toBe(false);
    expect(ids.has("D")).toBe(false);
    // The seed A is still never emitted regardless of the floor.
    expect(ids.has("A")).toBe(false);
  });

  it("default 0.4 floor trims a weak depth-2 reference but keeps a depth-1 caller", async () => {
    // S=seed. P calls S at depth 1 (calls,d1 = 1*1.0*1 = 1.0 — kept).
    // Q references P at depth 2 (references,d2 = 1*0.4*0.7 = 0.28 — below 0.4, trimmed).
    const floorGraph: MockGraph = {
      symbols: { S: sym("S"), P: sym("P"), Q: sym("Q") },
      edges: [
        { id: "f1", fromSymbolId: "P", toSymbolId: "S", kind: "calls" },
        { id: "f2", fromSymbolId: "Q", toSymbolId: "P", kind: "references" },
      ],
    };
    const ds = mockDataSource(floorGraph);
    const radius = await blastRadius(ds, ["S"], { maxDepth: 2, seedConfidence: 1 });
    const ids = new Set(radius.map((r) => r.codeSymbolId));
    expect(ids.has("P")).toBe(true); // depth-1 caller, confidence 1.0 ≥ 0.4
    expect(ids.has("Q")).toBe(false); // depth-2 reference, confidence 0.28 < 0.4
  });

  it("exposes the default radius confidence floor as 0.4", () => {
    expect(DEFAULT_RADIUS_MIN_CONFIDENCE).toBe(0.4);
  });
});

describe("heuristicChangeExtractor", () => {
  it("returns [] for empty text", async () => {
    expect(await heuristicChangeExtractor.extract("")).toEqual([]);
    expect(await heuristicChangeExtractor.extract("   \n  ")).toEqual([]);
  });

  it("splits paragraphs into added changes", async () => {
    const changes = await heuristicChangeExtractor.extract("First requirement.\n\nSecond one.");
    expect(changes).toHaveLength(2);
    expect(changes[0].changeType).toBe("added");
    expect(changes[0].body).toBe("First requirement.");
    expect(changes[0].requirementId).toBeNull();
  });

  it("expands bullet lists into one change per bullet", async () => {
    const changes = await heuristicChangeExtractor.extract("- alpha\n- beta\n- gamma");
    expect(changes.map((c) => c.body)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("truncates long titles", async () => {
    const long = "x".repeat(200);
    const [change] = await heuristicChangeExtractor.extract(long);
    expect(change.title.endsWith("...")).toBe(true);
    expect(change.title.length).toBeLessThanOrEqual(120);
    expect(change.body.length).toBe(200);
  });
});

describe("computeProjectImpact", () => {
  const directMatch: RequirementCodeMatch = {
    codeSymbolId: "A",
    filePath: "A.ts",
    qualifiedName: "pkg.A",
    startLine: 1,
    endLine: 10,
    confidence: 0.9,
  };

  it("combines direct hits with blast radius and counts files/symbols", async () => {
    const result = await computeProjectImpact(
      {
        requirementId: null,
        title: "t",
        body: "b",
        changeType: "added",
        bodyDelta: 50,
      },
      "proj-1",
      {
        mapRequirement: async () => [directMatch],
        dataSourceFor: () => mockDataSource(GRAPH),
        maxDepth: 2,
      },
    );

    expect(result.projectId).toBe("proj-1");
    const direct = result.affectedSymbols.find((s) => s.relation === "direct");
    expect(direct?.codeSymbolId).toBe("A");
    expect(direct?.depth).toBe(0);
    // Callers-only default: A (direct) + B, M, D (radius). C (downstream dep) excluded.
    expect(result.affectedSymbols.some((s) => s.relation === "dependency")).toBe(false);
    expect(result.affectedSymbolCount).toBe(4);
    expect(result.affectedFileCount).toBe(4);
    expect(result.confidence).toBe(0.9);
    expect(result.severity).toBe("low");
    expect(result.impactScore).toBeGreaterThan(0);
  });

  // #1001 — the LLM ADDITIVE-COLUMN proposer seam. The proposer itself is unit
  // tested in tests/impact-additive-column-proposer.test.ts; these prove the
  // ENGINE contract: proposals are appended (never substituted), they run on the
  // POST-filter primary set, and a fault degrades to the deterministic crossing.
  describe("additive column proposer wiring (#1001)", () => {
    const schemaSymbols = [
      {
        id: "tbl-1",
        kind: "table" as const,
        name: "orders",
        qualifiedName: "orders",
        source: "mybatis" as const,
      },
      {
        id: "col-1",
        kind: "column" as const,
        name: "billaddr1",
        qualifiedName: "orders.billaddr1",
        source: "mybatis" as const,
      },
    ];

    const schemaDataSourceFor = () => ({
      getSchemaEdgesFrom: async (ids: string[]) =>
        ids.includes("A")
          ? schemaSymbols.map((s) => ({
              fromSymbolId: "A",
              toSymbolId: s.id,
              kind: "reads" as const,
            }))
          : [],
      getSchemaSymbolsByIds: async (ids: string[]) =>
        schemaSymbols.filter((s) => ids.includes(s.id)),
    });

    function runWith(
      additiveColumnProposer: ComputeImpactDeps["additiveColumnProposer"],
      extra: Partial<ComputeImpactDeps> = {},
    ) {
      return computeProjectImpact(
        {
          requirementId: null,
          title: "Order cancellation",
          body: "A cancelled order must record who cancelled it and when.",
          changeType: "added",
          bodyDelta: 50,
        },
        "proj-1",
        {
          mapRequirement: async () => [directMatch],
          dataSourceFor: () => mockDataSource(GRAPH),
          schemaDataSourceFor,
          additiveColumnProposer,
          ...extra,
        },
      );
    }

    it("appends proposed add-column rows without dropping any deterministic row", async () => {
      const baseline = await runWith(undefined);
      const result = await runWith(async (_text, tables) => [
        {
          objectKind: "column" as const,
          tableName: tables[0].tableName,
          columnName: "cancelled_at",
          columnType: "TIMESTAMP",
          changeKind: "add-column" as const,
          suggestedDdl: "ALTER TABLE orders ADD COLUMN cancelled_at TIMESTAMP; -- SUGGESTED",
          source: "mybatis" as const,
          reconciliation: null,
          confidence: 0.5,
        },
      ]);

      // Every baseline row survives byte-identically; only the proposal is new.
      for (const row of baseline.affectedTables) {
        expect(result.affectedTables).toContainEqual(row);
      }
      expect(result.affectedTables).toHaveLength(baseline.affectedTables.length + 1);
      const added = result.affectedTables.filter((r) => r.changeKind === "add-column");
      expect(added).toHaveLength(1);
      expect(added[0].columnName).toBe("cancelled_at");
      // Sorted by (table, column) like the crossing itself.
      expect(result.affectedTables.map((r) => r.columnName)).toEqual([
        null,
        "billaddr1",
        "cancelled_at",
      ]);
    });

    it("proposes only on tables that SURVIVED the #936 relevance filter", async () => {
      const seen: string[][] = [];
      await runWith(
        async (_text, tables) => {
          seen.push(tables.map((t) => t.tableName));
          return [];
        },
        {
          // The filter demotes `orders` entirely into the secondary bucket.
          tableRelevanceFilter: async (_text, rows) => ({
            primary: rows.filter((r) => r.tableName !== "orders"),
            secondary: rows
              .filter((r) => r.tableName === "orders")
              .map((r) => ({ ...r, relevanceTier: "unlikely" as const })),
            decisions: [],
            applied: true,
          }),
        },
      );

      // Nothing survived ⇒ the proposer is not even invoked.
      expect(seen).toEqual([]);
    });

    it("keeps the deterministic crossing when the proposer throws", async () => {
      const baseline = await runWith(undefined);
      const result = await runWith(async () => {
        throw new Error("boom");
      });
      expect(result.affectedTables).toEqual(baseline.affectedTables);
    });

    it("is inert when no proposer is injected (deterministic default)", async () => {
      const result = await runWith(undefined);
      expect(result.affectedTables.every((r) => r.changeKind === "reference")).toBe(true);
    });

    // #1005 — the CLAUSE-vs-IMPACT reconciler seam. The reconciler itself is unit
    // tested in tests/impact-clause-coverage-reconciler.test.ts; these prove the
    // ENGINE contract: it sees the FINAL surfaced set (primary + secondary), its
    // output is ADVISORY (never merged into the table sets), and a fault degrades
    // to no advisories.
    describe("clause coverage reconciler wiring (#1005)", () => {
      it("is handed every surfaced table, including the #936 secondary bucket", async () => {
        const seen: string[][] = [];
        await runWith(undefined, {
          clauseCoverageReconciler: async (_text, _projectId, surfaced) => {
            seen.push(surfaced);
            return [];
          },
          // Demote `orders` into the secondary bucket: it is still on screen, so
          // reporting it as a coverage gap would be noise.
          tableRelevanceFilter: async (_text, rows) => ({
            primary: rows.filter((r) => r.tableName !== "orders"),
            secondary: rows
              .filter((r) => r.tableName === "orders")
              .map((r) => ({ ...r, relevanceTier: "unlikely" as const })),
            decisions: [],
            applied: true,
          }),
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain("orders");
      });

      it("puts gaps on coverageGaps and NEVER into the affected-table sets", async () => {
        const baseline = await runWith(undefined);
        const result = await runWith(undefined, {
          clauseCoverageReconciler: async () => [
            { tableName: "inventory", clause: "returned to available stock", rationale: "stock" },
          ],
        });
        expect(result.coverageGaps).toEqual([
          { tableName: "inventory", clause: "returned to available stock", rationale: "stock" },
        ]);
        // The advisory changes NOTHING about the measured result — this is what
        // makes the stage incapable of moving table recall/precision.
        expect(result.affectedTables).toEqual(baseline.affectedTables);
        expect(result.affectedTablesSecondary).toEqual(baseline.affectedTablesSecondary);
      });

      it("degrades to no advisories when the reconciler throws", async () => {
        const result = await runWith(undefined, {
          clauseCoverageReconciler: async () => {
            throw new Error("boom");
          },
        });
        expect(result.coverageGaps).toEqual([]);
      });

      it("is inert when no reconciler is injected (deterministic default)", async () => {
        expect((await runWith(undefined)).coverageGaps).toEqual([]);
      });
    });
  });

  it("includes downstream dependencies when includeDependencies is true", async () => {
    const result = await computeProjectImpact(
      {
        requirementId: null,
        title: "t",
        body: "b",
        changeType: "added",
        bodyDelta: 50,
      },
      "proj-1",
      {
        mapRequirement: async () => [directMatch],
        dataSourceFor: () => mockDataSource(GRAPH),
        maxDepth: 2,
        includeDependencies: true,
      },
    );
    // A (direct) + B, M, C (dependency), D
    expect(result.affectedSymbolCount).toBe(5);
    expect(result.affectedSymbols.some((s) => s.relation === "dependency")).toBe(true);
  });

  it("forwards minConfidence to the blast radius", async () => {
    const result = await computeProjectImpact(
      {
        requirementId: null,
        title: "t",
        body: "b",
        changeType: "added",
        bodyDelta: 50,
      },
      "proj-1",
      {
        mapRequirement: async () => [{ ...directMatch, confidence: 1 }],
        dataSourceFor: () => mockDataSource(GRAPH),
        maxDepth: 2,
        minConfidence: 0.9,
      },
    );
    // seedConfidence=1: only B (calls,d1 = 1.0) clears 0.9; M (0.8) + D (0.7) trimmed.
    // Direct A (depth 0, confidence 1) is always kept.
    const radius = result.affectedSymbols.filter((s) => s.relation !== "direct");
    expect(radius.map((s) => s.codeSymbolId)).toEqual(["B"]);
  });

  it("handles requirements with no code matches", async () => {
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "modified", bodyDelta: 10 },
      "proj-1",
      {
        mapRequirement: async () => [],
        dataSourceFor: () => mockDataSource(GRAPH),
      },
    );
    expect(result.affectedSymbolCount).toBe(0);
    expect(result.affectedFileCount).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("keeps matches without a resolved code symbol id", async () => {
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
      "proj-1",
      {
        mapRequirement: async () => [
          { ...directMatch, codeSymbolId: null, qualifiedName: "external.thing" },
        ],
        dataSourceFor: () => mockDataSource(GRAPH),
      },
    );
    expect(result.affectedSymbolCount).toBe(1);
    expect(result.affectedSymbols[0].relation).toBe("direct");
  });

  // #961 — the deterministic requirement→code match quality derives from the SEED
  // (direct-match) confidences, not the blast-radius spread.
  it("grades a confident, standout seed match as strong", async () => {
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
      "proj-1",
      { mapRequirement: async () => [directMatch], dataSourceFor: () => mockDataSource(GRAPH) },
    );
    expect(result.matchQuality).toBe("strong");
  });

  it("grades a no-seed requirement as weak", async () => {
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "modified", bodyDelta: 10 },
      "proj-1",
      { mapRequirement: async () => [], dataSourceFor: () => mockDataSource(GRAPH) },
    );
    expect(result.matchQuality).toBe("weak");
  });

  it("grades scattered low-confidence seeds with no dominant shared entity as weak", async () => {
    // #994 — near-tied seeds are only "weak" when they ALSO share no dominant
    // basename token (genuine scatter); distinct, unrelated file paths here.
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
      "proj-1",
      {
        mapRequirement: async () => [
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "x.one",
            filePath: "AccountService.ts",
            confidence: 0.5,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "x.two",
            filePath: "ItemController.ts",
            confidence: 0.49,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "x.three",
            filePath: "OrdersWidget.ts",
            confidence: 0.48,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "x.four",
            filePath: "CartManager.ts",
            confidence: 0.48,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "x.five",
            filePath: "StatusBadge.ts",
            confidence: 0.47,
          },
        ],
        dataSourceFor: () => mockDataSource(GRAPH),
      },
    );
    expect(result.matchQuality).toBe("weak");
    expect(result.matchQualityReason).toBe("scattered");
  });

  // #994 — the reported live bug: a precise, multi-entity requirement produces
  // MANY near-tied seeds because it legitimately touches several files of the
  // SAME feature. Breadth (many seeds sharing a dominant entity) must not be
  // misread as ambiguity.
  it("grades a coherent multi-file feature (many near-tied seeds, dominant shared entity) as moderate, not weak", async () => {
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
      "proj-1",
      {
        mapRequirement: async () => [
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "order.service",
            filePath: "server/src/services/order-service.ts",
            confidence: 1.0,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "order.cancellation",
            filePath: "server/src/services/order-cancellation-handler.ts",
            confidence: 0.98,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "order.repository",
            filePath: "server/src/repositories/order-repository.ts",
            confidence: 0.98,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "order.status",
            filePath: "server/src/services/order-status-history.ts",
            confidence: 0.95,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "order.validator",
            filePath: "server/src/validators/order-validator.ts",
            confidence: 0.95,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "order.lineItemMapper",
            filePath: "server/src/mappers/order-line-item-mapper.ts",
            confidence: 0.92,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "lineItem.service",
            filePath: "server/src/services/line-item-service.ts",
            confidence: 0.92,
          },
          {
            ...directMatch,
            codeSymbolId: null,
            qualifiedName: "inventory.adjuster",
            filePath: "server/src/services/inventory-adjuster.ts",
            confidence: 0.92,
          },
        ],
        dataSourceFor: () => mockDataSource(GRAPH),
      },
    );
    expect(result.matchQuality).not.toBe("weak");
    expect(result.matchQualityReason).toBeNull();
  });

  // #961 (nit) — the grade must be derived over the DEDUPED direct set (the rows
  // actually persisted + re-derived by the read path), NOT the pre-dedupe raw
  // matches. Two seeds collapsing to one symbol would grade `moderate` over the
  // raw [0.9, 0.9] pair (spread 0 ⇒ not a clear winner) but `strong` over the
  // single deduped seed. Asserting `strong` proves the engine derives post-dedupe.
  it("derives matchQuality over the deduped direct set (duplicate codeSymbolId)", async () => {
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
      "proj-1",
      {
        mapRequirement: async () => [
          { ...directMatch, confidence: 0.9 },
          { ...directMatch, confidence: 0.9 }, // same codeSymbolId "A" ⇒ collapses
        ],
        dataSourceFor: () => mockDataSource(GRAPH),
      },
    );
    // The two seeds merged into one direct symbol...
    expect(result.affectedSymbols.filter((s) => s.relation === "direct")).toHaveLength(1);
    // ...so the grade is `strong` (single standout seed), not the pre-dedupe `moderate`.
    expect(result.matchQuality).toBe("strong");
  });

  it("derives matchQuality over the deduped direct set (null id, same qualifiedName)", async () => {
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
      "proj-1",
      {
        mapRequirement: async () => [
          { ...directMatch, codeSymbolId: null, qualifiedName: "external.thing", confidence: 0.9 },
          { ...directMatch, codeSymbolId: null, qualifiedName: "external.thing", confidence: 0.9 },
        ],
        dataSourceFor: () => mockDataSource(GRAPH),
      },
    );
    // Null-id rows keyed by qualifiedName collapse to one direct symbol...
    expect(result.affectedSymbols.filter((s) => s.relation === "direct")).toHaveLength(1);
    // ...so the single deduped seed grades `strong`, not the pre-dedupe `moderate`.
    expect(result.matchQuality).toBe("strong");
  });
});

describe("PrismaCodeGraphDataSource", () => {
  function fakePrisma() {
    return {
      codeSymbol: {
        findFirst: vi.fn().mockResolvedValue({
          id: "A",
          qualifiedName: "pkg.A",
          kind: "function",
          filePath: "A.ts",
          language: "ts",
          startLine: 1,
          endLine: 5,
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "A",
            qualifiedName: "pkg.A",
            kind: "function",
            filePath: "A.ts",
            language: "ts",
            startLine: 1,
            endLine: 5,
          },
        ]),
      },
      codeEdge: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "e1", fromSymbolId: "B", toSymbolId: "A", kind: "calls" }]),
      },
    };
  }

  it("scopes all queries to the project id", async () => {
    const prisma = fakePrisma();
    const ds = new PrismaCodeGraphDataSource(prisma as never, "proj-9");

    await ds.getSymbol("A");
    expect(prisma.codeSymbol.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: "proj-9" }) }),
    );

    await ds.getEdgesFrom("A");
    expect(prisma.codeEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "proj-9", toSymbolId: { not: null } }),
      }),
    );

    const edges = await ds.getEdgesTo("A");
    expect(edges[0]).toMatchObject({ fromSymbolId: "B", toSymbolId: "A", kind: "calls" });

    expect(await ds.getSymbolsByIds([])).toEqual([]);
    const byIds = await ds.getSymbolsByIds(["A"]);
    expect(byIds[0].id).toBe("A");

    const byFile = await ds.getSymbolsByFile("A.ts");
    expect(byFile[0].filePath).toBe("A.ts");
  });

  it("returns null for a missing symbol", async () => {
    const prisma = fakePrisma();
    prisma.codeSymbol.findFirst.mockResolvedValueOnce(null);
    const ds = new PrismaCodeGraphDataSource(prisma as never, "p");
    expect(await ds.getSymbol("zzz")).toBeNull();
  });
});

// ---- Service (trigger/execute) ---------------------------------------------

function serviceePrismaMock() {
  const analyses = new Map<string, Record<string, unknown>>();
  const items: Array<Record<string, unknown>> = [];
  const affected: Array<Record<string, unknown>> = [];
  const tables: Array<Record<string, unknown>> = [];
  const prisma = {
    impactAnalysis: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: "ia-1",
          startedAt: new Date(),
          completedAt: null,
          totalImpactedSymbols: 0,
          ...data,
        };
        analyses.set(row.id as string, row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) => analyses.get(where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...analyses.get(where.id), ...data };
          analyses.set(where.id, row);
          return row;
        },
      ),
    },
    impactItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `item-${items.length}`, ...data };
        items.push(row);
        return row;
      }),
    },
    impactAffectedSymbol: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        affected.push(...data);
        return { count: data.length };
      }),
    },
    impactAffectedTable: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        tables.push(...data);
        return { count: data.length };
      }),
    },
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    quarantineChunk: { findMany: vi.fn(async () => []) },
    document: {},
    codeSymbol: {},
    codeEdge: {},
  };
  return { prisma, analyses, items, affected, tables };
}

describe("triggerImpactAnalysis / executeImpactAnalysis", () => {
  it("rejects missing projects or source", async () => {
    const { prisma } = serviceePrismaMock();
    await expect(
      triggerImpactAnalysis(
        { projectIds: [], text: "x", actorId: "u" },
        { prisma: prisma as never },
      ),
    ).rejects.toThrow(/projectId/i);
    await expect(
      triggerImpactAnalysis({ projectIds: ["p"], actorId: "u" }, { prisma: prisma as never }),
    ).rejects.toThrow(/documentId or text/i);
  });

  it("persists per-project items + affected symbols and completes", async () => {
    const { prisma, analyses, items, affected } = serviceePrismaMock();
    analyses.set("ia-seed", { id: "ia-seed", sourceText: "text", documentId: null });
    await executeImpactAnalysis("ia-seed", ["proj-1", "proj-2"], {
      prisma: prisma as never,
      extractor: {
        extract: async () => [
          { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
        ],
      },
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 5,
          confidence: 0.8,
        },
      ],
      dataSourceFor: () => mockDataSource(GRAPH),
    });
    // Two projects × one change each with hits.
    expect(items).toHaveLength(2);
    expect(affected.length).toBeGreaterThan(0);
    const seed = analyses.get("ia-seed");
    expect(seed?.status).toBe("completed");
    // Callers-only default: A (direct) + B, M, D per project = 4 × 2 projects.
    expect(seed?.totalImpactedSymbols).toBe(8);
  });

  /**
   * #1013 — the requirement title must be SNAPSHOTTED on the row the change
   * produced. This is what makes a wrong heading structurally impossible: the
   * title is written inside the same loop iteration that computed the item, so
   * it cannot be paired with another change's impact.
   *
   * The fixture reproduces the exact shape that defeated #1004's serialize-time
   * re-derivation: THREE pasted changes of which only the LAST two hit code (the
   * engine `continue`s past zero-hit changes), across TWO projects.
   */
  it("#1013 — snapshots each change's own title on the item that change produced", async () => {
    const { prisma, analyses, items } = serviceePrismaMock();
    analyses.set("ia-title", { id: "ia-title", sourceText: "text", documentId: null });
    const CHANGES = [
      { title: "Customers must be able to cancel an order within 24 hours.", body: "b1" },
      { title: "Support partial shipments across two warehouses.", body: "b2" },
      { title: "Every line item must record the fulfilling warehouse.", body: "b3" },
    ];
    await executeImpactAnalysis("ia-title", ["proj-1", "proj-2"], {
      prisma: prisma as never,
      extractor: {
        extract: async () =>
          CHANGES.map((c) => ({
            requirementId: null,
            title: c.title,
            body: c.body,
            changeType: "added" as const,
            bodyDelta: 10,
          })),
      },
      // The FIRST change hits no code, so the engine drops it — item ordinals
      // stop corresponding to paste ordinals, which is precisely why the label
      // could not be re-derived from run-level state.
      mapRequirement: async (req) =>
        req.title === CHANGES[0].title
          ? []
          : [
              {
                codeSymbolId: "A",
                filePath: "A.ts",
                qualifiedName: "pkg.A",
                startLine: 1,
                endLine: 5,
                confidence: 0.8,
              },
            ],
      dataSourceFor: () => mockDataSource(GRAPH),
    });

    // 2 surviving changes × 2 projects.
    expect(items).toHaveLength(4);
    // The dropped change's title never reaches a row.
    expect(items.map((i) => i.requirementTitle)).not.toContain(CHANGES[0].title);
    // Every row carries exactly one of the two surviving titles, once per project.
    expect(
      items.map((i) => `${String(i.projectId)}::${String(i.requirementTitle)}`).sort(),
    ).toEqual(
      [
        `proj-1::${CHANGES[1].title}`,
        `proj-1::${CHANGES[2].title}`,
        `proj-2::${CHANGES[1].title}`,
        `proj-2::${CHANGES[2].title}`,
      ].sort(),
    );
  });

  it("#1013 — persists NULL rather than an empty title when the change has none", async () => {
    const { prisma, analyses, items } = serviceePrismaMock();
    analyses.set("ia-untitled", { id: "ia-untitled", sourceText: "text", documentId: null });
    await executeImpactAnalysis("ia-untitled", ["proj-1"], {
      prisma: prisma as never,
      extractor: {
        extract: async () => [
          { requirementId: null, title: "   ", body: "b", changeType: "added", bodyDelta: 10 },
        ],
      },
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 5,
          confidence: 0.8,
        },
      ],
      dataSourceFor: () => mockDataSource(GRAPH),
    });
    expect(items).toHaveLength(1);
    // NULL ⇒ the export degrades to the neutral numbered label, never to a
    // blank heading or another requirement's title.
    expect(items[0].requirementTitle).toBeNull();
  });

  // #961/#994 (blocking) — the deterministic matchQuality(+reason) must reach the
  // #932 summarizer THROUGH the real pipeline (executeImpactAnalysis →
  // computeProjectImpact → ImpactItemFacts). Driving it end-to-end (not via a
  // hand-built fact helper) proves the production facts object threads the
  // graded value, so the weak caveat can actually fire — and stays silent on a
  // strong match.
  it("threads the derived matchQuality(+reason) into the summarizer facts (weak/no-entity vs strong)", async () => {
    async function captureFactsFor(matches: RequirementCodeMatch[]): Promise<ImpactItemFacts> {
      const { prisma, analyses } = serviceePrismaMock();
      analyses.set("ia-mq", { id: "ia-mq", sourceText: "text", documentId: null });
      const captured: ImpactItemFacts[] = [];
      const capturingSummarizer: ImpactSummarizer = {
        summarizeItem: async (facts) => {
          captured.push(facts);
          return { summary: "s", applied: true, grounded: true };
        },
        summarizeRun: async () => ({ summary: null, applied: false, grounded: false }),
      };
      await executeImpactAnalysis("ia-mq", ["proj-1"], {
        prisma: prisma as never,
        extractor: {
          extract: async () => [
            { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
          ],
        },
        mapRequirement: async () => matches,
        dataSourceFor: () => mockDataSource(GRAPH),
        impactSummarizer: capturingSummarizer,
      });
      expect(captured).toHaveLength(1);
      return captured[0];
    }

    // Zero seeds (the requirement matched no code) grades weak/no-entity, but an
    // item with NO affected symbols is skipped before reaching the summarizer
    // (nothing to summarize) — so the reachable "weak" case here is the
    // scattered one: near-tied seeds with no dominant shared entity.
    const weakFacts = await captureFactsFor([
      {
        codeSymbolId: null,
        filePath: "AccountService.ts",
        qualifiedName: "x.one",
        startLine: null,
        endLine: null,
        confidence: 0.5,
      },
      {
        codeSymbolId: null,
        filePath: "ItemController.ts",
        qualifiedName: "x.two",
        startLine: null,
        endLine: null,
        confidence: 0.49,
      },
      {
        codeSymbolId: null,
        filePath: "OrdersWidget.ts",
        qualifiedName: "x.three",
        startLine: null,
        endLine: null,
        confidence: 0.48,
      },
      {
        codeSymbolId: null,
        filePath: "CartManager.ts",
        qualifiedName: "x.four",
        startLine: null,
        endLine: null,
        confidence: 0.48,
      },
      {
        codeSymbolId: null,
        filePath: "StatusBadge.ts",
        qualifiedName: "x.five",
        startLine: null,
        endLine: null,
        confidence: 0.47,
      },
    ]);
    expect(weakFacts.matchQuality).toBe("weak");
    expect(weakFacts.matchQualityReason).toBe("scattered");

    // A single (therefore standout, by definition) seed grades strong → the
    // facts must NOT say weak, and carry a null reason.
    const strongFacts = await captureFactsFor([
      {
        codeSymbolId: "A",
        filePath: "A.ts",
        qualifiedName: "pkg.A",
        startLine: 1,
        endLine: 5,
        confidence: 0.9,
      },
    ]);
    expect(strongFacts.matchQuality).toBe("strong");
    expect(strongFacts.matchQuality).not.toBe("weak");
    expect(strongFacts.matchQualityReason).toBeNull();
  });

  // #984 (review follow-up) — the run-level summarizer must be handed TABLE-granular
  // facts, RANKED by #936 relevance tier and deduplicated to one entry per table.
  // Same argument as the #961 test above: driving it end-to-end from real crossing
  // rows proves the production facts object is ranked, rather than trusting a
  // hand-built fixture. A regression to a raw `.map()` here would leave the #984
  // acceptance criterion green (the prompt builder re-ranks defensively) while
  // silently restoring the unranked, once-per-column `tables=[…]` prompt line that
  // caused the original bug.
  it("hands the run summarizer RANKED, per-table deduplicated primaryTables", async () => {
    const { prisma, analyses } = serviceePrismaMock();
    analyses.set("ia-rank", { id: "ia-rank", sourceText: "text", documentId: null });
    const captured: ImpactRunFacts[] = [];
    const capturingSummarizer: ImpactSummarizer = {
      summarizeItem: async () => ({ summary: null, applied: false, grounded: false }),
      summarizeRun: async (facts) => {
        captured.push(facts);
        return { summary: "s", applied: true, grounded: true };
      },
    };
    // The crossing emits ONE ROW PER COLUMN: `shop.item` yields 3 rows (table + 2
    // columns) and `shop.orders` only 2 — so a row-count ranking would lead with the
    // tangential table, which is exactly the #984 bug.
    const schemaSymbols = [
      { id: "tbl-item", kind: "table" as const, name: "item", qualifiedName: "shop.item" },
      { id: "col-item-1", kind: "column" as const, name: "qty", qualifiedName: "shop.item.qty" },
      {
        id: "col-item-2",
        kind: "column" as const,
        name: "descn",
        qualifiedName: "shop.item.descn",
      },
      { id: "tbl-orders", kind: "table" as const, name: "orders", qualifiedName: "shop.orders" },
      {
        id: "col-orders-1",
        kind: "column" as const,
        name: "status",
        qualifiedName: "shop.orders.status",
      },
    ].map((s) => ({ ...s, source: "mybatis" as const }));

    await executeImpactAnalysis("ia-rank", ["proj-1"], {
      prisma: prisma as never,
      extractor: {
        extract: async () => [
          { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
        ],
      },
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 5,
          confidence: 0.8,
        },
      ],
      dataSourceFor: () => mockDataSource(GRAPH),
      schemaDataSourceFor: () => ({
        getSchemaEdgesFrom: async (ids: string[]) =>
          ids.includes("A")
            ? schemaSymbols.map((s) => ({
                fromSymbolId: "A",
                toSymbolId: s.id,
                kind: "reads" as const,
              }))
            : [],
        getSchemaSymbolsByIds: async (ids: string[]) =>
          schemaSymbols.filter((s) => ids.includes(s.id)),
      }),
      // #936 tiers the crossed rows: the many-column `shop.item` is only `possible`.
      tableRelevanceFilter: async (_text, rows) => ({
        primary: rows.map((r) =>
          r.tableName === "shop.item"
            ? { ...r, relevanceTier: "possible" as const, confidence: 0.45 }
            : { ...r, relevanceTier: "likely" as const, confidence: 0.8 },
        ),
        secondary: [],
      }),
      impactSummarizer: capturingSummarizer,
    });

    expect(captured).toHaveLength(1);
    // One entry PER TABLE (not per column), tier-first — `shop.item` last despite
    // carrying the most rows.
    expect(captured[0].items[0].primaryTables).toEqual([
      { tableName: "shop.orders", relevanceTier: "likely", confidence: 0.8 },
      { tableName: "shop.item", relevanceTier: "possible", confidence: 0.45 },
    ]);
  });

  it("excludes downstream dependencies by default and includes them when opted in", async () => {
    // Default (includeDependencies omitted) → no dependency-relation symbols.
    const defaultRun = serviceePrismaMock();
    defaultRun.analyses.set("ia-deps-off", {
      id: "ia-deps-off",
      sourceText: "text",
      documentId: null,
    });
    await executeImpactAnalysis("ia-deps-off", ["proj-1"], {
      prisma: defaultRun.prisma as never,
      extractor: {
        extract: async () => [
          { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
        ],
      },
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 5,
          confidence: 0.8,
        },
      ],
      dataSourceFor: () => mockDataSource(GRAPH),
    });
    expect(defaultRun.affected.some((s) => s.relation === "dependency")).toBe(false);

    // Opt-in (includeDependencies: true) → dependency C is persisted.
    const optInRun = serviceePrismaMock();
    optInRun.analyses.set("ia-deps-on", {
      id: "ia-deps-on",
      sourceText: "text",
      documentId: null,
    });
    await executeImpactAnalysis("ia-deps-on", ["proj-1"], {
      prisma: optInRun.prisma as never,
      includeDependencies: true,
      extractor: {
        extract: async () => [
          { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
        ],
      },
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 5,
          confidence: 0.8,
        },
      ],
      dataSourceFor: () => mockDataSource(GRAPH),
    });
    expect(optInRun.affected.some((s) => s.relation === "dependency")).toBe(true);
  });

  it("persists affected schema tables when a schema data source is injected", async () => {
    const { prisma, tables, analyses } = serviceePrismaMock();
    analyses.set("ia-schema", { id: "ia-schema", sourceText: "text", documentId: null });
    await executeImpactAnalysis("ia-schema", ["proj-1"], {
      prisma: prisma as never,
      extractor: {
        extract: async () => [
          { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
        ],
      },
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 5,
          confidence: 0.8,
        },
      ],
      dataSourceFor: () => mockDataSource(GRAPH),
      schemaDataSourceFor: () => ({
        getSchemaEdgesFrom: async (ids: string[]) =>
          ids.includes("A")
            ? [{ fromSymbolId: "A", toSymbolId: "tbl-1", kind: "reads" as const }]
            : [],
        getSchemaSymbolsByIds: async (ids: string[]) =>
          ids.includes("tbl-1")
            ? [
                {
                  id: "tbl-1",
                  kind: "table" as const,
                  name: "orders",
                  qualifiedName: "shop.orders",
                  source: "mybatis" as const,
                },
              ]
            : [],
      }),
    });
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0]).toMatchObject({ tableName: "shop.orders", changeKind: "reference" });
  });

  // Issue #958 — `deps.liveIndexFor` is never supplied by any production caller,
  // so reconciliation is always null and `suggestDdl` can never reach its
  // `column-not-found` (typed ALTER) or "already exists" (matched) branches.
  // These tests drive the wiring through `liveIndexIntrospectorFor` end-to-end.
  describe("live-schema reconciliation wiring (#958)", () => {
    function columnCrossingDeps(introspector: ReturnType<typeof vi.fn>) {
      return {
        extractor: {
          extract: async () => [
            {
              requirementId: null,
              title: "t1",
              body: "b1",
              changeType: "added" as const,
              bodyDelta: 10,
            },
            {
              requirementId: null,
              title: "t2",
              body: "b2",
              changeType: "added" as const,
              bodyDelta: 10,
            },
          ],
        },
        mapRequirement: async () => [
          {
            codeSymbolId: "A",
            filePath: "A.ts",
            qualifiedName: "pkg.A",
            startLine: 1,
            endLine: 5,
            confidence: 0.8,
          },
        ],
        dataSourceFor: () => mockDataSource(GRAPH),
        schemaDataSourceFor: () => ({
          getSchemaEdgesFrom: async (ids: string[]) =>
            ids.includes("A")
              ? [{ fromSymbolId: "A", toSymbolId: "col-1", kind: "reads" as const }]
              : [],
          getSchemaSymbolsByIds: async (ids: string[]) =>
            ids.includes("col-1")
              ? [
                  {
                    id: "col-1",
                    kind: "column" as const,
                    name: "email",
                    qualifiedName: "shop.orders.email",
                    source: "mybatis" as const,
                  },
                ]
              : [],
        }),
        liveIndexIntrospectorFor: introspector,
      };
    }

    it("introspects at most ONCE per project per run, even across multiple changed requirements", async () => {
      const { prisma, tables, analyses } = serviceePrismaMock();
      analyses.set("ia-live-cache", { id: "ia-live-cache", sourceText: "text", documentId: null });
      const introspector = vi.fn(async () => new LiveSchemaIndex([]));

      await executeImpactAnalysis("ia-live-cache", ["proj-1"], {
        prisma: prisma as never,
        ...columnCrossingDeps(introspector),
      } as never);

      // Two changed requirements against the SAME project must yield exactly
      // one introspection call, not one per change.
      expect(introspector).toHaveBeenCalledTimes(1);
      expect(introspector).toHaveBeenCalledWith("proj-1");
      const emailRows = tables.filter((t) => t.columnName === "email");
      expect(emailRows.length).toBe(2); // one row per persisted item (2 changes)
      for (const row of emailRows) {
        // The live index has NO tables at all ⇒ table-not-found, not column-not-found.
        expect(row.reconciliation).toBe("table-not-found");
      }
    });

    it("reaches the typed ALTER (column-not-found) branch when the table exists but the column doesn't", async () => {
      const { prisma, tables, analyses } = serviceePrismaMock();
      analyses.set("ia-live-alter", { id: "ia-live-alter", sourceText: "text", documentId: null });
      const introspector = vi.fn(
        async () =>
          new LiveSchemaIndex([
            {
              schema: "shop",
              name: "orders",
              columns: new Map([
                [
                  "user_id",
                  { name: "user_id", dataType: "integer", nullable: false, isPrimaryKey: true },
                ],
              ]),
            },
          ]),
      );

      await executeImpactAnalysis("ia-live-alter", ["proj-1"], {
        prisma: prisma as never,
        ...columnCrossingDeps(introspector),
        extractor: {
          extract: async () => [
            {
              requirementId: null,
              title: "t",
              body: "b",
              changeType: "added" as const,
              bodyDelta: 10,
            },
          ],
        },
      } as never);

      const row = tables.find((t) => t.columnName === "email");
      expect(row).toBeDefined();
      expect(row?.reconciliation).toBe("column-not-found");
      expect(row?.changeKind).toBe("add-column");
      expect(row?.suggestedDdl).toBe("ALTER TABLE shop.orders ADD COLUMN email <type>;");
    });

    it("surfaces the 'already exists' matched state with higher confidence when the live column is present", async () => {
      const { prisma, tables, analyses } = serviceePrismaMock();
      analyses.set("ia-live-match", { id: "ia-live-match", sourceText: "text", documentId: null });
      const introspector = vi.fn(
        async () =>
          new LiveSchemaIndex([
            {
              schema: "shop",
              name: "orders",
              columns: new Map([
                [
                  "email",
                  { name: "email", dataType: "varchar(255)", nullable: true, isPrimaryKey: false },
                ],
              ]),
            },
          ]),
      );

      await executeImpactAnalysis("ia-live-match", ["proj-1"], {
        prisma: prisma as never,
        ...columnCrossingDeps(introspector),
        extractor: {
          extract: async () => [
            {
              requirementId: null,
              title: "t",
              body: "b",
              changeType: "added" as const,
              bodyDelta: 10,
            },
          ],
        },
      } as never);

      const row = tables.find((t) => t.columnName === "email");
      expect(row).toBeDefined();
      expect(row?.reconciliation).toBe("matched");
      expect(row?.columnType).toBe("varchar(255)");
      expect(row?.changeKind).toBe("reference");
      // Higher than the pre-#958 static 0.6 no-reconciliation band.
      expect(row?.confidence as number).toBeGreaterThan(0.6);
    });

    it("degrades gracefully (null reconciliation, run still completes) when the introspector rejects", async () => {
      const { prisma, tables, analyses } = serviceePrismaMock();
      analyses.set("ia-live-fail", { id: "ia-live-fail", sourceText: "text", documentId: null });
      const introspector = vi.fn(async () => {
        throw new Error("connector offline");
      });

      await executeImpactAnalysis("ia-live-fail", ["proj-1"], {
        prisma: prisma as never,
        ...columnCrossingDeps(introspector),
        extractor: {
          extract: async () => [
            {
              requirementId: null,
              title: "t",
              body: "b",
              changeType: "added" as const,
              bodyDelta: 10,
            },
          ],
        },
      } as never);

      expect(introspector).toHaveBeenCalledTimes(1);
      const row = tables.find((t) => t.columnName === "email");
      expect(row).toBeDefined();
      // Byte-identical to today's no-live-index behavior — never blocks/fails.
      expect(row?.reconciliation).toBeNull();
      expect(row?.changeKind).toBe("reference");
      expect(analyses.get("ia-live-fail")?.status).toBe("completed");
    });

    it("skips the async introspector when a synchronous liveIndexFor is injected directly", async () => {
      const { prisma, analyses } = serviceePrismaMock();
      analyses.set("ia-live-sync", { id: "ia-live-sync", sourceText: "text", documentId: null });
      const introspector = vi.fn(async () => new LiveSchemaIndex([]));
      const syncIndex = new LiveSchemaIndex([
        {
          schema: "shop",
          name: "orders",
          columns: new Map([
            [
              "email",
              { name: "email", dataType: "varchar(255)", nullable: true, isPrimaryKey: false },
            ],
          ]),
        },
      ]);

      await executeImpactAnalysis("ia-live-sync", ["proj-1"], {
        prisma: prisma as never,
        ...columnCrossingDeps(introspector),
        liveIndexFor: () => syncIndex,
        extractor: {
          extract: async () => [
            {
              requirementId: null,
              title: "t",
              body: "b",
              changeType: "added" as const,
              bodyDelta: 10,
            },
          ],
        },
      } as never);

      expect(introspector).not.toHaveBeenCalled();
    });

    it("never introspects the live schema when includeSchemaImpact is false", async () => {
      const { prisma, analyses } = serviceePrismaMock();
      analyses.set("ia-live-off", { id: "ia-live-off", sourceText: "text", documentId: null });
      const introspector = vi.fn(async () => new LiveSchemaIndex([]));

      await executeImpactAnalysis("ia-live-off", ["proj-1"], {
        prisma: prisma as never,
        includeSchemaImpact: false,
        extractor: {
          extract: async () => [
            { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 10 },
          ],
        },
        mapRequirement: async () => [
          {
            codeSymbolId: "A",
            filePath: "A.ts",
            qualifiedName: "pkg.A",
            startLine: 1,
            endLine: 5,
            confidence: 0.8,
          },
        ],
        dataSourceFor: () => mockDataSource(GRAPH),
        liveIndexIntrospectorFor: introspector,
      });

      expect(introspector).not.toHaveBeenCalled();
    });
  });

  it("falls back to quarantined chunks when the document has no approved chunks", async () => {
    const { prisma, analyses, items } = serviceePrismaMock();
    analyses.set("ia-quar", { id: "ia-quar", sourceText: null, documentId: "doc-1" });
    // No approved knowledge chunks, but the document's content lives in quarantine.
    prisma.knowledgeChunk.findMany = vi.fn(async () => []);
    prisma.quarantineChunk.findMany = vi.fn(async () => [
      { text: "The regional hub credit limit shall be configurable." },
    ]);
    await executeImpactAnalysis("ia-quar", ["proj-1"], {
      prisma: prisma as never,
      // Real heuristic extractor proves the source text was actually resolved.
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 5,
          confidence: 0.8,
        },
      ],
      dataSourceFor: () => mockDataSource(GRAPH),
    });
    expect(prisma.quarantineChunk.findMany).toHaveBeenCalled();
    expect(items.length).toBeGreaterThan(0);
    expect(analyses.get("ia-quar")?.status).toBe("completed");
    expect(analyses.get("ia-quar")?.totalImpactedSymbols).toBeGreaterThan(0);
  });

  it("marks the run failed when extraction throws", async () => {
    const { prisma, analyses } = serviceePrismaMock();
    analyses.set("ia-fail", { id: "ia-fail", sourceText: "text", documentId: null });
    await executeImpactAnalysis("ia-fail", ["proj-1"], {
      prisma: prisma as never,
      extractor: {
        extract: async () => {
          throw new Error("boom");
        },
      },
    });
    const row = analyses.get("ia-fail");
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe("boom");
  });

  it("throws when the analysis row is missing", async () => {
    const { prisma } = serviceePrismaMock();
    await expect(executeImpactAnalysis("nope", ["p"], { prisma: prisma as never })).rejects.toThrow(
      /not found/i,
    );
  });

  it("creates a pending row and returns its id", async () => {
    const { prisma, analyses } = serviceePrismaMock();
    const out = await triggerImpactAnalysis(
      { projectIds: ["proj-1"], text: "Some change.", actorId: "user-1" },
      {
        prisma: prisma as never,
        extractor: { extract: async () => [] },
        dataSourceFor: () => mockDataSource(GRAPH),
      },
    );
    expect(out.id).toBe("ia-1");
    expect(out.status).toBe("pending");
    expect(analyses.has("ia-1")).toBe(true);
  });
});

// ---- Read projections ------------------------------------------------------

describe("listImpactAnalyses / getImpactAnalysisDetail", () => {
  const baseRow = {
    id: "ia-1",
    status: "completed",
    documentId: null,
    sourceText: "text",
    summary: "done",
    errorMessage: null,
    totalImpactedSymbols: 3,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:01:00Z"),
  };

  it("derives projectCount and filters by accessible projects", async () => {
    const prisma = {
      impactAnalysis: {
        findMany: vi.fn(async () => [
          { ...baseRow, items: [{ projectId: "p1" }, { projectId: "p2" }, { projectId: "p1" }] },
          { ...baseRow, id: "ia-2", items: [{ projectId: "p9" }] },
        ]),
      },
    };
    const all = await listImpactAnalyses({}, prisma as never);
    expect(all).toHaveLength(2);
    expect(all[0].projectCount).toBe(2);

    const scoped = await listImpactAnalyses({ accessibleProjectIds: ["p1"] }, prisma as never);
    expect(scoped.map((s) => s.id)).toEqual(["ia-1"]);
  });

  it("returns null when an analysis is missing", async () => {
    const prisma = { impactAnalysis: { findFirst: vi.fn(async () => null) } };
    expect(await getImpactAnalysisDetail("missing", prisma as never)).toBeNull();
  });

  it("builds a per-project detail view with requirement titles", async () => {
    const prisma = {
      impactAnalysis: {
        findFirst: vi.fn(async () => ({
          ...baseRow,
          items: [
            {
              id: "item-1",
              projectId: "p1",
              requirementId: "r1",
              changeType: "added",
              severity: "low",
              impactScore: 0.4,
              confidence: 0.8,
              affectedFileCount: 1,
              affectedSymbolCount: 1,
              requirement: { title: "Req One" },
              affectedSymbols: [
                {
                  id: "as-1",
                  codeSymbolId: "A",
                  filePath: "A.ts",
                  qualifiedName: "pkg.A",
                  startLine: 1,
                  endLine: 5,
                  relation: "direct",
                  depth: 0,
                  confidence: 0.8,
                },
              ],
            },
          ],
        })),
      },
    };
    const detail = await getImpactAnalysisDetail("ia-1", prisma as never);
    expect(detail?.projectIds).toEqual(["p1"]);
    expect(detail?.items[0].requirementTitle).toBe("Req One");
    expect(detail?.items[0].affectedSymbols[0].relation).toBe("direct");
  });
});

/**
 * Issue #70 — the projects a run was started for are persisted WITH the run, and
 * the list read can see them before the executor has written anything.
 *
 * The assertions deliberately go back through `listImpactAnalyses` rather than
 * inspecting the row `create` returned: a write that reports success while the
 * read cannot see it is exactly the shape this issue was.
 */
describe("triggerImpactAnalysis — #70 persists the selected projects", () => {
  /** A store both the write and the read see, as one database would be. */
  function roundTripPrisma() {
    const rows: Array<{
      id: string;
      status: string;
      documentId: string | null;
      summary: string | null;
      totalImpactedSymbols: number;
      startedAt: Date;
      completedAt: Date | null;
      rerunOfId: string | null;
      items: Array<{ projectId: string }>;
      projects: Array<{ projectId: string }>;
    }> = [];
    let seq = 0;
    const prisma = {
      impactAnalysis: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const nested = data.projects as { create?: Array<{ projectId: string }> } | undefined;
          const row = {
            id: `ia-${++seq}`,
            status: String(data.status ?? "pending"),
            documentId: (data.documentId as string | null) ?? null,
            summary: null,
            totalImpactedSymbols: 0,
            startedAt: new Date(),
            completedAt: null,
            rerunOfId: (data.rerunOfId as string | null) ?? null,
            items: [],
            // Only a nested create lands here — a `projectIds` passed to the
            // executor alone leaves this empty, which is the bug.
            projects: nested?.create ?? [],
          };
          rows.push(row);
          return row;
        }),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
        findMany: vi.fn(
          async (args: {
            where?: { OR?: Array<{ projects?: { some?: { projectId?: string } } }> };
          }) => {
            const arms = args.where?.OR;
            if (!arms) return rows;
            return rows.filter((r) =>
              arms.some((a) => {
                const pid = a.projects?.some?.projectId;
                return pid ? r.projects.some((p) => p.projectId === pid) : false;
              }),
            );
          },
        ),
      },
      impactItem: { create: vi.fn(async () => ({})) },
      impactAffectedSymbol: { createMany: vi.fn(async () => ({ count: 0 })) },
      impactAffectedTable: { createMany: vi.fn(async () => ({ count: 0 })) },
      knowledgeChunk: { findMany: vi.fn(async () => []) },
      quarantineChunk: { findMany: vi.fn(async () => []) },
      document: {},
      codeSymbol: {},
      codeEdge: {},
    };
    return { prisma, rows };
  }

  it("a run is listed on its project before any item exists", async () => {
    const { prisma } = roundTripPrisma();
    const created = await triggerImpactAnalysis(
      { projectIds: ["proj-a", "proj-b"], text: "change", actorId: "u1" },
      { prisma: prisma as never, extractor: { extract: async () => [] } },
    );

    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["proj-a"], projectId: "proj-a" },
      prisma as never,
    );
    expect(listed.map((r) => r.id)).toEqual([created.id]);
    expect(listed[0].projectCount).toBe(2);
    expect(listed[0].projectIds).toEqual(["proj-a"]);
  });

  it("deduplicates a repeated project id instead of writing it twice", async () => {
    const { prisma, rows } = roundTripPrisma();
    await triggerImpactAnalysis(
      { projectIds: ["proj-a", "proj-a"], text: "change", actorId: "u1" },
      { prisma: prisma as never, extractor: { extract: async () => [] } },
    );
    expect(rows[0].projects).toEqual([{ projectId: "proj-a" }]);
  });
});
