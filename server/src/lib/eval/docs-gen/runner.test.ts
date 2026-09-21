import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EMBED_MODEL } from "@metis/shared";
import type { AIProvider, ChatChunk } from "../../ai/types.js";
import type { synthesizeHolisticDocument as SynthesizeHolisticDocument } from "../../docs-gen/holistic-synthesizer.js";
import { DOCS_GEN_BENCHMARK_FIXTURES } from "./fixtures.js";

const synthesizeHolisticDocument = vi.fn();
const buildTypedSymbolEvidenceRetriever = vi.fn();
const buildProvider = vi.fn();
const loadAIConfig = vi.fn(() => ({ provider: "anthropic", model: "claude-sonnet" }));
const runAnswerCorrectness = vi.fn();
const tokenUsageFindMany = vi.fn();

vi.mock("../../ai/index.js", () => ({
  buildProvider,
  loadAIConfig,
}));

vi.mock("../../finops/index.js", () => ({ recordUsage: vi.fn() }));

vi.mock("../../docs-gen/holistic-synthesizer.js", () => ({
  buildDocsGenProvider: vi.fn(),
  synthesizeHolisticDocument,
}));

vi.mock("../../docs-gen/grounding/typed-symbol-evidence.js", () => ({
  buildTypedSymbolEvidenceRetriever,
  resolveTypedSymbolEvidenceConfig: vi.fn((input?: Record<string, number | boolean>) => ({
    enabled: Boolean(input?.enabled),
    maxSymbols: typeof input?.maxSymbols === "number" ? input.maxSymbols : 6,
    neighborDepth: typeof input?.neighborDepth === "number" ? input.neighborDepth : 1,
    maxNeighbors: typeof input?.maxNeighbors === "number" ? input.maxNeighbors : 6,
    maxSourceLines: typeof input?.maxSourceLines === "number" ? input.maxSourceLines : 80,
    contextBefore: typeof input?.contextBefore === "number" ? input.contextBefore : 2,
    contextAfter: typeof input?.contextAfter === "number" ? input.contextAfter : 2,
  })),
}));

vi.mock("../../docs-gen/grounding/grounding-retrieval.js", () => ({
  buildProjectGroundingContext: vi.fn(async () => ({
    sources: [{ sourceId: "rag:doc:chunk", kind: "rag", label: "fixture", text: "fixture text" }],
    sourceIds: new Set(["rag:doc:chunk"]),
    isEmpty: false,
  })),
  buildSectionGroundingRetriever: vi.fn(() => async () => ({
    sources: [{ sourceId: "rag:doc:chunk", kind: "rag", label: "fixture", text: "fixture text" }],
    sourceIds: new Set(["rag:doc:chunk"]),
    isEmpty: false,
  })),
}));

vi.mock("../../rag/knowledge-service.js", () => ({
  __resetKnowledgeServiceSingleton: vi.fn(),
}));

vi.mock("../../rag/embedder.js", () => ({
  Embedder: class MockEmbedder {
    model = "offline-embedder";

    async warm(): Promise<void> {
      return undefined;
    }
  },
}));

vi.mock("../../connectors/connector-ingest.js", () => ({
  ingestSourceAsKnowledge: vi.fn().mockResolvedValue({
    documentsCreated: 1,
    documentsUpdated: 0,
    chunkCount: 2,
    failures: 0,
  }),
}));

vi.mock("../../prisma.js", () => ({
  prisma: {
    user: { create: vi.fn().mockResolvedValue(undefined) },
    project: { create: vi.fn().mockResolvedValue(undefined) },
    repoConnection: { create: vi.fn().mockResolvedValue(undefined) },
    codeGraph: { create: vi.fn().mockResolvedValue(undefined) },
    codeSymbol: { create: vi.fn().mockResolvedValue(undefined) },
    codeEdge: { create: vi.fn().mockResolvedValue(undefined) },
    generatedDocument: { create: vi.fn().mockResolvedValue(undefined) },
    tokenUsage: { findMany: tokenUsageFindMany },
  },
}));

