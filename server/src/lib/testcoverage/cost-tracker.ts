/**
 * Epic #856 — Issue #878 — Test-coverage cost telemetry.
 *
 * Thin wrapper around {@link TokenTracker} that scopes every recorded event
 * to a single coverage run (`sessionId = testCoverageRun:<runId>`) and
 * exposes a budget view used by the REST budget endpoint and the
 * pre-flight 402 check.
 *
 * The aggregates live in-memory on the tracker (process-local) and are
 * persisted to `TestCoverageRun.tokenCostCents` plus the per-phase columns
 * `embeddingTokens` / `judgeTokens` / `suggestionTokens` introduced in the
 * Phase-2 migration so the UI can render a budget breakdown.
 *
 * #43 — judge and suggestion usage is recorded under the provider and model
 * that SERVED it (reported by the {@link JudgeModelCaller}), priced through the
 * single price source (`resolveRate`, via {@link estimateUsageCostUsd} — the
 * same call that prices the persisted `ai_token_usages` row). Usage METIS has no
 * price for is UNPRICED: it adds nothing to `usedCents` (never $0, never another
 * model's price) and makes the per-run budget fail closed, because spend that
 * cannot be priced cannot be shown to be under the cap.
 *
 * #58 — embedding usage is recorded under the embedder that ran
 * (`embed:<registry key>` and the model it loaded) and priced through the same
 * source: $0 for an in-process or in-cluster embedder, the published price for
 * a cloud one, and unpriced — failing the budget closed — where there is none.
 * Before, it was recorded on `offline-stub` under the Claude Haiku model id and
 * so priced at Haiku's rate.
 *
 * #72 — EVERY embedder call a run makes is recorded here, not just the match
 * phase's two: the judge embeds each batch prompt for its semantic-cache key,
 * and the suggestion generator embeds each cluster prompt plus every
 * suggestion's text for dedup. On a cloud embedder those were real spend the
 * run budget never saw.
 *
 * #77 — unpriced EMBEDDING usage is reported but does not stop the run, while
 * unpriced judge/suggestion usage still fails the budget closed (#43). See
 * {@link exceeded} for why the two are treated differently.
 */
import { getTokenTracker, estimateUsageCostUsd } from "../ai/token-tracker.js";
import type { ProviderKey, UsageProvider } from "../ai/types.js";
import { embeddingUsageProvider } from "../finops/provider-rates.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("testcoverage/cost-tracker");

export type CoveragePhase = "embedding" | "judge" | "suggestion";

/**
 * Default per-run budget in cents (== $0.20).
 *
 * Aligned with Epic #856 §Cost guardrails AC: *"Cold run on a 200-req / 100-
 * test corpus completes within $0.20 of LLM spend"*. Override via the
 * `TESTCOVERAGE_BUDGET_CENTS` env var for staging / experimentation.
 */
export const DEFAULT_BUDGET_CENTS = parseInt(process.env.TESTCOVERAGE_BUDGET_CENTS ?? "20", 10);

export interface CoverageBudgetView {
  /** Hard cap in cents — beyond this the run is rejected with 402. */
  limitCents: number;
  /** Cents spent so far. */
  usedCents: number;
  /** `limit - used`, clamped at 0. */
  remainingCents: number;
  /**
   * Every token this run spent on a model METIS has no price for, across all
   * phases. NOT in `usedCents`; non-zero means `usedCents` is a lower bound.
   */
  unpricedTokens: number;
  /**
   * #77 — the embedding share of {@link unpricedTokens}. Reported, but it does
   * not stop the run: see {@link CoverageCostTracker.exceeded}.
   */
  unpricedEmbeddingTokens: number;
  /**
   * #43 — the judge/suggestion share of {@link unpricedTokens}. Non-zero means
   * the budget refuses further LLM work.
   */
  unpricedLlmTokens: number;
  /** Per-phase token counts. */
  breakdown: {
    embeddingTokens: number;
    judgeTokens: number;
    suggestionTokens: number;
  };
}

