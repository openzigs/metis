/**
 * Issue #965 (Epic #960) — impact re-run + drift INTEGRATION fixture.
 *
 * Exercises the acceptance-criteria flow end-to-end over the real engine + read
 * layer (only the DB is a store-backed fake):
 *   analyze v1 graph → modify the graph → RE-RUN the same source → diff the two
 *   persisted runs → the diff surfaces the NEW code site.
 * Plus the determinism guarantee: an UNCHANGED graph ⇒ an empty diff.
 *
 * The original run's rows are asserted to be UNTOUCHED by the re-run (originals are
 * immutable).
 */
import { describe, expect, it, vi } from "vitest";
import type {
  CodeGraphDataSource,
  GraphEdge,
  GraphSymbol,
} from "../src/lib/code-graph/query-service.js";
import {
  executeImpactAnalysis,
  type ImpactServiceDeps,
} from "../src/lib/impact-analysis/impact-analysis-engine.js";
import { getImpactAnalysisDetail } from "../src/lib/impact-analysis/impact-analysis-read.js";
import { diffImpactRuns } from "../src/lib/impact-analysis/impact-drift.js";

// ---- In-memory code graph --------------------------------------------------

function sym(id: string): GraphSymbol {
  return {
    id,
    qualifiedName: `pkg.${id}`,
    kind: "function",
    filePath: `${id}.ts`,
    language: "ts",
    startLine: 1,
    endLine: 10,
  };
}

function graphSource(symbols: GraphSymbol[], edges: GraphEdge[]): CodeGraphDataSource {
  return {
    async getSymbol(id) {
      return symbols.find((s) => s.id === id) ?? null;
    },
    async getEdgesFrom(id) {
      return edges.filter((e) => e.fromSymbolId === id);
    },
    async getEdgesTo(id) {
      return edges.filter((e) => e.toSymbolId === id);
    },
    async getSymbolsByFile(fp) {
      return symbols.filter((s) => s.filePath === fp);
    },
    async getSymbolsByIds(ids) {
      return symbols.filter((s) => ids.includes(s.id));
    },
  };
}

// v1: only B calls A. v2: C ALSO calls A (a new code site enters the blast radius).
const SYMBOLS = [sym("A"), sym("B"), sym("C")];
const V1_EDGES: GraphEdge[] = [{ id: "e1", fromSymbolId: "B", toSymbolId: "A", kind: "calls" }];
const V2_EDGES: GraphEdge[] = [
  ...V1_EDGES,
  { id: "e2", fromSymbolId: "C", toSymbolId: "A", kind: "calls" },
];

// ---- Store-backed fake prisma ----------------------------------------------

interface Row {
  [k: string]: unknown;
}

function fakeStore() {
  const analyses = new Map<string, Row>();
  const items: Row[] = [];
  const symbolsById = new Map<string, Row[]>(); // impactItemId -> affected symbols
  const tablesById = new Map<string, Row[]>(); // impactItemId -> affected tables

  const prisma = {
    impactAnalysis: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row: Row = {
          id: (data.id as string) ?? `ia-${analyses.size}`,
          startedAt: new Date(),
          completedAt: null,
          totalImpactedSymbols: 0,
          summary: null,
          errorMessage: null,
          documentId: null,
          sourceText: null,
          status: "pending",
          rerunOfId: null,
          ...data,
        };
        analyses.set(row.id as string, row);
        return row;
      }),
      findFirst: vi.fn(async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        const row = analyses.get(where.id);
        if (!row) return null;
        if (!include) return row;
        // Assemble the nested `items` include used by getImpactAnalysisDetail.
        const nestedItems = items
          .filter((i) => i.impactAnalysisId === row.id)
          .map((i) => ({
            ...i,
            affectedSymbols: symbolsById.get(i.id as string) ?? [],
            affectedTables: (tablesById.get(i.id as string) ?? []).map((t) => ({
              ...t,
              consumers: [],
            })),
            feedback: [],
            requirement: null,
          }));
        return { ...row, items: nestedItems };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = { ...analyses.get(where.id), ...data };
        analyses.set(where.id, row);
        return row;
      }),
    },
    impactItem: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row: Row = { id: `item-${items.length}`, ...data };
        items.push(row);
        return row;
      }),
    },
    impactAffectedSymbol: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        for (const d of data) {
          const list = symbolsById.get(d.impactItemId as string) ?? [];
          list.push({ id: `sym-${list.length}`, codeSymbolId: null, ...d });
          symbolsById.set(d.impactItemId as string, list);
        }
        return { count: data.length };
      }),
    },
    impactAffectedTable: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        for (const d of data) {
          const list = tablesById.get(d.impactItemId as string) ?? [];
          list.push({ id: (d.id as string) ?? `tbl-${list.length}`, ...d });
          tablesById.set(d.impactItemId as string, list);
        }
        return { count: data.length };
      }),
    },
    impactAffectedTableConsumer: { createMany: vi.fn(async () => ({ count: 0 })) },
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    quarantineChunk: { findMany: vi.fn(async () => []) },
    document: {},
    // Present but empty so the read's write-path-gap pass no-ops.
    codeSymbol: { findMany: vi.fn(async () => []) },
    codeEdge: { findMany: vi.fn(async () => []) },
  };
  return { prisma, analyses, items, symbolsById };
}