vi.mock("../answer-correctness/runner.js", () => ({
  runAnswerCorrectness,
}));

vi.mock("../answer-correctness/judge-deps.js", () => ({
  resolveJudgeDeps: vi.fn(() => ({ deps: {}, unavailableReason: null })),
}));

describe("runDocsGenBenchmark", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    synthesizeHolisticDocument.mockResolvedValue({
      markdown:
        "This benchmark document is generated from the seeded fixture repositories. It reports repository structure, key modules, and integration boundaries observed in the fixture. The document is grounded in repository-source chunks ingested into the knowledge service.",
      sectionSupport: [{ supportedClaims: 3, totalClaims: 4 }],
    });
    runAnswerCorrectness.mockResolvedValue({
      corpusId: "docsgen-01-single-repo",
      reported: true,
      aggregate: {
        meanRecall: 0.75,
        meanPrecision: 0.8,
        meanF1: 0.77,
        meanAnswerClaims: 2,
        meanReferenceClaims: 2,
        scored: 1,
        unverifiable: 0,
      },
    });
    tokenUsageFindMany.mockResolvedValue([]);
    buildProvider.mockReturnValue({
      key: "anthropic",
      model: "claude-sonnet",
      offline: false,
      chat: vi.fn(),
      stream: vi.fn(),
      embed: vi.fn(),
      models: vi.fn(),
      ping: vi.fn(),
    });
    buildTypedSymbolEvidenceRetriever.mockImplementation(({ baseRetriever }) => ({
      groundingForSection: baseRetriever,
      report: {
        enabled: true,
        sectionsAttempted: 2,
        sectionsAugmented: 2,
        symbolsHydrated: 3,
        neighborSymbolsHydrated: 1,
        budgetExhausted: false,
      },
    }));
  });

  afterEach(() => {
    delete process.env.REPO_CLONE_DIR;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_OFFLINE;
    delete process.env.AI_REPLAY;
    delete process.env.AI_FIXTURE_DIR;
    delete process.env.EMBED_BACKEND;
    delete process.env.EMBED_ALLOW_HASH_FALLBACK;
  });

  it("reports deterministic offline runs honestly when token accounting is unavailable", async () => {
    const { runDocsGenBenchmark } = await import("./runner.js");
    const result = await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/docsgen-01-single-repo",
      publicationDisposition: "pending-1308",
      calibrationSource: "human-authored synthetic reference answers",
    });

    expect(result.fixture.mode).toBe("single-repo");
    expect(result.fixture.repositoryCount).toBe(1);
    expect(result.fixture.sourceRevisions).toEqual([
      { repoId: "orders-service", commit: "1111111111111111111111111111111111111111" },
    ]);
    expect(result.effectiveConfig.liveModelRun).toBe(false);
    expect(result.references.publicationDisposition).toBe("pending-1308");
    expect(result.experiment?.typedSymbolEvidence).toEqual({
      enabled: false,
      status: "disabled",
      config: {
        enabled: false,
        maxSymbols: 6,
        neighborDepth: 1,
        maxNeighbors: 6,
        maxSourceLines: 80,
        contextBefore: 2,
        contextAfter: 2,
      },
      decision: {
        outcome: "not-run",
        exploratory: true,
        rationale: "typed symbol evidence remained disabled for this benchmark run",
      },
    });
    expect(result.measurements.tokenCost).toEqual({
      reported: false,
      reason:
        "live token/cost accounting is disabled for deterministic offline or replay benchmark runs",
    });
    expect(result.measurements.supportedClaimRate).toMatchObject({
      reported: true,
      supportedClaims: 3,
      totalClaims: 4,
      rate: 0.75,
    });
    expect(result.measurements.missedExpectedBehavior).toMatchObject({
      reported: true,
      exploratory: true,
      corpusId: "docsgen-01-single-repo",
      missedRate: 0.25,
    });
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it("uses the configured live provider path when a live run is requested", async () => {
    tokenUsageFindMany.mockResolvedValue([
      {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costCents: 25,
      },
    ]);
    runAnswerCorrectness.mockResolvedValue({
      corpusId: "docsgen-02-multi-repo",
      reported: true,
      aggregate: {
        meanRecall: 1,
        meanPrecision: 1,
        meanF1: 1,
        meanAnswerClaims: 2,
        meanReferenceClaims: 2,
        scored: 1,
        unverifiable: 0,
      },
    });

    const { runDocsGenBenchmark } = await import("./runner.js");
    const result = await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-02-multi-repo"],
      corpusDir: "/tmp/docsgen-02-multi-repo",
      publicationDisposition: "pending-1308",
      calibrationSource: "human-authored synthetic reference answers",
      liveModelRun: true,
    });

    expect(buildProvider).toHaveBeenCalledTimes(1);
    expect(result.fixture.mode).toBe("multi-repo");
    expect(result.fixture.repositoryCount).toBe(2);
    expect(result.effectiveConfig.aiProvider).toBe("anthropic");
    expect(result.effectiveConfig.liveModelRun).toBe(true);
    expect(result.measurements.tokenCost).toMatchObject({
      reported: true,
      promptTokens: 120,
      completionTokens: 30,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 165,
      estimatedCostUsd: 0.25,
    });
    expect(result.measurements.missedExpectedBehavior).toMatchObject({
      reported: true,
      exploratory: true,
      missedRate: 0,
    });
  });

  it("records an explicit exploratory keep-disabled decision when typed symbol evidence is compared offline", async () => {
    synthesizeHolisticDocument
      .mockResolvedValueOnce({
        markdown: "baseline cold",
        sectionSupport: [{ supportedClaims: 3, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "baseline warm",
        sectionSupport: [{ supportedClaims: 3, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "candidate cold",
        sectionSupport: [{ supportedClaims: 4, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "candidate warm",
        sectionSupport: [{ supportedClaims: 4, totalClaims: 4 }],
      });
    runAnswerCorrectness
      .mockResolvedValueOnce({
        corpusId: "docsgen-01-single-repo",
        reported: true,
        aggregate: {
          meanRecall: 0.75,
          meanPrecision: 0.8,
          meanF1: 0.77,
          meanAnswerClaims: 2,
          meanReferenceClaims: 2,
          scored: 1,
          unverifiable: 0,
        },
      })
      .mockResolvedValueOnce({
        corpusId: "docsgen-01-single-repo",
        reported: true,
        aggregate: {
          meanRecall: 1,
          meanPrecision: 0.8,
          meanF1: 0.88,
          meanAnswerClaims: 2,
          meanReferenceClaims: 2,
          scored: 1,
          unverifiable: 0,
        },
      });

    const { runDocsGenBenchmark } = await import("./runner.js");
    const result = await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/docsgen-01-single-repo",
      publicationDisposition: "pending-1308",
      calibrationSource: "human-authored synthetic reference answers",
      typedSymbolEvidence: { enabled: true, maxSymbols: 4, maxNeighbors: 2, maxSourceLines: 40 },
    });

    expect(synthesizeHolisticDocument).toHaveBeenCalledTimes(4);
    expect(buildTypedSymbolEvidenceRetriever).toHaveBeenCalledTimes(1);
    expect(result.experiment?.typedSymbolEvidence).toMatchObject({
      enabled: true,
      status: "compared",
      config: {
        enabled: true,
        maxSymbols: 4,
        neighborDepth: 1,
        maxNeighbors: 2,
        maxSourceLines: 40,
        contextBefore: 2,
        contextAfter: 2,
      },
      report: {
        enabled: true,
        sectionsAttempted: 2,
        sectionsAugmented: 2,
        symbolsHydrated: 3,
      },
      decision: {
        outcome: "keep-disabled",
        exploratory: true,
      },
      comparison: {
        baseline: {
          supportedClaimRate: { reported: true, rate: 0.75 },
          missedExpectedBehavior: { reported: true, missedRate: 0.25 },
        },
        candidate: {
          supportedClaimRate: { reported: true, rate: 1 },
          missedExpectedBehavior: { reported: true, missedRate: 0 },
        },
        deltas: {
          supportedClaimRate: 0.25,
          missedExpectedBehavior: -0.25,
        },
      },
    });
    expect(result.experiment?.typedSymbolEvidence?.decision.rationale).toMatch(
      /deterministic|offline|exploratory/i,
    );
  });

  it("reports unavailable claim support when the synthesizer emits no section support samples", async () => {
    synthesizeHolisticDocument.mockResolvedValueOnce({ markdown: "generated" });
    synthesizeHolisticDocument.mockResolvedValueOnce({ markdown: "generated" });

    const { runDocsGenBenchmark } = await import("./runner.js");
    const result = await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/docsgen-01-single-repo",
      publicationDisposition: "local-only",
      calibrationSource: "synthetic reference answers",
      fixtureDir: "/tmp/replay-fixtures",
    });

    expect(result.measurements.supportedClaimRate).toEqual({
      reported: false,
      reason: "no verified section-level claim support scores were recorded for this run",
    });
    expect(result.references.publicationDisposition).toBe("local-only");
  });

  it("marks live token cost unavailable when no TokenUsage rows were written", async () => {
    const { runDocsGenBenchmark } = await import("./runner.js");
    const result = await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-02-multi-repo"],
      corpusDir: "/tmp/docsgen-02-multi-repo",
      publicationDisposition: "pending-1308",
      calibrationSource: "synthetic reference answers",
      liveModelRun: true,
    });

    expect(result.measurements.tokenCost).toEqual({
      reported: false,
      reason: "no TokenUsage rows were written for this run",
    });
  });

  it("records a safe fallback experiment result when typed symbol evidence falls back to baseline", async () => {
    buildTypedSymbolEvidenceRetriever.mockImplementationOnce(({ baseRetriever }) => ({
      groundingForSection: baseRetriever,
      report: {
        enabled: true,
        sectionsAttempted: 0,
        sectionsAugmented: 0,
        symbolsHydrated: 0,
        neighborSymbolsHydrated: 0,
        budgetExhausted: false,
        fallbackReason: "Repository source path unavailable",
      },
    }));

    const { runDocsGenBenchmark } = await import("./runner.js");
    const result = await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/docsgen-01-single-repo",
      publicationDisposition: "pending-1308",
      calibrationSource: "human-authored synthetic reference answers",
      liveModelRun: true,
      typedSymbolEvidence: { enabled: true },
    });

    expect(result.experiment?.typedSymbolEvidence).toMatchObject({
      enabled: true,
      status: "safe-fallback",
      decision: {
        outcome: "insufficient-evidence",
        exploratory: true,
      },
    });
    expect(result.experiment?.typedSymbolEvidence?.decision.rationale).toMatch(/fell back safely/i);
  });

  it("keeps uncalibrated live comparisons exploratory when the candidate does not improve", async () => {
    synthesizeHolisticDocument
      .mockResolvedValueOnce({
        markdown: "baseline cold",
        sectionSupport: [{ supportedClaims: 4, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "baseline warm",
        sectionSupport: [{ supportedClaims: 4, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "candidate cold",
        sectionSupport: [{ supportedClaims: 4, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "candidate warm",
        sectionSupport: [{ supportedClaims: 4, totalClaims: 4 }],
      });
    runAnswerCorrectness
      .mockResolvedValueOnce({
        corpusId: "docsgen-01-single-repo",
        reported: true,
        aggregate: {
          meanRecall: 1,
          meanPrecision: 1,
          meanF1: 1,
          meanAnswerClaims: 2,
          meanReferenceClaims: 2,
          scored: 1,
          unverifiable: 0,
        },
      })
      .mockResolvedValueOnce({
        corpusId: "docsgen-01-single-repo",
        reported: true,
        aggregate: {
          meanRecall: 1,
          meanPrecision: 1,
          meanF1: 1,
          meanAnswerClaims: 2,
          meanReferenceClaims: 2,
          scored: 1,
          unverifiable: 0,
        },
      });

    const { runDocsGenBenchmark } = await import("./runner.js");
    const result = await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/docsgen-01-single-repo",
      publicationDisposition: "pending-1308",
      calibrationSource: "human-authored synthetic reference answers",
      liveModelRun: true,
      typedSymbolEvidence: { enabled: true },
    });

    expect(result.experiment?.typedSymbolEvidence?.decision).toMatchObject({
      outcome: "keep-disabled",
      exploratory: true,
    });
  });

  it("does not promote uncalibrated live gains based on a calibrationSource description", async () => {
    synthesizeHolisticDocument
      .mockResolvedValueOnce({
        markdown: "baseline cold",
        sectionSupport: [{ supportedClaims: 2, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "baseline warm",
        sectionSupport: [{ supportedClaims: 2, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "candidate cold",
        sectionSupport: [{ supportedClaims: 4, totalClaims: 4 }],
      })
      .mockResolvedValueOnce({
        markdown: "candidate warm",
        sectionSupport: [{ supportedClaims: 4, totalClaims: 4 }],
      });
    runAnswerCorrectness
      .mockResolvedValueOnce({
        corpusId: "docsgen-01-single-repo",
        reported: true,
        aggregate: {
          meanRecall: 0.5,
          meanPrecision: 0.8,
          meanF1: 0.61,
          meanAnswerClaims: 2,
          meanReferenceClaims: 2,
          scored: 1,
          unverifiable: 0,
        },
      })
      .mockResolvedValueOnce({
        corpusId: "docsgen-01-single-repo",
        reported: true,
        aggregate: {
          meanRecall: 1,
          meanPrecision: 0.8,
          meanF1: 0.88,
          meanAnswerClaims: 2,
          meanReferenceClaims: 2,
          scored: 1,
          unverifiable: 0,
        },
      });

    const { runDocsGenBenchmark } = await import("./runner.js");
    const result = await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/docsgen-01-single-repo",
      publicationDisposition: "pending-1308",
      calibrationSource: "human-authored synthetic reference answers",
      liveModelRun: true,
      typedSymbolEvidence: { enabled: true },
    });

    expect(result.experiment?.typedSymbolEvidence?.decision).toMatchObject({
      outcome: "keep-disabled",
      exploratory: true,
    });
    expect(result.experiment?.typedSymbolEvidence?.decision.rationale).toMatch(/calibration/i);
    expect(result.experiment?.typedSymbolEvidence?.comparison).toMatchObject({
      baseline: { missedExpectedBehavior: { exploratory: true } },
      candidate: { missedExpectedBehavior: { exploratory: true } },
      deltas: { supportedClaimRate: 0.5, missedExpectedBehavior: -0.5 },
    });
  });

  it("consumes warm candidate evidence in the actual synthesis prompt and judged answer", async () => {
    const { synthesizeFinalDocument, sectionGroupsFor } = await vi.importActual<
      typeof import("../../docs-gen/holistic-synthesizer.js")
    >("../../docs-gen/holistic-synthesizer.js");
    const evidence = "TypedEvidenceSentinel: orders expire after exactly 37 minutes.";
    const promptsByPass: string[][] = [[], [], [], []];
    let pass = -1;
    const provider: AIProvider = {
      key: "anthropic",
      model: "prompt-positive-control",
      offline: false,
      // Grounding validation is not the subject of this control. No fabricated
      // support score: the real validator treats empty claims as unverifiable.
      chat: vi.fn().mockResolvedValue({ content: '{"claims":[]}' }),
      async *stream(messages): AsyncGenerator<ChatChunk> {
        const prompt = messages
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
          )
          .join("\n");
        promptsByPass[pass].push(prompt);
        const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)?.[1];
        yield {
          type: "delta",
          content: `## ${label}\n\n${prompt.includes(evidence) ? evidence : "No typed evidence supplied."}`,
        };
        yield { type: "done", finishReason: "stop" };
      },
      embed: vi.fn(),
      models: vi.fn(),
      ping: vi.fn(),
    };
    buildProvider.mockReturnValueOnce(provider);
    // Replace only repository/fact loading. Section retrieval, prompt construction,
    // provider streaming, and final markdown assembly are production code.
    synthesizeHolisticDocument
      .mockImplementationOnce(runSynthesis)
      .mockImplementationOnce(runSynthesis)
      .mockImplementationOnce(runSynthesis)
      .mockImplementationOnce(runSynthesis);
    async function runSynthesis(
      ...[projectId, docType, title, options]: Parameters<typeof SynthesizeHolisticDocument>
    ) {
      pass++;
      return synthesizeFinalDocument(
        [
          {
            modulePath: "src/orders",
            moduleName: "orders",
            classCount: 1,
            methodCount: 1,
            facts: "Order processing.",
            formulas: [],
            topClasses: ["Order"],
          },
        ],
        { name: "Project", language: "typescript", totalFiles: 1, totalSymbols: 1 },
        docType,
        title,
        options!.benchmarkProviders!.phase2Router!,
        projectId,
        options?.grounding,
        undefined,
        options?.groundingForSection,
      );
    }
    buildTypedSymbolEvidenceRetriever.mockImplementationOnce(() => ({
      groundingForSection: vi.fn(async () => ({
        sources: [
          {
            sourceId: "facts:symbol:1",
            kind: "facts",
            label: "typed evidence",
            text: evidence,
          },
        ],
        sourceIds: new Set(["facts:symbol:1"]),
        isEmpty: false,
      })),
      report: {
        enabled: true,
        sectionsAttempted: 2,
        sectionsAugmented: 2,
        symbolsHydrated: 1,
        neighborSymbolsHydrated: 0,
        budgetExhausted: false,
      },
    }));

    const { runDocsGenBenchmark } = await import("./runner.js");
    await runDocsGenBenchmark({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/docsgen-01-single-repo",
      publicationDisposition: "pending-1308",
      calibrationSource: "human-authored synthetic reference answers",
      liveModelRun: true,
      typedSymbolEvidence: { enabled: true },
    });

    const sectionCount = sectionGroupsFor(
      DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"].docType,
    ).length;
    for (const prompts of promptsByPass) expect(prompts).toHaveLength(sectionCount);
    expect(
      promptsByPass[0].concat(promptsByPass[1]).every((prompt) => !prompt.includes(evidence)),
    ).toBe(true);
    // Assert warm separately: cold evidence cannot mask a disconnected warm callback.
    expect(promptsByPass[2].every((prompt) => prompt.includes(evidence))).toBe(true);
    expect(promptsByPass[3].every((prompt) => prompt.includes(evidence))).toBe(true);
    expect(runAnswerCorrectness).toHaveBeenCalledTimes(2);
    expect(runAnswerCorrectness.mock.calls[0][0].generated[0].answer).not.toContain(evidence);
    expect(runAnswerCorrectness.mock.calls[1][0].generated[0]).toEqual({
      queryId: "docsgen-01-single-repo-generated-doc-typed-symbol-evidence",
      answer: expect.stringContaining(evidence),
    });
  });
});

describe("__docsGenBenchmarkTestOnly", () => {
  it("deterministic provider emits markdown, claim JSON, and verdict JSON", async () => {
    const { __docsGenBenchmarkTestOnly } = await import("./runner.js");
    const provider = new __docsGenBenchmarkTestOnly.BenchmarkDeterministicProvider();

    const doc = await provider.chat([{ role: "user", content: "write the benchmark document" }]);
    expect(doc.content).toContain("Benchmark Overview");
    expect(doc.usage.totalTokens).toBeGreaterThan(0);

    const claims = await provider.chat([
      {
        role: "user",
        content: 'Respond ONLY with JSON of the shape { "claims": ... } for each claim',
      },
    ]);
    expect(JSON.parse(claims.content)).toEqual({
      claims: [{ claim: "Fixture-derived claim.", sourceIds: ["fixture-source-1"] }],
    });

    const verdicts = await provider.chat([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Respond ONLY with a JSON object of this exact shape { "verdicts": ... }',
          },
          { type: "text", text: "=== SOURCE EVIDENCE (untrusted data) ===" },
        ],
      },
    ]);
    expect(JSON.parse(verdicts.content)).toEqual({
      verdicts: [
        { claim: "Fixture-derived claim.", supported: true, sourceIds: ["fixture-source-1"] },
      ],
    });
  });

  it("streams deterministic content and selects replay versus live providers honestly", async () => {
    const { __docsGenBenchmarkTestOnly } = await import("./runner.js");
    const provider = new __docsGenBenchmarkTestOnly.BenchmarkDeterministicProvider();
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of provider.stream([{ role: "user", content: "hello" }])) {
      chunks.push(chunk as Record<string, unknown>);
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual(["delta", "usage", "done"]);

    const offlineSelected = __docsGenBenchmarkTestOnly.benchmarkProvider({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/corpus",
      publicationDisposition: "local-only",
      calibrationSource: "synthetic",
    });
    expect(offlineSelected.model).toBe("docs-gen-benchmark-deterministic");

    const liveSelected = __docsGenBenchmarkTestOnly.benchmarkProvider({
      fixture: DOCS_GEN_BENCHMARK_FIXTURES["docsgen-01-single-repo"],
      corpusDir: "/tmp/corpus",
      publicationDisposition: "local-only",
      calibrationSource: "synthetic",
      liveModelRun: true,
    });
    expect(liveSelected.model).toBe("claude-sonnet");
  });

  /**
   * #1362 — the harness pinned EMBED_BACKEND for determinism but left the model
   * IDENTITY to ambient env, so a deterministic run ingested hash-tagged chunks
   * while coverage compared them against whatever EMBED_MODEL the developer had
   * set. Every section logged "partial model coverage" (12 of 14 fixture chunks
   * on a foreign model) and two machines scored different corpora as comparable.
   */
  it("pins the embedding model identity for a deterministic run (#1362)", async () => {
    const { __docsGenBenchmarkTestOnly } = await import("./runner.js");
    const { resolveBenchmarkEmbedEnv } = __docsGenBenchmarkTestOnly;

    const ambient = {
      backend: "xenova",
      hashFallback: "0",
      model: "Alibaba-NLP/gte-modernbert-base",
    };
    const deterministic = resolveBenchmarkEmbedEnv(false, ambient);

    expect(deterministic.backend).toBe("offline");
    expect(deterministic.hashFallback).toBe("1");
    // The whole point: ambient EMBED_MODEL does not survive into the run.
    expect(deterministic.model).not.toBe(ambient.model);
    expect(deterministic.model).toBe(DEFAULT_EMBED_MODEL);
  });

  it("gives the same deterministic identity whatever EMBED_MODEL is ambient (#1362)", async () => {
    const { __docsGenBenchmarkTestOnly } = await import("./runner.js");
    const { resolveBenchmarkEmbedEnv } = __docsGenBenchmarkTestOnly;

    const a = resolveBenchmarkEmbedEnv(false, { model: "model-a" });
    const b = resolveBenchmarkEmbedEnv(false, { model: "model-b" });
    const none = resolveBenchmarkEmbedEnv(false, {});

    expect(a).toEqual(b);
    expect(a).toEqual(none);
  });

  it("leaves a live run on its configured real model (#1362)", async () => {
    const { __docsGenBenchmarkTestOnly } = await import("./runner.js");
    const { resolveBenchmarkEmbedEnv } = __docsGenBenchmarkTestOnly;

    const live = resolveBenchmarkEmbedEnv(true, {
      backend: "xenova",
      hashFallback: "0",
      model: "Alibaba-NLP/gte-modernbert-base",
    });
    expect(live.backend).toBe("xenova");
    expect(live.hashFallback).toBe("0");
    expect(live.model).toBe("Alibaba-NLP/gte-modernbert-base");

    // A live run with nothing configured must not silently borrow the hash stub.
    expect(resolveBenchmarkEmbedEnv(true, {}).model).toBeUndefined();
    expect(resolveBenchmarkEmbedEnv(true, {}).hashFallback).toBe("0");
  });
});