export interface CostScope {
  runId: string;
  userId: string;
  projectId: string;
}

/** #43 — one recorded usage event. LLM phases name what served the call. */
export type CoverageUsage =
  | {
      phase: "embedding";
      /** Registry key of the embedder that ran (`getEmbedder().key`) — #58. */
      embedder: string;
      /** The model it ran (`EmbeddingResult.model`). */
      modelId: string;
      promptTokens?: number;
      completionTokens?: number;
      /** For pre-computed embeddings where there is no completion. */
      embeddingTokens?: number;
    }
  | {
      phase: "judge" | "suggestion";
      /** The provider that served the call (`ChatResponse.provider`). */
      provider: ProviderKey;
      /** The model that served the call (`ChatResponse.model`). */
      modelId: string;
      promptTokens?: number;
      completionTokens?: number;
    };

/** #72 — the embedding arm of {@link CoverageUsage}, as the phase guards see it. */
export type CoverageEmbeddingUsage = Extract<CoverageUsage, { phase: "embedding" }>;

/**
 * Token estimate for a batch of texts about to be embedded. ~4 characters per
 * token: cheap, and good enough for budget bookkeeping. One helper so the match
 * phase and the in-loop calls (#72) bill on the same basis.
 */
export function estimateEmbeddingTokens(texts: readonly string[]): number {
  let chars = 0;
  for (const t of texts) chars += t.length;
  return Math.ceil(chars / 4);
}

/** `ai_token_usages.sessionId` for a run — also the backing `AISession` id. */
export function coverageSessionId(runId: string): string {
  return `testCoverageRun:${runId}`;
}

/**
 * Per-run cost accumulator. One instance per coverage run; injected into the
 * matcher / judge / suggestion generator so each phase records to the same
 * sessionId.
 */
export class CoverageCostTracker {
  private embeddingTokens = 0;
  private judgeTokens = 0;
  private suggestionTokens = 0;
  private estimatedUsd = 0;
  /** #77 — split, because only the LLM share fails the budget closed. */
  private unpricedEmbeddingTokens = 0;
  private unpricedLlmTokens = 0;
  /** The backing `AISession`, created once, on the first recorded usage. */
  private session: Promise<boolean> | null = null;
  private readonly inflight = new Set<Promise<void>>();
  readonly sessionId: string;

  constructor(
    private readonly scope: CostScope,
    private readonly options: {
      budgetCents?: number;
      tracker?: ReturnType<typeof getTokenTracker>;
      db?: typeof prisma;
    } = {},
  ) {
    this.sessionId = coverageSessionId(scope.runId);
  }

  get limitCents(): number {
    return this.options.budgetCents ?? DEFAULT_BUDGET_CENTS;
  }

  get usedCents(): number {
    // Round up so we never under-bill the run.
    return Math.ceil(this.estimatedUsd * 100);
  }

  /**
   * Record token usage for a phase. Delegates to the underlying
   * {@link TokenTracker} (so daily rollups still work) *and* keeps a local
   * tally for the budget endpoint.
   */
  record(input: CoverageUsage): void {
    const prompt =
      input.promptTokens ?? (input.phase === "embedding" ? input.embeddingTokens : undefined) ?? 0;
    const completion = input.completionTokens ?? 0;
    const total = prompt + completion;
    if (total === 0) return;
    // Every phase is recorded under what served it — the embedder that ran
    // (#58) or the LLM provider (#43) — never a hard-coded provider or model.
    const provider: UsageProvider | undefined =
      input.phase === "embedding"
        ? input.embedder
          ? embeddingUsageProvider(input.embedder)
          : undefined
        : input.provider;
    const modelId = input.modelId;

