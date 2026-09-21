import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AIProvider,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  EmbedResult,
} from "../../ai/types.js";
import { ReplayProvider } from "../../ai/fixtures/replay-provider.js";
import { FixtureStore } from "../../ai/fixtures/fixture-store.js";
import { OfflineStubProvider } from "../../ai/providers/offline-stub-provider.js";
import { buildProvider, loadAIConfig } from "../../ai/index.js";
import {
  buildDocsGenProvider,
  synthesizeHolisticDocument,
  type DocType,
  type Phase2Router,
} from "../../docs-gen/holistic-synthesizer.js";
import type { EvidencePolicy } from "../../docs-gen/evidence-policy.js";
import {
  buildProjectGroundingContext,
  buildSectionGroundingRetriever,
  type SectionGroundingRetriever,
} from "../../docs-gen/grounding/grounding-retrieval.js";
import {
  buildTypedSymbolEvidenceRetriever,
  resolveTypedSymbolEvidenceConfig,
  type TypedSymbolEvidenceConfig,
} from "../../docs-gen/grounding/typed-symbol-evidence.js";
import { DEFAULT_EMBED_MODEL } from "@metis/shared";
import { __resetKnowledgeServiceSingleton } from "../../rag/knowledge-service.js";
import { Embedder } from "../../rag/embedder.js";
import { ingestSourceAsKnowledge } from "../../connectors/connector-ingest.js";
import { prisma } from "../../prisma.js";
import { runAnswerCorrectness } from "../answer-correctness/runner.js";
import { resolveJudgeDeps } from "../answer-correctness/judge-deps.js";
import {
  DOCS_GEN_BENCHMARK_HARNESS_VERSION,
  DOCS_GEN_BENCHMARK_SCHEMA_VERSION,
  measuredRetrievalLatency,
  measuredScalar,
  measuredTokenCost,
  summarizeMissedExpectedBehavior,
  summarizeSupportedClaimRate,
  validateDocsGenBenchmarkResult,
  type DocsGenBenchmarkResult,
} from "./metrics.js";

class BenchmarkDeterministicProvider implements AIProvider {
  readonly key = "offline-stub" as const;
  readonly model = "docs-gen-benchmark-deterministic";
  readonly offline = false;

  async chat(messages: ChatMessage[], _opts: ChatOptions = {}): Promise<ChatResponse> {
    const content = this.render(messages);
    const usage = this.usageOf(content);
    return {
      content,
      usage,
      model: this.model,
      provider: this.key,
      finishReason: "stop",
    };
  }

  async *stream(messages: ChatMessage[], _opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    const content = this.render(messages);
    yield { type: "delta", content };
    yield { type: "usage", usage: this.usageOf(content) };
    yield { type: "done", finishReason: "stop" };
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    return new OfflineStubProvider().embed(texts);
  }

  async models(): Promise<string[]> {
    return [this.model];
  }

  async ping(): Promise<boolean> {
    return true;
  }

  private render(messages: ChatMessage[]): string {
    const prompt = messages
      .map((msg) =>
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
      )
      .join("\n");
    const normalized = prompt.toLowerCase();
    if (
      normalized.includes("verdicts") ||
      (normalized.includes("supported") && normalized.includes("source evidence"))
    ) {
      return JSON.stringify({
        verdicts: [
          { claim: "Fixture-derived claim.", supported: true, sourceIds: ["fixture-source-1"] },
        ],
      });
    }
    if (normalized.includes("json") && normalized.includes("claim")) {
      return JSON.stringify({
        claims: [{ claim: "Fixture-derived claim.", sourceIds: ["fixture-source-1"] }],
      });
    }
    return [
      "# Benchmark Overview",
      "",
      "This benchmark document is generated from the seeded fixture repositories.",
      "It reports repository structure, key modules, and integration boundaries observed in the fixture.",
      "",
      "## Key Components",
      "- Service layer modules are present in the seeded repository content.",
      "- Integration boundaries are described from the retrieved fixture sources.",
      "",
      "## Retrieval Evidence",
      "- The document is grounded in repository-source chunks ingested into the knowledge service.",
    ].join("\n");
  }

