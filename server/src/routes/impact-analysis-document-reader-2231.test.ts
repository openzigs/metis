/**
 * #2231 — the route wires the document reader into an impact run behind
 * `ANALYSIS_DOCUMENT_READER`, through the run's LLM runtime: the reading is
 * metered as its own stage, and a run whose reader has no provider says so.
 *
 * The reader here is the REAL one (`document-reader/reader.ts`), answering a
 * scripted provider, so the changes a run analyses are the statements the
 * reader verified against the document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../lib/ai/types.js";
import type { ImpactLlmRuntime } from "../lib/impact-analysis/impact-llm-runtime.js";

const tokenRows: Array<Record<string, unknown>> = [];
const prismaMock = {
  aISession: { create: vi.fn(async () => ({ id: "sess-doc-1" })) },
  aITokenUsage: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      tokenRows.push(data);
      return data;
    }),
  },
};
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

let providerFactory: () => AIProvider | null = () => null;
vi.mock("../lib/ai/index.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/ai/index.js")>("../lib/ai/index.js");
  return {
    ...actual,
    loadAIConfig: () => ({}) as never,
    buildProvider: () => providerFactory(),
  };
});

const { impactRunDeps, documentReaderDep } = await import("./impact-analysis.js");
const { executeImpactAnalysis, InMemoryCodeGraphDataSource } =
  await import("../lib/impact-analysis/impact-analysis-engine.js");
const { __resetTokenTrackerSingleton, getTokenTracker } =
  await import("../lib/ai/token-tracker.js");

const FRD = [
  "# Clinic booking FRD",
  "",
  "## 1 Purpose",
  "",
  "This portal lets a patient book an appointment without calling the clinic.",
  "",
  "## 2 Access",
  "",
  "The portal shall lock an account after five failed attempts.",
  "",
  "## 3 Booking",
  "",
  "A patient shall hold at most two future appointments at any time.",
].join("\n");

/** A provider that reads {@link FRD} as the reader asks: its statements, then the merge pass. */
function readerProvider(): AIProvider {
  return {
    key: "anthropic",
    model: "claude-sonnet-5",
    offline: false,
    async chat(_messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      const system = opts?.systemMessage ?? "";
      const content = system.includes("combining the statements")
        ? JSON.stringify({ duplicates: [], crossReferences: [] })
        : JSON.stringify({
            statements: [
              {
                section: "S2",
                kind: "background",
                statement: "Patients book without calling.",
                quote: "This portal lets a patient book an appointment without calling the clinic.",
              },
              {
                section: "S3",
                kind: "requirement",
                statement: "Lock an account after five failed sign-in attempts.",
                quote: "The portal shall lock an account after five failed attempts.",
              },
              {
                section: "S4",
                kind: "business-rule",
                statement: "A patient holds at most two future appointments.",
                quote: "A patient shall hold at most two future appointments at any time.",
              },
            ],
          });
      return {
        content,
        usage: { promptTokens: 1500, completionTokens: 200, totalTokens: 1700 },
        model: "claude-sonnet-5",
        provider: "anthropic",
      };
    },
    async *stream() {},
    embed: async () => ({ vectors: [], model: "e", dimensions: 0 }),
    models: async () => [],
    ping: async () => true,
  } as unknown as AIProvider;
}

function servicePrismaMock() {
  const analyses = new Map<string, Record<string, unknown>>([
    ["ia-doc", { id: "ia-doc", sourceText: null, documentId: "doc-1" }],
  ]);
  const items: Array<Record<string, unknown>> = [];
  return {
    analyses,
    items,
    prisma: {
      impactAnalysis: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => analyses.get(where.id)),
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
      impactAffectedSymbol: { createMany: vi.fn(async () => ({ count: 1 })) },
      impactAffectedTable: { createMany: vi.fn(async () => ({ count: 0 })) },
      document: {
        findUnique: vi.fn(async () => ({
          filename: "frd.md",
          title: "Clinic booking FRD",
          mimeType: "text/markdown",
          storagePath: "docs/frd.md",
        })),
      },
      knowledgeChunk: { findMany: vi.fn(async () => []) },
      quarantineChunk: { findMany: vi.fn(async () => []) },
      codeSymbol: {},
      codeEdge: {},
    },
  };
}

const RUN_DEPS = {
  mapRequirement: async () => [
    {
      codeSymbolId: "A",
      filePath: "auth.ts",
      qualifiedName: "auth.lockAccount",
      startLine: 1,
      endLine: 9,
      confidence: 0.9,
    },
  ],
  dataSourceFor: () =>
    new InMemoryCodeGraphDataSource(
      [
        {
          id: "A",
          qualifiedName: "auth.lockAccount",
          kind: "function",
          filePath: "auth.ts",
          language: "ts",
          startLine: 1,
          endLine: 9,
        },
      ],
      [],
    ),
  includeSchemaImpact: false,
  documentStorage: { read: async () => Buffer.from(FRD, "utf8") },
};