    switch (input.phase) {
      case "embedding":
        this.embeddingTokens += total;
        break;
      case "judge":
        this.judgeTokens += total;
        break;
      case "suggestion":
        this.suggestionTokens += total;
        break;
    }
    const usage = { promptTokens: prompt, completionTokens: completion, totalTokens: total };
    // #43 — the same price lookup the persisted `ai_token_usages` row uses.
    // Without a provider or model there is no telling whose price applies:
    // unpriced, and not persisted (a usage row needs both).
    const usd = provider && modelId ? estimateUsageCostUsd(modelId, usage, provider) : null;
    if (usd === null) {
      if (input.phase === "embedding") this.unpricedEmbeddingTokens += total;
      else this.unpricedLlmTokens += total;
    } else this.estimatedUsd += usd;
    if (!provider || !modelId) return;

    this.persist({
      sessionId: this.sessionId,
      userId: this.scope.userId,
      provider,
      model: modelId,
      usage,
      projectId: this.scope.projectId,
      agentStep: `testcoverage.${input.phase}`,
      breakdown: { [input.phase]: total },
    });
  }

  /**
   * Write one `ai_token_usages` row. Its `sessionId` is a foreign key to
   * `ai_sessions`, so the run's backing session is created first — without it
   * every row failed the constraint and the run's usage never reached the
   * table (#43). A session that cannot be created is logged once; the budget
   * tally above does not depend on it.
   */
  private persist(event: Parameters<ReturnType<typeof getTokenTracker>["record"]>[0]): void {
    const tracker = this.options.tracker ?? getTokenTracker();
    const task = this.ensureSession(event.provider, event.model).then(async (ok) => {
      if (ok) await tracker.recordAndFlush(event);
    });
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task));
  }

  private ensureSession(provider: UsageProvider, model: string): Promise<boolean> {
    if (!this.session) {
      const db = this.options.db ?? prisma;
      // Inside the promise chain, so a failure of any kind is caught below and
      // accounting never breaks the run.
      this.session = Promise.resolve()
        .then(() =>
          db.aISession.upsert({
            where: { id: this.sessionId },
            create: {
              id: this.sessionId,
              userId: this.scope.userId,
              projectId: this.scope.projectId,
              title: `Test coverage run ${this.scope.runId}`,
              provider,
              model,
            },
            update: {},
          }),
        )
        .then(() => true)
        .catch((err: unknown) => {
          log.error("test-coverage usage session could not be created; usage stays unrecorded", {
            runId: this.scope.runId,
            error: String(err),
          });
          return false;
        });
    }
    return this.session;
  }

  view(): CoverageBudgetView {
    const used = this.usedCents;
    return {
      limitCents: this.limitCents,
      usedCents: used,
      remainingCents: Math.max(0, this.limitCents - used),
      unpricedTokens: this.unpricedEmbeddingTokens + this.unpricedLlmTokens,
      unpricedEmbeddingTokens: this.unpricedEmbeddingTokens,
      unpricedLlmTokens: this.unpricedLlmTokens,
      breakdown: {
        embeddingTokens: this.embeddingTokens,
        judgeTokens: this.judgeTokens,
        suggestionTokens: this.suggestionTokens,
      },
    };
  }

  /**
   * True when we still have budget for {@link additionalCents} more spend.
   * Never once the run has unpriced usage (#43): its spend is unknown.
   */
  canAfford(additionalCents: number): boolean {
    if (this.unpricedLlmTokens > 0) return false;
    return this.usedCents + Math.max(0, additionalCents) <= this.limitCents;
  }

  /**
   * Hard-stop predicate (Epic #880 / #883). Returns true once cumulative spend
   * has reached (or passed) the per-run cap. The coverage service consults this
   * BEFORE each LLM phase (judge / suggestion) and skips it when exceeded, so a
   * large run can never overspend the budget unbounded.
   *
   * #43 — also true once any judge/suggestion usage is unpriced: that spend
   * cannot be shown to be under the cap, so the budget fails closed (as the
   * autopilot cost ceiling does, PR #41) rather than treating it as $0.
   *
   * #77 — unpriced EMBEDDING usage is deliberately NOT a stop. The two are not
   * alike:
   *   - Embedding spend is bounded and already incurred by the time it is
   *     recorded. It is proportional to the corpus, input-only, and at the
   *     dearest published rate on the table (ada-002, $0.10/MTok) a 100-req /
   *     200-test run's ~12.5k tokens is under a fifth of one cent against a
   *     20-cent cap. Refusing the run buys nothing back.
   *   - LLM spend is the unbounded part the cap exists to control, and it is
   *     the part the run can still decline to make. That one still fails closed.
   * The embedding rows are exact model ids while `bedrock`, `bedrock-sdk` and
   * `openai` also serve Titan V1, Cohere, Azure deployment names and
   * OpenAI-compatible endpoints, so failing closed here meant every such
   * deployment got zero coverage runs — and, with #72 recording the in-loop
   * calls too, would have stopped the judge after its first batch. The
   * uncertainty is still surfaced: `unpricedTokens` counts those tokens, so
   * `usedCents` reads as the lower bound it is, and an administrator can price
   * the model with a `MODEL_PRICES` key `embed:<backend>:<model>`.
   */
  exceeded(): boolean {
    return this.unpricedLlmTokens > 0 || this.usedCents >= this.limitCents;
  }

  /** Persist the current totals to `TestCoverageRun`. */
  async flush(): Promise<void> {
    // Let this run's usage rows land first, so a budget read sees them.
    await Promise.all([...this.inflight]);
    const db = this.options.db ?? prisma;
    await db.testCoverageRun.update({
      where: { id: this.scope.runId },
      data: {
        tokenCostCents: this.usedCents,
        embeddingTokens: this.embeddingTokens,
        judgeTokens: this.judgeTokens,
        suggestionTokens: this.suggestionTokens,
      },
    });
  }
}