function baseDeps(edges: GraphEdge[]): ImpactServiceDeps {
  const ds = graphSource(SYMBOLS, edges);
  return {
    includeSchemaImpact: false,
    extractor: {
      extract: async () => [
        {
          requirementId: "r1",
          title: "Account status handling",
          body: "b",
          changeType: "modified",
          bodyDelta: 20,
        },
      ],
    },
    mapRequirement: async () => [
      {
        codeSymbolId: "A",
        filePath: "A.ts",
        qualifiedName: "pkg.A",
        startLine: 1,
        endLine: 10,
        confidence: 0.9,
      },
    ],
    dataSourceFor: () => ds,
  };
}

async function runAndRead(
  store: ReturnType<typeof fakeStore>,
  id: string,
  edges: GraphEdge[],
  rerunOfId: string | null,
) {
  store.analyses.set(id, {
    id,
    sourceText: "Account status handling change",
    documentId: null,
    rerunOfId,
    status: "pending",
    startedAt: new Date(),
    completedAt: null,
    summary: null,
    errorMessage: null,
    totalImpactedSymbols: 0,
  });
  await executeImpactAnalysis(id, ["proj-1"], {
    ...baseDeps(edges),
    prisma: store.prisma as never,
  });
  const detail = await getImpactAnalysisDetail(id, store.prisma as never);
  if (!detail) throw new Error("detail not found");
  return detail;
}

describe("impact re-run + drift integration (#965)", () => {
  it("re-running after a graph change surfaces the new code site", async () => {
    const store = fakeStore();
    const base = await runAndRead(store, "run-v1", V1_EDGES, null);
    // The original run impacted A + B (B calls A).
    expect(base.items[0].affectedSymbols.map((s) => s.qualifiedName).sort()).toEqual([
      "pkg.A",
      "pkg.B",
    ]);

    // Modify the graph so C now also reaches A, then RE-RUN the same source.
    const head = await runAndRead(store, "run-v2", V2_EDGES, "run-v1");
    expect(head.rerunOfId).toBe("run-v1");

    const report = diffImpactRuns(base, head);
    expect(report.baseAnalysisId).toBe("run-v1");
    expect(report.headAnalysisId).toBe("run-v2");
    expect(report.requirements).toHaveLength(1);
    const drift = report.requirements[0];
    expect(drift.status).toBe("changed");
    // pkg.C is the NEW site the re-run surfaced.
    expect(drift.symbolsAdded).toEqual(["C.ts::pkg.C"]);
    expect(drift.symbolsRemoved).toEqual([]);
    expect(report.summary.symbolsAdded).toBe(1);
  });

  it("re-running against an UNCHANGED graph ⇒ empty diff (determinism)", async () => {
    const store = fakeStore();
    const base = await runAndRead(store, "run-a", V1_EDGES, null);
    const head = await runAndRead(store, "run-b", V1_EDGES, "run-a");

    const report = diffImpactRuns(base, head);
    expect(report.requirements).toEqual([]);
    expect(report.summary.symbolsAdded).toBe(0);
    expect(report.summary.requirementsChanged).toBe(0);
  });

  it("leaves the original run's rows untouched (originals are immutable)", async () => {
    const store = fakeStore();
    const base = await runAndRead(store, "run-orig", V1_EDGES, null);
    const originalSymbolCount = base.totalImpactedSymbols;
    const originalItemIds = base.items.map((i) => i.id);

    await runAndRead(store, "run-rerun", V2_EDGES, "run-orig");

    const reread = await getImpactAnalysisDetail("run-orig", store.prisma as never);
    expect(reread?.totalImpactedSymbols).toBe(originalSymbolCount);
    expect(reread?.items.map((i) => i.id)).toEqual(originalItemIds);
    expect(reread?.rerunOfId).toBeNull();
  });
});