  private usageOf(content: string) {
    const totalTokens = Math.max(1, Math.ceil(content.length / 4));
    return {
      promptTokens: Math.max(1, Math.ceil(totalTokens / 2)),
      completionTokens: Math.max(1, totalTokens - Math.ceil(totalTokens / 2)),
      totalTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
}

/**
 * #1362 — which embedding backend/model/fallback a benchmark run uses.
 *
 * A deterministic run must not read `EMBED_MODEL` from ambient environment. Pinning
 * only the BACKEND left the model IDENTITY floating, so the fixture corpus was
 * ingested by the offline hash embedder and tagged `metis-offline-hash-v1` while
 * coverage compared it against the developer's configured model — every section
 * logged "partial model coverage" and two machines produced results that looked
 * comparable and were not.
 *
 * `undefined` means "leave the variable as it was".
 */
export function resolveBenchmarkEmbedEnv(
  liveModelRun: boolean | undefined,
  previous: { backend?: string; hashFallback?: string; model?: string },
): { backend: string; hashFallback: string; model: string | undefined } {
  return liveModelRun
    ? {
        backend: previous.backend ?? "xenova",
        hashFallback: previous.hashFallback ?? "0",
        model: previous.model,
      }
    : { backend: "offline", hashFallback: "1", model: DEFAULT_EMBED_MODEL };
}

export const __docsGenBenchmarkTestOnly = {
  BenchmarkDeterministicProvider,
  benchmarkProvider,
  resolveBenchmarkEmbedEnv,
};

export interface DocsGenFixtureRepo {
  repoId: string;
  label: string;
  defaultBranch: string;
  commit: string;
  files: ReadonlyArray<{ path: string; content: string }>;
  symbols: ReadonlyArray<{
    kind: string;
    qualifiedName: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
  }>;
  edges?: ReadonlyArray<{
    kind: string;
    fromQualifiedName: string;
    toQualifiedName?: string;
    toExternalQualifiedName?: string;
    filePath: string;
    line: number;
  }>;
}

export interface DocsGenFixture {
  id: string;
  mode: "single-repo" | "multi-repo";
  title: string;
  docType: DocType;
  benchmarkReferenceCorpusId: string;
  repositories: ReadonlyArray<DocsGenFixtureRepo>;
}

export interface RunDocsGenBenchmarkOptions {
  fixture: DocsGenFixture;
  corpusDir: string;
  publicationDisposition: "local-only" | "pending-1308" | "public-approved";
  /** Descriptive provenance only; not validated judge calibration evidence. */
  calibrationSource: string;
  fixtureDir?: string;
  liveModelRun?: boolean;
  typedSymbolEvidence?: Partial<TypedSymbolEvidenceConfig>;
}

const BENCHMARK_AUTH_PAYLOAD = {
  userId: "docs-benchmark-user",
  username: "docs-benchmark-user",
  role: "admin",
  permissions: ["project.update"],
  workspaces: [],
} as const;

const ROUTE_COMPATIBLE_BOUNDARY =
  "grounding retrieval and synthesizeHolisticDocument output after fixture seeding";
const RETRIEVAL_BOUNDARY =
  "per-section grounding retrieval callback around KnowledgeService.search";
const TOKEN_BOUNDARY = "persisted TokenUsage rows written during this benchmark run";
const SUPPORT_BOUNDARY =
  "verified section-level faithfulness outcomes emitted by synthesizeHolisticDocument";

function fixtureProjectId(fixture: DocsGenFixture): string {
  return `docsgen-bench-${fixture.id}`;
}

function fixtureSlug(fixture: DocsGenFixture): string {
  return fixture.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function replayProviderForBenchmark(opts: RunDocsGenBenchmarkOptions): AIProvider {
  const fixtureDir = opts.fixtureDir;
  if (!fixtureDir) return new BenchmarkDeterministicProvider();
  return new ReplayProvider({
    store: new FixtureStore(fixtureDir),
    fallbackProvider: new BenchmarkDeterministicProvider(),
    key: "bedrock-gateway",
    model: "docs-gen-replay",
  });
}

function benchmarkProvider(opts: RunDocsGenBenchmarkOptions): AIProvider {
  if (opts.liveModelRun) {
    return buildProvider({ config: loadAIConfig() });
  }
  return replayProviderForBenchmark(opts);
}

function benchmarkProviders(provider: AIProvider): {
  phase1: ReturnType<typeof buildDocsGenProvider>;
  phase2Router: Phase2Router;
} {
  const phase1 = {
    provider,
    supportsCaching: false,
    factsCharCap: 150_000,
    tuning: {
      phase1Model: provider.model,
      phase2Model: provider.model,
      claimModel: provider.model,
      judgeModel: provider.model,
      factsCharCap: 150_000,
      supportsCaching: false,
      temperature: 0,
      disableThinking: false,
      refine: false,
      concisePrompt: false,
      structuredOutput: false,
    },
    effectiveConfigHash: createHash("sha256")
      .update(`benchmark:${provider.key}:${provider.model}`)
      .digest("hex"),
  } satisfies ReturnType<typeof buildDocsGenProvider>;
  return {
    phase1,
    phase2Router: {
      primary: {
        kind: provider.key === "local-gemma" ? "local" : "bedrock",
        provider,
        supportsCaching: false,
        factsCharCap: 150_000,
        tuning: phase1.tuning,
      },
      hybrid: null,
    },
  };
}

async function seedFixtureRepositories(root: string, fixture: DocsGenFixture): Promise<void> {
  for (const repo of fixture.repositories) {
    for (const rootName of [repo.repoId, `bench-repo-${repo.repoId}`]) {
      const repoRoot = path.join(root, rootName);
      await mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await writeFile(
        path.join(repoRoot, ".git", "HEAD"),
        `ref: refs/heads/${repo.defaultBranch}\n`,
      );
      for (const file of repo.files) {
        const abs = path.join(repoRoot, file.path);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, file.content);
      }
    }
  }
}

async function seedFixtureProject(
  fixture: DocsGenFixture,
): Promise<{ projectId: string; userId: string }> {
  const projectId = fixtureProjectId(fixture);
  const userId = `${projectId}-user`;
  await prisma.user.create({
    data: {
      id: userId,
      username: userId,
      displayName: "docs benchmark",
      email: `${userId}@eval.invalid`,
      status: "active",
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      name: fixture.title,
      slug: fixtureSlug(fixture),
      createdById: userId,
      autoApproveTrustedSources: true,
    },
  });
  return { projectId, userId };
}

async function seedGraphsAndSymbols(
  fixture: DocsGenFixture,
  projectId: string,
): Promise<
  Array<{ repoId: string; codeGraphId: string; repoConnectionId: string; commit: string }>
> {
  const graphRows: Array<{
    repoId: string;
    codeGraphId: string;
    repoConnectionId: string;
    commit: string;
  }> = [];
  for (const repo of fixture.repositories) {
    const repoConnectionId = `bench-repo-${repo.repoId}`;
    const codeGraphId = `bench-graph-${repo.repoId}`;
    await prisma.repoConnection.create({
      data: {
        id: repoConnectionId,
        projectId,
        label: repo.label,
        provider: "local",
        localPath: repo.repoId,
        defaultBranch: repo.defaultBranch,
        status: "connected",
        lastCommitSha: repo.commit,
      },
    });
    await prisma.codeGraph.create({
      data: {
        id: codeGraphId,
        projectId,
        repoConnectionId,
        commitSha: repo.commit,
      },
    });
    const symbolIdByQualifiedName = new Map<string, string>();
    for (const symbol of repo.symbols) {
      const id = `bench-symbol-${createHash("sha1").update(`${repo.repoId}:${symbol.qualifiedName}`).digest("hex").slice(0, 20)}`;
      symbolIdByQualifiedName.set(symbol.qualifiedName, id);
      const content =
        repo.files.find((file) => file.path === symbol.filePath)?.content ?? symbol.qualifiedName;
      await prisma.codeSymbol.create({
        data: {
          id,
          codeGraphId,
          projectId,
          kind: symbol.kind,
          name: symbol.qualifiedName.split(".").at(-1) ?? symbol.qualifiedName,
          qualifiedName: symbol.qualifiedName,
          filePath: symbol.filePath,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          language: symbol.language,
          contentHash: hashContent(content),
        },
      });
    }
    for (const edge of repo.edges ?? []) {
      await prisma.codeEdge.create({
        data: {
          id: `bench-edge-${randomUUID()}`,
          codeGraphId,
          projectId,
          kind: edge.kind,
          fromSymbolId: symbolIdByQualifiedName.get(edge.fromQualifiedName) ?? "",
          toSymbolId: edge.toQualifiedName
            ? (symbolIdByQualifiedName.get(edge.toQualifiedName) ?? null)
            : null,
          toQualifiedName: edge.toQualifiedName ?? edge.toExternalQualifiedName ?? null,
          filePath: edge.filePath,
          line: edge.line,
        },
      });
    }
    graphRows.push({ repoId: repo.repoId, codeGraphId, repoConnectionId, commit: repo.commit });
  }
  return graphRows;
}

async function ingestFixtureSources(
  cloneRoot: string,
  graphs: Array<{ repoId: string; repoConnectionId: string }>,
  projectId: string,
  actorId: string,
): Promise<void> {
  for (const graph of graphs) {
    await ingestSourceAsKnowledge(
      projectId,
      graph.repoConnectionId,
      actorId,
      path.join(cloneRoot, graph.repoId),
    );
  }
}

async function runGrounding(
  projectId: string,
  repoConnectionId: string | undefined,
  docId: string,
): Promise<{
  policy: EvidencePolicy;
  retrievalSamples: number[];
  grounding: Awaited<ReturnType<typeof buildProjectGroundingContext>>;
  groundingForSection: ReturnType<typeof buildSectionGroundingRetriever>;
}> {
  await prisma.generatedDocument.create({
    data: {
      id: docId,
      projectId,
      title: "Benchmark Document",
      scope: repoConnectionId ? "repository" : "full",
      scopeFilter: repoConnectionId ? JSON.stringify({ repoConnectorId: repoConnectionId }) : "{}",
      content: "",
      status: "pending",
      evidencePolicy: null,
    },
  });
  const retrievalSamples: number[] = [];
  const policy: EvidencePolicy = {
    projectId,
    generatedDocumentId: docId,
    actor: { userId: BENCHMARK_AUTH_PAYLOAD.userId, role: BENCHMARK_AUTH_PAYLOAD.role },
    aclSubjects: [],
    ...(repoConnectionId
      ? {
          repoConnectorId: repoConnectionId,
          codeGraphId: `bench-graph-${repoConnectionId.replace(/^bench-repo-/, "")}`,
        }
      : {}),
    sharedDocumentIds: [],
    allowWebResearch: false,
  };
  const grounding = await buildProjectGroundingContext({
    projectId,
    policy,
    query: "architecture generated documentation benchmark",
  });
  const baseRetriever = buildSectionGroundingRetriever({ projectId, policy });
  const groundingForSection = async (req: Parameters<typeof baseRetriever>[0]) => {
    const started = performance.now();
    const result = await baseRetriever(req);
    retrievalSamples.push(performance.now() - started);
    return result;
  };
  return { policy, retrievalSamples, grounding, groundingForSection };
}

async function tokenUsageTotals(projectId: string): Promise<{
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
} | null> {
  const rows = await prisma.tokenUsage.findMany({ where: { projectId } });
  if (rows.length === 0) return null;
  return rows.reduce(
    (acc, row) => ({
      promptTokens: acc.promptTokens + row.inputTokens,
      completionTokens: acc.completionTokens + row.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
      estimatedCostUsd: acc.estimatedCostUsd + row.costCents / 100,
    }),
    {
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
    },
  );
}

export async function runDocsGenBenchmark(
  opts: RunDocsGenBenchmarkOptions,
): Promise<DocsGenBenchmarkResult> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "docsgen-bench-"));
  const cloneRoot = path.join(tmpRoot, "repos");
  const previousCloneRoot = process.env.REPO_CLONE_DIR;
  const previousAiReplay = process.env.AI_REPLAY;
  const previousAiProvider = process.env.AI_PROVIDER;
  const previousAiOffline = process.env.AI_OFFLINE;
  const previousFixtureDir = process.env.AI_FIXTURE_DIR;
  const previousEmbedBackend = process.env.EMBED_BACKEND;
  const previousHashFallback = process.env.EMBED_ALLOW_HASH_FALLBACK;
  const previousEmbedModel = process.env.EMBED_MODEL;
  try {
    process.env.REPO_CLONE_DIR = cloneRoot;
    process.env.AI_PROVIDER = previousAiProvider ?? "offline-stub";
    process.env.AI_OFFLINE = opts.liveModelRun ? (previousAiOffline ?? "0") : "1";
    process.env.AI_REPLAY = "0";
    if (opts.fixtureDir) process.env.AI_FIXTURE_DIR = opts.fixtureDir;
    const embedEnv = resolveBenchmarkEmbedEnv(opts.liveModelRun, {
      backend: previousEmbedBackend,
      hashFallback: previousHashFallback,
      model: previousEmbedModel,
    });
    process.env.EMBED_BACKEND = embedEnv.backend;
    process.env.EMBED_ALLOW_HASH_FALLBACK = embedEnv.hashFallback;
    if (embedEnv.model !== undefined) process.env.EMBED_MODEL = embedEnv.model;
    __resetKnowledgeServiceSingleton();

    await seedFixtureRepositories(cloneRoot, opts.fixture);
    const { projectId, userId } = await seedFixtureProject(opts.fixture);
    const graphs = await seedGraphsAndSymbols(opts.fixture, projectId);
    await ingestFixtureSources(cloneRoot, graphs, projectId, userId);
    const primaryGraph = graphs[0];
    const docId = `docsgen-bench-doc-${randomUUID()}`;
    const { retrievalSamples, grounding, groundingForSection } = await runGrounding(
      projectId,
      opts.fixture.mode === "single-repo" ? primaryGraph?.repoConnectionId : undefined,
      docId,
    );
    const typedSymbolConfig = resolveTypedSymbolEvidenceConfig(opts.typedSymbolEvidence);
    const typedSymbolAdapter = typedSymbolConfig.enabled
      ? buildTypedSymbolEvidenceRetriever({
          projectId,
          policy: {
            projectId,
            generatedDocumentId: docId,
            actor: { userId: BENCHMARK_AUTH_PAYLOAD.userId, role: BENCHMARK_AUTH_PAYLOAD.role },
            aclSubjects: [],
            ...(opts.fixture.mode === "single-repo" && primaryGraph
              ? {
                  repoConnectorId: primaryGraph.repoConnectionId,
                  codeGraphId: primaryGraph.codeGraphId,
                }
              : {}),
            sharedDocumentIds: [],
            allowWebResearch: false,
          },
          baseRetriever: groundingForSection,
          config: typedSymbolConfig,
        })
      : null;

    const embedder = new Embedder();
    const ingestStart = performance.now();
    await embedder.warm();
    const coldIngestionMs = performance.now() - ingestStart;
    const warmIngestionStart = performance.now();
    await embedder.warm();
    const warmIngestionMs = performance.now() - warmIngestionStart;

    const startRss = process.memoryUsage().rss;
    const provider = benchmarkProvider(opts);
    const providers = benchmarkProviders(provider);
    const coldGenStart = performance.now();
    const coldResult = await synthesizeHolisticDocument(
      projectId,
      opts.fixture.docType,
      opts.fixture.title,
      {
        ...(opts.fixture.mode === "single-repo" && primaryGraph
          ? { repoConnectorId: primaryGraph.repoConnectionId }
          : {}),
        grounding,
        groundingForSection,
        benchmarkProviders: providers,
      },
    );
    const coldGenerationMs = performance.now() - coldGenStart;
    const warmGenStart = performance.now();
    const warmResult = await synthesizeHolisticDocument(
      projectId,
      opts.fixture.docType,
      opts.fixture.title,
      {
        ...(opts.fixture.mode === "single-repo" && primaryGraph
          ? { repoConnectorId: primaryGraph.repoConnectionId }
          : {}),
        grounding,
        groundingForSection,
        benchmarkProviders: providers,
      },
    );
    const warmGenerationMs = performance.now() - warmGenStart;
    const peakMemoryBytes = Math.max(0, process.memoryUsage().rss - startRss);

    const tokenTotals = opts.liveModelRun ? await tokenUsageTotals(projectId) : null;
    const judgeResolution = resolveJudgeDeps(() => provider);
    const judged = await runAnswerCorrectness({
      corpusId: opts.fixture.benchmarkReferenceCorpusId,
      corpusDir: opts.corpusDir,
      generated: [
        {
          queryId: `${opts.fixture.id}-generated-doc`,
          answer: warmResult.markdown,
        },
      ],
      deps: judgeResolution.deps,
      judgeUnavailable: judgeResolution.unavailableReason ?? undefined,
      validate: {
        expectedCorpusId: opts.fixture.benchmarkReferenceCorpusId,
      },
    });

    const baselineSupportedClaimRate =
      warmResult.sectionSupport && warmResult.sectionSupport.length > 0
        ? summarizeSupportedClaimRate(warmResult.sectionSupport, SUPPORT_BOUNDARY)
        : {
            reported: false as const,
            reason: "no verified section-level claim support scores were recorded for this run",
          };
    const baselineMissedExpectedBehavior = summarizeMissedExpectedBehavior({
      // A live provider and reference answers do not validate judge calibration.
      exploratory: true,
      envelope: judged,
    });

    const experiment = typedSymbolAdapter
      ? await runTypedSymbolExperiment({
          opts,
          projectId,
          provider,
          providers,
          grounding,
          tokenTotals,
          baseline: {
            coldResult,
            warmResult,
            coldGenerationMs,
            warmGenerationMs,
            supportedClaimRate: baselineSupportedClaimRate,
            missedExpectedBehavior: baselineMissedExpectedBehavior,
          },
          groundingForSection: typedSymbolAdapter.groundingForSection,
          report: typedSymbolAdapter.report,
        })
      : {
          typedSymbolEvidence: {
            enabled: false,
            status: "disabled" as const,
            config: typedSymbolConfig,
            decision: {
              outcome: "not-run" as const,
              exploratory: true,
              rationale: "typed symbol evidence remained disabled for this benchmark run",
            },
          },
        };

    return validateDocsGenBenchmarkResult({
      schemaVersion: DOCS_GEN_BENCHMARK_SCHEMA_VERSION,
      harnessVersion: DOCS_GEN_BENCHMARK_HARNESS_VERSION,
      generatedAt: new Date().toISOString(),
      fixture: {
        id: opts.fixture.id,
        mode: opts.fixture.mode,
        repositoryCount: opts.fixture.repositories.length,
        sourceRevisions: graphs.map((graph) => ({ repoId: graph.repoId, commit: graph.commit })),
      },
      effectiveConfig: {
        pipeline: "route-compatible",
        cacheState: "warm",
        aiProvider: provider.key,
        embeddingsProvider: process.env.EMBED_BACKEND ?? "offline",
        modelIdentities: [provider.model, embedder.model],
        liveModelRun: Boolean(opts.liveModelRun),
      },
      references: {
        corpusId: opts.fixture.benchmarkReferenceCorpusId,
        calibrationSource: opts.calibrationSource,
        publicationDisposition: opts.publicationDisposition,
      },
      experiment,
      measurements: {
        coldIngestionMs: measuredScalar(
          coldIngestionMs,
          "ms",
          "embedder warm plus fixture retrieval setup",
        ),
        warmIngestionMs: measuredScalar(
          warmIngestionMs,
          "ms",
          "second embedder warm in same process",
        ),
        coldGenerationMs: measuredScalar(coldGenerationMs, "ms", ROUTE_COMPATIBLE_BOUNDARY),
        warmGenerationMs: measuredScalar(warmGenerationMs, "ms", ROUTE_COMPATIBLE_BOUNDARY),
        peakMemoryBytes: measuredScalar(
          peakMemoryBytes,
          "bytes",
          "process rss delta across cold and warm benchmark passes",
        ),
        retrievalLatency: measuredRetrievalLatency({
          samplesMs: retrievalSamples,
          boundary: RETRIEVAL_BOUNDARY,
        }),
        tokenCost: tokenTotals
          ? measuredTokenCost({ ...tokenTotals, boundary: TOKEN_BOUNDARY })
          : {
              reported: false,
              reason: opts.liveModelRun
                ? "no TokenUsage rows were written for this run"
                : "live token/cost accounting is disabled for deterministic offline or replay benchmark runs",
            },
        supportedClaimRate: baselineSupportedClaimRate,
        missedExpectedBehavior: baselineMissedExpectedBehavior,
      },
    });
  } finally {
    __resetKnowledgeServiceSingleton();
    if (previousCloneRoot === undefined) delete process.env.REPO_CLONE_DIR;
    else process.env.REPO_CLONE_DIR = previousCloneRoot;
    if (previousAiReplay === undefined) delete process.env.AI_REPLAY;
    else process.env.AI_REPLAY = previousAiReplay;
    if (previousAiProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousAiProvider;
    if (previousAiOffline === undefined) delete process.env.AI_OFFLINE;
    else process.env.AI_OFFLINE = previousAiOffline;
    if (previousFixtureDir === undefined) delete process.env.AI_FIXTURE_DIR;
    else process.env.AI_FIXTURE_DIR = previousFixtureDir;
    if (previousEmbedBackend === undefined) delete process.env.EMBED_BACKEND;
    else process.env.EMBED_BACKEND = previousEmbedBackend;
    if (previousHashFallback === undefined) delete process.env.EMBED_ALLOW_HASH_FALLBACK;
    else process.env.EMBED_ALLOW_HASH_FALLBACK = previousHashFallback;
    if (previousEmbedModel === undefined) delete process.env.EMBED_MODEL;
    else process.env.EMBED_MODEL = previousEmbedModel;
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function runTypedSymbolExperiment(input: {
  opts: RunDocsGenBenchmarkOptions;
  projectId: string;
  provider: AIProvider;
  providers: ReturnType<typeof benchmarkProviders>;
  grounding: Awaited<ReturnType<typeof buildProjectGroundingContext>>;
  groundingForSection: SectionGroundingRetriever;
  report: {
    enabled: boolean;
    sectionsAttempted: number;
    sectionsAugmented: number;
    symbolsHydrated: number;
    neighborSymbolsHydrated: number;
    budgetExhausted: boolean;
    fallbackReason?: string;
  };
  tokenTotals: Awaited<ReturnType<typeof tokenUsageTotals>>;
  baseline: {
    coldResult: Awaited<ReturnType<typeof synthesizeHolisticDocument>>;
    warmResult: Awaited<ReturnType<typeof synthesizeHolisticDocument>>;
    coldGenerationMs: number;
    warmGenerationMs: number;
    supportedClaimRate: ReturnType<typeof summarizeSupportedClaimRate>;
    missedExpectedBehavior: ReturnType<typeof summarizeMissedExpectedBehavior>;
  };
}): Promise<DocsGenBenchmarkResult["experiment"]> {
  const candidateColdStart = performance.now();
  await synthesizeHolisticDocument(
    input.projectId,
    input.opts.fixture.docType,
    input.opts.fixture.title,
    {
      ...(input.opts.fixture.mode === "single-repo" && input.opts.fixture.repositories[0]
        ? { repoConnectorId: `bench-repo-${input.opts.fixture.repositories[0].repoId}` }
        : {}),
      grounding: input.grounding,
      groundingForSection: input.groundingForSection,
      benchmarkProviders: input.providers,
    },
  );
  const candidateColdGenerationMs = performance.now() - candidateColdStart;
  const candidateWarmStart = performance.now();
  const candidateWarmResult = await synthesizeHolisticDocument(
    input.projectId,
    input.opts.fixture.docType,
    input.opts.fixture.title,
    {
      ...(input.opts.fixture.mode === "single-repo" && input.opts.fixture.repositories[0]
        ? { repoConnectorId: `bench-repo-${input.opts.fixture.repositories[0].repoId}` }
        : {}),
      grounding: input.grounding,
      groundingForSection: input.groundingForSection,
      benchmarkProviders: input.providers,
    },
  );
  const candidateWarmGenerationMs = performance.now() - candidateWarmStart;
  const judged = await runAnswerCorrectness({
    corpusId: input.opts.fixture.benchmarkReferenceCorpusId,
    corpusDir: input.opts.corpusDir,
    generated: [
      {
        queryId: `${input.opts.fixture.id}-generated-doc-typed-symbol-evidence`,
        answer: candidateWarmResult.markdown,
      },
    ],
    deps: resolveJudgeDeps(() => input.provider).deps,
    judgeUnavailable: resolveJudgeDeps(() => input.provider).unavailableReason ?? undefined,
    validate: {
      expectedCorpusId: input.opts.fixture.benchmarkReferenceCorpusId,
    },
  });
  const candidateSupportedClaimRate =
    candidateWarmResult.sectionSupport && candidateWarmResult.sectionSupport.length > 0
      ? summarizeSupportedClaimRate(candidateWarmResult.sectionSupport, SUPPORT_BOUNDARY)
      : {
          reported: false as const,
          reason: "no verified section-level claim support scores were recorded for this run",
        };
  const candidateMissedExpectedBehavior = summarizeMissedExpectedBehavior({
    exploratory: true,
    envelope: judged,
  });
  const supportedDelta = metricDelta(
    input.baseline.supportedClaimRate,
    candidateSupportedClaimRate,
    (metric) => metric.rate,
  );
  const missedDelta = metricDelta(
    input.baseline.missedExpectedBehavior,
    candidateMissedExpectedBehavior,
    (metric) => metric.missedRate,
  );

  return {
    typedSymbolEvidence: {
      enabled: true,
      status: input.report.fallbackReason ? "safe-fallback" : "compared",
      config: resolveTypedSymbolEvidenceConfig(input.opts.typedSymbolEvidence),
      report: input.report,
      comparison: {
        baseline: {
          supportedClaimRate: input.baseline.supportedClaimRate,
          missedExpectedBehavior: input.baseline.missedExpectedBehavior,
          coldGenerationMs: measuredScalar(
            input.baseline.coldGenerationMs,
            "ms",
            ROUTE_COMPATIBLE_BOUNDARY,
          ),
          warmGenerationMs: measuredScalar(
            input.baseline.warmGenerationMs,
            "ms",
            ROUTE_COMPATIBLE_BOUNDARY,
          ),
          ...(input.tokenTotals
            ? { tokenCost: measuredTokenCost({ ...input.tokenTotals, boundary: TOKEN_BOUNDARY }) }
            : {}),
        },
        candidate: {
          supportedClaimRate: candidateSupportedClaimRate,
          missedExpectedBehavior: candidateMissedExpectedBehavior,
          coldGenerationMs: measuredScalar(
            candidateColdGenerationMs,
            "ms",
            ROUTE_COMPATIBLE_BOUNDARY,
          ),
          warmGenerationMs: measuredScalar(
            candidateWarmGenerationMs,
            "ms",
            ROUTE_COMPATIBLE_BOUNDARY,
          ),
        },
        deltas: {
          supportedClaimRate: supportedDelta,
          missedExpectedBehavior: missedDelta,
          coldGenerationMs: candidateColdGenerationMs - input.baseline.coldGenerationMs,
          warmGenerationMs: candidateWarmGenerationMs - input.baseline.warmGenerationMs,
        },
      },
      decision: decideTypedSymbolExperiment({
        liveModelRun: Boolean(input.opts.liveModelRun),
        fallbackReason: input.report.fallbackReason,
      }),
    },
  };
}

function metricDelta<T extends { reported: boolean }>(
  baseline: T,
  candidate: T,
  selector: (metric: Extract<T, { reported: true }>) => number,
): number | null {
  if (!baseline.reported || !candidate.reported) return null;
  return (
    selector(candidate as Extract<T, { reported: true }>) -
    selector(baseline as Extract<T, { reported: true }>)
  );
}

function decideTypedSymbolExperiment(input: { liveModelRun: boolean; fallbackReason?: string }): {
  outcome: "keep-disabled" | "insufficient-evidence";
  exploratory: boolean;
  rationale: string;
} {
  if (input.fallbackReason) {
    return {
      outcome: "insufficient-evidence",
      exploratory: true,
      rationale: `typed symbol evidence fell back safely to the baseline path: ${input.fallbackReason}; judge calibration has not been validated.`,
    };
  }
  if (!input.liveModelRun) {
    return {
      outcome: "keep-disabled",
      exploratory: true,
      rationale:
        "deterministic or replay-backed comparison stays exploratory, so typed symbol evidence remains off by default even when offline metrics move.",
    };
  }
  return {
    outcome: "keep-disabled",
    exploratory: true,
    rationale:
      "live A/B stays exploratory because judge calibration has not been validated; reference-answer provenance and measured deltas do not justify promotion, so typed symbol evidence remains off by default.",
  };
}
