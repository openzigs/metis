/**
 * #932 (epic #929) — engine wiring test for the LLM impact summarizer.
 *
 * Drives `executeImpactAnalysis` with a (mocked) summarizer and a reconstructing
 * fake Prisma (no real DB, no SQL) to prove the product boundary: the per-item
 * narrative is PERSISTED on `ImpactItem.summary`, the grounded run overview
 * OVERRIDES the deterministic run summary, and — with no summarizer or a null
 * summary — the item summary is NULL and the deterministic run summary stands
 * (non-blocking passthrough).
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage } from "../src/lib/ai/types.js";
import type { CodeGraphDataSource, GraphSymbol } from "../src/lib/code-graph/query-service.js";
import { executeImpactAnalysis } from "../src/lib/impact-analysis/impact-analysis-engine.js";
import { getImpactAnalysisDetail } from "../src/lib/impact-analysis/impact-analysis-read.js";
import {
  buildImpactSummarizer,
  type ImpactSummarizer,
} from "../src/lib/impact-analysis/impact-summarizer.js";

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

function codeGraph(): CodeGraphDataSource {
  const symbols: Record<string, GraphSymbol> = { A: sym("A") };
  return {
    async getSymbol(id) {
      return symbols[id] ?? null;
    },
    async getEdgesFrom() {
      return [];
    },
    async getEdgesTo() {
      return [];
    },
    async getSymbolsByFile(fp) {
      return Object.values(symbols).filter((s) => s.filePath === fp);
    },
    async getSymbolsByIds(ids) {
      return ids.map((id) => symbols[id]).filter(Boolean) as GraphSymbol[];
    },
  };
}

interface Store {
  analyses: Map<string, Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  symbols: Array<Record<string, unknown>>;
  tables: Array<Record<string, unknown>>;
}

function reconstructingPrisma(store: Store) {
  return {
    impactAnalysis: {
      findFirst: vi.fn(
        async (args: { where: { id: string }; include?: Record<string, unknown> }) => {
          const row = store.analyses.get(args.where.id);
          if (!row) return null;
          if (args.include) {
            const items = store.items.map((it) => ({
              ...it,
              requirement: null,
              affectedSymbols: store.symbols.filter((s) => s.impactItemId === it.id),
              affectedTables: store.tables.filter((t) => t.impactItemId === it.id),
            }));
            return { ...row, items };
          }
          return row;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...store.analyses.get(where.id), ...data };
          store.analyses.set(where.id, row);
          return row;
        },
      ),
    },
    impactItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `item-${store.items.length}`, ...data };
        store.items.push(row);
        return row;
      }),
    },
    impactAffectedSymbol: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        store.symbols.push(
          ...data.map((d, i) => ({ id: `sym-${store.symbols.length + i}`, ...d })),
        );
        return { count: data.length };
      }),
    },
    impactAffectedTable: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        store.tables.push(...data.map((d, i) => ({ id: `tbl-${store.tables.length + i}`, ...d })));
        return { count: data.length };
      }),
    },
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    quarantineChunk: { findMany: vi.fn(async () => []) },
  };
}

function seedStore(): Store {
  const store: Store = { analyses: new Map(), items: [], symbols: [], tables: [] };
  store.analyses.set("ia-1", {
    id: "ia-1",
    status: "pending",
    sourceText: "Add a discontinued flag",
    documentId: null,
    summary: null,
    errorMessage: null,
    totalImpactedSymbols: 0,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
  });
  return store;
}

async function run(store: Store, impactSummarizer?: ImpactSummarizer) {
  const prisma = reconstructingPrisma(store);
  await executeImpactAnalysis("ia-1", ["proj-1"], {
    prisma: prisma as never,
    includeSchemaImpact: false,
    extractor: {
      extract: async () => [
        {
          requirementId: null,
          title: "discontinued flag",
          body: "add flag",
          changeType: "added",
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
    dataSourceFor: () => codeGraph(),
    impactSummarizer,
  });
  return getImpactAnalysisDetail("ia-1", prisma as never);
}

describe("#932 engine wiring — impact summarizer", () => {
  it("persists the per-item narrative and overrides the run summary with a grounded overview", async () => {
    const summarizer: ImpactSummarizer = {
      summarizeItem: vi.fn(async () => ({
        summary: "ITEM NARRATIVE",
        applied: true,
        grounded: true,
      })),
      summarizeRun: vi.fn(async () => ({ summary: "RUN OVERVIEW", applied: true, grounded: true })),
    };
    const store = seedStore();
    const detail = await run(store, summarizer);

    expect(store.items[0].summary).toBe("ITEM NARRATIVE");
    expect(store.analyses.get("ia-1")?.summary).toBe("RUN OVERVIEW");
    expect(detail?.summary).toBe("RUN OVERVIEW");
    expect(detail?.items[0].summary).toBe("ITEM NARRATIVE");
    expect(summarizer.summarizeItem).toHaveBeenCalledTimes(1);
    expect(summarizer.summarizeRun).toHaveBeenCalledTimes(1);
  });

  it("with no summarizer, item summary is null and the deterministic run summary stands", async () => {
    const store = seedStore();
    const detail = await run(store);
    expect(store.items[0].summary).toBeNull();
    expect(String(detail?.summary)).toMatch(/^Impacted 1 symbol/);
    expect(detail?.items[0].summary).toBeNull();
  });

  // #941 — end-to-end through the REAL summarizer (not a mocked ImpactSummarizer):
  // a live-shaped item narrative that names the fact symbol AND gives a generic
  // category caution must survive grounding, land on ImpactItem.summary, and be
  // returned by the read path. This is the regression that was dropping to null.
  function proseProvider(item: string, run: string, opts: { offline?: boolean } = {}): AIProvider {
    return {
      key: "anthropic",
      model: "mock",
      offline: opts.offline ?? false,
      chat: vi.fn(async (messages: ChatMessage[]) => {
        const isRun = String(messages[0]?.content ?? "").includes("roll-up of an impact-analysis");
        return {
          content: JSON.stringify({ summary: isRun ? run : item }),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "mock",
          provider: "anthropic",
        };
      }),
    } as unknown as AIProvider;
  }

  it("populates + surfaces a grounded per-item narrative through the REAL summarizer (#941)", async () => {
    const provider = proseProvider(
      "This change affects `pkg.A`; review related reporting tables before deploying.",
      "Across 1 project, 1 change impacts 1 symbol.",
    );
    const summarizer = buildImpactSummarizer({ itemProvider: provider, runProvider: provider });
    const store = seedStore();
    const detail = await run(store, summarizer);

    expect(detail?.items[0].summary).toBe(
      "This change affects `pkg.A`; review related reporting tables before deploying.",
    );
    expect(store.items[0].summary).toContain("reporting tables");
  });

  it("degrades the item narrative to null when the REAL summarizer's provider is offline (#941)", async () => {
    const provider = proseProvider("`pkg.A` is affected.", "run overview", { offline: true });
    const summarizer = buildImpactSummarizer({ itemProvider: provider, runProvider: provider });
    const store = seedStore();
    const detail = await run(store, summarizer);
    expect(detail?.items[0].summary).toBeNull();
    expect(String(detail?.summary)).toMatch(/^Impacted 1 symbol/);
  });

  it("degrades the item narrative to null on a malformed provider reply, never throwing (#941)", async () => {
    const provider = {
      key: "anthropic",
      model: "mock",
      offline: false,
      chat: vi.fn(async () => ({
        content: "not json at all {{{",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "mock",
        provider: "anthropic",
      })),
    } as unknown as AIProvider;
    const store = seedStore();
    const detail = await run(
      store,
      buildImpactSummarizer({ itemProvider: provider, runProvider: provider }),
    );
    expect(detail?.items[0].summary).toBeNull();
  });

  it("a null LLM summary degrades to null item summary + deterministic run summary", async () => {
    const summarizer: ImpactSummarizer = {
      summarizeItem: vi.fn(async () => ({ summary: null, applied: true, grounded: false })),
      summarizeRun: vi.fn(async () => ({ summary: null, applied: true, grounded: false })),
    };
    const store = seedStore();
    const detail = await run(store, summarizer);
    expect(store.items[0].summary).toBeNull();
    expect(String(detail?.summary)).toMatch(/^Impacted 1 symbol/);
  });
});
