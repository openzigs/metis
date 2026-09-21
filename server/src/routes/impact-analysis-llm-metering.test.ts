/**
 * Issues #1021 + #1024 — the WIRING tests.
 *
 * `impact-llm-runtime.test.ts` proves the decorator meters and bounds a call.
 * This file proves the route actually routes every stage through it, and that a
 * whole run survives a provider that is absent, broken, or hanging.
 *
 * The token tracker is the REAL one: the assertion of record is a row landing in
 * `prisma.aITokenUsage.create`, because "the wrapper was called" is exactly the
 * kind of proxy assertion that let #1021 ship unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse, TokenUsage } from "../lib/ai/types.js";
import type { AffectedTableInput } from "../lib/impact-analysis/schema-impact.js";
import type { ImpactItemFacts } from "../lib/impact-analysis/impact-summarizer.js";
import { runInImpactProjectScope } from "../lib/impact-analysis/impact-llm-scope.js";

// ── Fakes wired before the module graph loads ───────────────────────────────

const tokenRows: Array<Record<string, unknown>> = [];
const codeSymbolRows: Array<Record<string, unknown>> = [];

const prismaMock = {
  aISession: { create: vi.fn(async () => ({ id: "sess-imp-1" })) },
  aITokenUsage: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      tokenRows.push(data);
      return data;
    }),
  },
  codeSymbol: { findMany: vi.fn(async () => codeSymbolRows) },
};
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

let providerFactory: () => AIProvider = () => offlineProvider();
vi.mock("../lib/ai/index.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/ai/index.js")>("../lib/ai/index.js");
  return {
    ...actual,
    loadAIConfig: () => ({}) as never,
    buildProvider: () => providerFactory(),
  };
});

const { impactRunDeps } = await import("./impact-analysis.js");
const { executeImpactAnalysis } = await import("../lib/impact-analysis/impact-analysis-engine.js");
const { __resetTokenTrackerSingleton, getTokenTracker } =
  await import("../lib/ai/token-tracker.js");

// ── Provider doubles ────────────────────────────────────────────────────────

const USAGE: TokenUsage = { promptTokens: 1200, completionTokens: 180, totalTokens: 1380 };

function offlineProvider(): AIProvider {
  return {
    key: "offline-stub",
    model: "offline",
    offline: true,
    chat: async () => ({
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "offline",
      provider: "offline-stub",
    }),
    async *stream() {},
    embed: async () => ({ vectors: [], model: "e", dimensions: 0 }),
    models: async () => [],
    ping: async () => true,
  } as unknown as AIProvider;
}

function liveProvider(reply: (prompt: string) => string): AIProvider {
  return {
    key: "anthropic",
    model: "claude-sonnet-5",
    offline: false,
    chat: async (messages: Array<{ content?: unknown }>): Promise<ChatResponse> => ({
      content: reply(JSON.stringify(messages)),
      usage: USAGE,
      model: "claude-sonnet-5",
      provider: "anthropic",
    }),
    async *stream() {},
    embed: async () => ({ vectors: [], model: "e", dimensions: 0 }),
    models: async () => [],
    ping: async () => true,
  } as unknown as AIProvider;
}

/** A reply that satisfies every stage's schema: they parse the first JSON object. */
function universalReply(): string {
  return JSON.stringify({
    summary: "The change is narrow and touches a small number of call sites.",
    decisions: [{ index: 0, tier: "likely", rationale: "directly named by the requirement" }],
    proposals: [
      {
        index: 0,
        columnName: "cancelled_by",
        columnType: "VARCHAR(64)",
        rationale: "records who cancelled",
      },
    ],
    gaps: [{ index: 0, clause: "who cancelled it", rationale: "no surfaced table stores it" }],
    entities: ["orders"],
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function tableRow(name: string): AffectedTableInput {
  return {
    objectKind: "table",
    tableName: name,
    columnName: null,
    columnType: null,
    changeKind: "verify",
    suggestedDdl: `-- Verify table ${name}`,
    source: "orm",
    reconciliation: null,
    confidence: 0.7,
  } as unknown as AffectedTableInput;
}

function itemFacts(): ImpactItemFacts {
  return {
    requirementTitle: "Cancelled orders must record who cancelled them",
    requirementBody: "",
    changeType: "modified",
    severity: "medium",
    impactScore: 0.5,
    confidence: 0.6,
    affectedFileCount: 1,
    affectedSymbolCount: 1,
    affectedSymbols: [{ qualifiedName: "pkg.A", filePath: "A.ts", relation: "caller", depth: 1 }],
    affectedTablesPrimary: [],
    affectedTablesSecondary: [],
  } as unknown as ImpactItemFacts;
}

function servicePrismaMock() {
  const analyses = new Map<string, Record<string, unknown>>();
  const items: Array<Record<string, unknown>> = [];
  const affected: Array<Record<string, unknown>> = [];
  return {
    analyses,
    items,
    affected,
    prisma: {
      impactAnalysis: {
        findFirst: vi.fn(
          async ({ where }: { where: { id: string } }) => analyses.get(where.id) ?? null,
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            analyses.set(where.id, { ...analyses.get(where.id), ...data });
            return analyses.get(where.id);
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
      impactAffectedTable: { createMany: vi.fn(async () => ({ count: 0 })) },
      knowledgeChunk: { findMany: vi.fn(async () => []) },
      quarantineChunk: { findMany: vi.fn(async () => []) },
      document: {},
      codeSymbol: {},
      codeEdge: {},
    },
  };
}

const RUN_DEPS = {
  extractor: {
    extract: async () => [
      {
        requirementId: null,
        title: "Cancelled orders must record who cancelled them",
        body: "and when",
        changeType: "modified",
        bodyDelta: 12,
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
  dataSourceFor: () => ({
    getSymbol: async (id: string) => ({
      id,
      qualifiedName: `pkg.${id}`,
      kind: "function",
      filePath: `${id}.ts`,
      language: "ts",
      startLine: 1,
      endLine: 10,
    }),
    getEdgesFrom: async () => [],
    getEdgesTo: async () => [],
    getSymbolsByFile: async () => [],
    getSymbolsByIds: async () => [],
  }),
  includeSchemaImpact: false,
};

/** Drain the token tracker's queued durable writes. */
async function flushTokenWrites(): Promise<void> {
  for (let i = 0; i < 50 && getTokenTracker().inFlight > 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  tokenRows.length = 0;
  codeSymbolRows.length = 0;
  prismaMock.aISession.create.mockClear();
  __resetTokenTrackerSingleton();
  providerFactory = () => liveProvider(() => universalReply());
  for (const flag of [
    "IMPACT_LLM_TABLE_FILTER",
    "IMPACT_LLM_ADDITIVE_DDL",
    "IMPACT_LLM_CLAUSE_RECONCILE",
    "IMPACT_LLM_SUMMARY",
    "IMPACT_LLM_ENTITY_SEEDS",
    "IMPACT_LLM_SEEDING",
  ]) {
    vi.stubEnv(flag, "0");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#1021 — impact LLM stages reach the token ledger", () => {
  it("writes a non-zero ai_token_usages row, tagged with the project, for a run with the flags on", async () => {
    vi.stubEnv("IMPACT_LLM_SUMMARY", "1");
    const { prisma, analyses, items } = servicePrismaMock();
    analyses.set("ia-meter", { id: "ia-meter", sourceText: "text", documentId: null });

    await executeImpactAnalysis("ia-meter", ["proj-1"], {
      ...RUN_DEPS,
      ...impactRunDeps("user-1", ["proj-1"]),
      prisma: prisma as never,
    });
    await flushTokenWrites();

    expect(analyses.get("ia-meter")?.status).toBe("completed");
    expect(items.length).toBeGreaterThan(0);

    // The regression this issue is about: zero rows for a run that made calls.
    expect(tokenRows.length).toBeGreaterThan(0);
    for (const row of tokenRows) {
      expect(row.projectId).toBe("proj-1");
      expect(row.provider).toBe("anthropic");
      expect(row.model).toBe("claude-sonnet-5");
      expect(row.totalTokens as number).toBeGreaterThan(0);
      expect(["impact.summary-item", "impact.summary-run"]).toContain(row.agentStep);
      expect(row.estimatedCostUsd as number).toBeGreaterThan(0);
      expect(row.sessionId).toBe("sess-imp-1");
      expect(row.userId).toBe("user-1");
    }
    // #1033 — the run makes BOTH summarizer calls; each meters under its OWN
    // agentStep so the ledger can never re-conflate them.
    expect(new Set(tokenRows.map((r) => r.agentStep))).toEqual(
      new Set(["impact.summary-item", "impact.summary-run"]),
    );
  });

  it("meters EVERY flag-gated stage the route wires, each under its own agentStep", async () => {
    for (const flag of [
      "IMPACT_LLM_TABLE_FILTER",
      "IMPACT_LLM_ADDITIVE_DDL",
      "IMPACT_LLM_CLAUSE_RECONCILE",
      "IMPACT_LLM_SUMMARY",
      "IMPACT_LLM_ENTITY_SEEDS",
    ]) {
      vi.stubEnv(flag, "1");
    }
    codeSymbolRows.push(
      {
        id: "t-orders",
        name: "orders",
        qualifiedName: "orders",
        kind: "table",
        filePath: "schema.sql",
        language: "sql",
        startLine: 1,
        endLine: 1,
      },
      {
        id: "t-account",
        name: "account",
        qualifiedName: "account",
        kind: "table",
        filePath: "schema.sql",
        language: "sql",
        startLine: 2,
        endLine: 2,
      },
      {
        id: "s-order-service",
        name: "OrderService",
        qualifiedName: "com.app.OrderService",
        kind: "class",
        filePath: "src/OrderService.java",
        language: "java",
        startLine: 1,
        endLine: 40,
      },
    );

    const deps = impactRunDeps("user-1", ["proj-1"]);
    const requirement = "A cancelled order must record who cancelled it and when";

    await runInImpactProjectScope("proj-1", async () => {
      await deps.tableRelevanceFilter!(requirement, [tableRow("orders")]);
      await deps.additiveColumnProposer!(requirement, [tableRow("orders")]);
      await deps.clauseCoverageReconciler!(requirement, "proj-1", ["orders"]);
      await deps.impactSummarizer!.summarizeItem(itemFacts());
      await deps.mapRequirement!(
        { requirementId: null, title: requirement, body: "", changeType: "modified", bodyDelta: 1 },
        "proj-1",
      );
    });
    await flushTokenWrites();

    const steps = new Set(tokenRows.map((r) => r.agentStep));
    expect(steps).toEqual(
      new Set([
        "impact.table-filter",
        "impact.additive-ddl",
        "impact.clause-reconcile",
        "impact.summary-item",
        "impact.entity-seeds",
      ]),
    );
    expect(tokenRows.every((r) => r.projectId === "proj-1")).toBe(true);
    // One backing session for the whole run, not one per stage.
    expect(prismaMock.aISession.create).toHaveBeenCalledTimes(1);
  });

  it("writes nothing and builds no session when every flag is off", async () => {
    const { prisma, analyses } = servicePrismaMock();
    analyses.set("ia-off", { id: "ia-off", sourceText: "text", documentId: null });

    await executeImpactAnalysis("ia-off", ["proj-1"], {
      ...RUN_DEPS,
      ...impactRunDeps("user-1", ["proj-1"]),
      prisma: prisma as never,
    });
    await flushTokenWrites();

    expect(analyses.get("ia-off")?.status).toBe("completed");
    expect(tokenRows).toHaveLength(0);
    expect(prismaMock.aISession.create).not.toHaveBeenCalled();
    expect(analyses.get("ia-off")?.summary).not.toMatch(/AI enrichment/);
  });
});

describe("#1024 — graceful degradation with no usable provider", () => {
  async function runWith(id: string, factory: () => AIProvider) {
    providerFactory = factory;
    for (const flag of [
      "IMPACT_LLM_TABLE_FILTER",
      "IMPACT_LLM_ADDITIVE_DDL",
      "IMPACT_LLM_CLAUSE_RECONCILE",
      "IMPACT_LLM_SUMMARY",
    ]) {
      vi.stubEnv(flag, "1");
    }
    const { prisma, analyses, items, affected } = servicePrismaMock();
    analyses.set(id, { id, sourceText: "text", documentId: null });
    await executeImpactAnalysis(id, ["proj-1"], {
      ...RUN_DEPS,
      ...impactRunDeps("user-1", ["proj-1"]),
      prisma: prisma as never,
    });
    await flushTokenWrites();
    return { row: analyses.get(id)!, items, affected };
  }

  it("completes on the deterministic floor when NO provider is configured, and says so", async () => {
    const { row, items, affected } = await runWith("ia-none", offlineProvider);

    expect(row.status).toBe("completed");
    expect(row.completedAt).toBeInstanceOf(Date);
    // The deterministic floor is intact — affected code still produced.
    expect(items.length).toBeGreaterThan(0);
    expect(affected.length).toBeGreaterThan(0);
    expect(row.totalImpactedSymbols as number).toBeGreaterThan(0);
    // Honest: the analyst is told, by name, which enrichment they did not get.
    expect(row.summary).toContain("AI enrichment did not run");
    expect(row.summary).toContain("no AI provider is configured");
    expect(row.summary).toContain("table relevance filtering");
    expect(row.summary).toContain("narrative summaries");
    // No LLM-derived rows, partial or otherwise.
    expect(tokenRows).toHaveLength(0);
  });

  it("completes when the provider throws on every call", async () => {
    const { row, items } = await runWith("ia-throw", () =>
      liveProvider(() => {
        throw new Error("401 invalid x-api-key");
      }),
    );

    expect(row.status).toBe("completed");
    expect(items.length).toBeGreaterThan(0);
    expect(row.summary).toContain("the AI provider returned an error");
  });

  it("completes — not stuck in running — when the provider hangs past the deadline", async () => {
    vi.stubEnv("IMPACT_LLM_TIMEOUT_MS", "25");
    const hanging = () =>
      ({
        ...liveProvider(() => ""),
        chat: () => new Promise<ChatResponse>(() => {}),
      }) as unknown as AIProvider;

    const { row, items } = await runWith("ia-hang", hanging);

    expect(row.status).toBe("completed");
    expect(row.status).not.toBe("running");
    expect(items.length).toBeGreaterThan(0);
    expect(row.summary).toContain("the AI provider timed out");
  }, 15_000);

  it("completes when the provider cannot even be constructed (bad config / missing key)", async () => {
    const { row, items } = await runWith("ia-build-fail", () => {
      throw new Error("anthropic provider reached the factory without a resolved sdkProvider");
    });

    expect(row.status).toBe("completed");
    expect(items.length).toBeGreaterThan(0);
    expect(row.summary).toContain("AI enrichment did not run");
    expect(tokenRows).toHaveLength(0);
  });

  it("keeps the deterministic run overview when the summarizer degrades", async () => {
    const { row } = await runWith("ia-det-summary", offlineProvider);
    expect(row.summary).toMatch(/Impacted \d+ symbol\(s\)/);
  });
});
