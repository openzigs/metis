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
 */
import { getTokenTracker, estimateUsageCostUsd } from "../ai/token-tracker.js";
import { HAIKU_MODEL_ID } from "../ai/model-router.js";
import type { ProviderKey } from "../ai/types.js";
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
   * #43 — judge/suggestion tokens from a model METIS has no price for. They
   * are NOT in `usedCents`; non-zero means `usedCents` is a lower bound and the
   * budget refuses further LLM work.
   */
  unpricedTokens: number;
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
      modelId?: string;
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
  private unpricedTokens = 0;
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
    // Embeddings run on the local embedder (offline-stub); an LLM phase is
    // recorded under what served it (#43), never a hard-coded provider.
    const provider: ProviderKey = input.phase === "embedding" ? "offline-stub" : input.provider;
    const modelId = input.modelId ?? HAIKU_MODEL_ID;

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
    // Without a provider there is no telling whose price applies: unpriced.
    const usd = provider ? estimateUsageCostUsd(modelId, usage, provider) : null;
    if (usd === null) this.unpricedTokens += total;
    else this.estimatedUsd += usd;

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

  private ensureSession(provider: ProviderKey, model: string): Promise<boolean> {
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
      unpricedTokens: this.unpricedTokens,
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
    if (this.unpricedTokens > 0) return false;
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
   */
  exceeded(): boolean {
    return this.unpricedTokens > 0 || this.usedCents >= this.limitCents;
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
  // are read back from its `ai_token_usages` rows (NULL cost).
  const unpriced = await db.aITokenUsage.aggregate({
    where: { sessionId: coverageSessionId(runId), estimatedCostUsd: null },
    _sum: { totalTokens: true },
  });
  const limit = options.budgetCents ?? DEFAULT_BUDGET_CENTS;
  return {
    limitCents: limit,
    usedCents: row.tokenCostCents,
    remainingCents: Math.max(0, limit - row.tokenCostCents),
    unpricedTokens: unpriced._sum.totalTokens ?? 0,
    breakdown: {
      embeddingTokens: row.embeddingTokens,
      judgeTokens: row.judgeTokens,
      suggestionTokens: row.suggestionTokens,
    },
  };
}