/**
 * Read the persisted budget view for a run without instantiating a tracker.
 * Backs the `GET /api/projects/:id/test-coverage/runs/:runId/budget` endpoint.
 */
export async function readBudget(
  runId: string,
  options: { budgetCents?: number; db?: typeof prisma } = {},
): Promise<CoverageBudgetView | null> {
  const db = options.db ?? prisma;
  const row = await db.testCoverageRun.findUnique({
    where: { id: runId },
    select: {
      tokenCostCents: true,
      embeddingTokens: true,
      judgeTokens: true,
      suggestionTokens: true,
    },
  });
  if (!row) return null;
  // #43 — `tokenCostCents` holds priced spend only; the run's unpriced tokens
  // are read back from its `ai_token_usages` rows (NULL cost). #77 — split by
  // phase on `agentStep`, so the persisted view answers the same question the
  // in-memory one does: which share of the unknown spend stops a run.
  const sessionId = coverageSessionId(runId);
  const [unpricedEmbedding, unpricedLlm] = await Promise.all([
    db.aITokenUsage.aggregate({
      where: { sessionId, estimatedCostUsd: null, agentStep: "testcoverage.embedding" },
      _sum: { totalTokens: true },
    }),
    db.aITokenUsage.aggregate({
      where: {
        sessionId,
        estimatedCostUsd: null,
        agentStep: { in: ["testcoverage.judge", "testcoverage.suggestion"] },
      },
      _sum: { totalTokens: true },
    }),
  ]);
  const embeddingTokens = unpricedEmbedding._sum.totalTokens ?? 0;
  const llmTokens = unpricedLlm._sum.totalTokens ?? 0;
  const limit = options.budgetCents ?? DEFAULT_BUDGET_CENTS;
  return {
    limitCents: limit,
    usedCents: row.tokenCostCents,
    remainingCents: Math.max(0, limit - row.tokenCostCents),
    unpricedTokens: embeddingTokens + llmTokens,
    unpricedEmbeddingTokens: embeddingTokens,
    unpricedLlmTokens: llmTokens,
    breakdown: {
      embeddingTokens: row.embeddingTokens,
      judgeTokens: row.judgeTokens,
      suggestionTokens: row.suggestionTokens,
    },
  };
}