async function flushTokenWrites(): Promise<void> {
  for (let i = 0; i < 50 && getTokenTracker().inFlight > 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  tokenRows.length = 0;
  __resetTokenTrackerSingleton();
  providerFactory = () => readerProvider();
  for (const flag of [
    "IMPACT_LLM_TABLE_FILTER",
    "IMPACT_LLM_ADDITIVE_DDL",
    "IMPACT_LLM_CLAUSE_RECONCILE",
    "IMPACT_LLM_SUMMARY",
    "IMPACT_LLM_ENTITY_SEEDS",
    "IMPACT_LLM_SEEDING",
    "IMPACT_LLM_TABLE_JUDGE",
    "IMPACT_LLM_EDIT_VERIFY",
    "IMPACT_LLM_EDIT_RERANK",
  ]) {
    vi.stubEnv(flag, "0");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#2231 — the route wires the document reader into an impact run", () => {
  it("is off by default: no reader, and the document is split heuristically", () => {
    vi.stubEnv("ANALYSIS_DOCUMENT_READER", "false");
    expect(impactRunDeps("user-1", ["proj-1"]).documentReader).toBeUndefined();
  });

  it("with the flag on, the model reads the document: one change per requirement, metered as its own stage", async () => {
    vi.stubEnv("ANALYSIS_DOCUMENT_READER", "true");
    const deps = impactRunDeps("user-1", ["proj-1"]);
    expect(deps.documentReader).toBeTypeOf("function");
    const { prisma, analyses, items } = servicePrismaMock();

    await executeImpactAnalysis("ia-doc", ["proj-1"], {
      ...deps,
      ...RUN_DEPS,
      prisma: prisma as never,
    });
    await flushTokenWrites();

    expect(analyses.get("ia-doc")?.status).toBe("completed");
    expect(items.map((i) => i.requirementTitle)).toEqual([
      "Lock an account after five failed sign-in attempts.",
      "A patient holds at most two future appointments.",
    ]);
    expect(String(analyses.get("ia-doc")?.summary)).toContain(
      "The model read the document (4 sections) and found 1 requirement, 1 business rule; each is analysed as one change.",
    );
    expect(tokenRows.length).toBeGreaterThan(0);
    for (const row of tokenRows) {
      expect(row.agentStep).toBe("impact.document-read");
      expect(row.projectId).toBe("proj-1");
      expect(row.userId).toBe("user-1");
    }
  });

  it("with the flag on and no provider, the run splits the document and names what did not run", async () => {
    vi.stubEnv("ANALYSIS_DOCUMENT_READER", "true");
    providerFactory = () => null;
    const deps = impactRunDeps("user-1", ["proj-1"]);
    expect(deps.documentReader).toBeUndefined();
    const { prisma, analyses, items } = servicePrismaMock();

    await executeImpactAnalysis("ia-doc", ["proj-1"], {
      ...deps,
      ...RUN_DEPS,
      prisma: prisma as never,
    });

    expect(analyses.get("ia-doc")?.status).toBe("completed");
    expect(items.length).toBeGreaterThan(0);
    const summary = String(analyses.get("ia-doc")?.summary);
    expect(summary).toContain(
      "AI enrichment did not run for this analysis (no AI provider is configured).",
    );
    expect(summary).toContain("Not applied: document reading.");
  });
});

describe("documentReaderDep", () => {
  function fakeRuntime() {
    return {
      instrument: vi.fn((p: AIProvider) => p),
      markUnavailable: vi.fn(),
    } as unknown as ImpactLlmRuntime & {
      instrument: ReturnType<typeof vi.fn>;
      markUnavailable: ReturnType<typeof vi.fn>;
    };
  }

  it("builds nothing when the flag is off", () => {
    const runtime = fakeRuntime();
    const build = vi.fn();
    expect(documentReaderDep(runtime, () => false, build)).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
    expect(runtime.markUnavailable).not.toHaveBeenCalled();
  });

  it("records the stage unavailable, with the reason, when no provider can be built", () => {
    const runtime = fakeRuntime();
    expect(
      documentReaderDep(
        runtime,
        () => true,
        () => ({ provider: null, reason: "provider-offline" }),
      ),
    ).toBeUndefined();
    expect(runtime.markUnavailable).toHaveBeenCalledWith("document-read", "provider-offline");
  });

  it("reads through the provider instrumented for the document-read stage", async () => {
    const runtime = fakeRuntime();
    const provider = readerProvider();
    const reader = documentReaderDep(
      runtime,
      () => true,
      () => ({ provider }),
    );
    expect(runtime.instrument).toHaveBeenCalledWith(provider, "document-read");
    const reading = await reader!({ title: "Clinic booking FRD", text: FRD });
    expect(reading.statements.map((s) => s.kind)).toEqual([
      "background",
      "requirement",
      "business-rule",
    ]);
  });
});
