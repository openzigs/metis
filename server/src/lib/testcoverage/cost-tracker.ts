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
 */
import { getTokenTracker, estimateCostUsd } from "../ai/token-tracker.js";
import { HAIKU_MODEL_ID } from "../ai/model-router.js";
import { prisma } from "../prisma.js";

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
  readonly sessionId: string;

  constructor(
    private readonly scope: CostScope,
    private readonly options: {
      budgetCents?: number;
      tracker?: ReturnType<typeof getTokenTracker>;
      db?: typeof prisma;
    } = {},
  ) {
    this.sessionId = `testCoverageRun:${scope.runId}`;
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
  record(input: {
    phase: CoveragePhase;
    modelId?: string;
    promptTokens?: number;
    completionTokens?: number;
    /** For pre-computed embeddings where there is no completion. */
    embeddingTokens?: number;
  }): void {
    const tracker = this.options.tracker ?? getTokenTracker();
    const modelId = input.modelId ?? HAIKU_MODEL_ID;
    const prompt = input.promptTokens ?? input.embeddingTokens ?? 0;
    const completion = input.completionTokens ?? 0;
    const total = prompt + completion;
    if (total === 0) return;

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
    // #22 — an unpriced model (null) has no estimable cost; its tokens are
    // still counted above.
    this.estimatedUsd += estimateCostUsd(modelId, prompt, completion) ?? 0;

    tracker.record({
      sessionId: this.sessionId,
      userId: this.scope.userId,
      provider: input.phase === "embedding" ? "offline-stub" : "bedrock-gateway",
      model: modelId,
      usage: { promptTokens: prompt, completionTokens: completion, totalTokens: total },
      projectId: this.scope.projectId,
      agentStep: `testcoverage.${input.phase}`,
      breakdown: { [input.phase]: total },
    });
  }

  view(): CoverageBudgetView {
    const used = this.usedCents;
    return {
      limitCents: this.limitCents,
      usedCents: used,
      remainingCents: Math.max(0, this.limitCents - used),
      breakdown: {
        embeddingTokens: this.embeddingTokens,
        judgeTokens: this.judgeTokens,
        suggestionTokens: this.suggestionTokens,
      },
    };
  }

  /** True when we still have budget for {@link additionalCents} more spend. */
  canAfford(additionalCents: number): boolean {
    return this.usedCents + Math.max(0, additionalCents) <= this.limitCents;
  }

  /**
   * Hard-stop predicate (Epic #880 / #883). Returns true once cumulative spend
   * has reached (or passed) the per-run cap. The coverage service consults this
   * BEFORE each LLM phase (judge / suggestion) and skips it when exceeded, so a
   * large run can never overspend the budget unbounded.
   */
  exceeded(): boolean {
    return this.usedCents >= this.limitCents;
  }

  /** Persist the current totals to `TestCoverageRun`. */
  async flush(): Promise<void> {
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
  const limit = options.budgetCents ?? DEFAULT_BUDGET_CENTS;
  return {
    limitCents: limit,
    usedCents: row.tokenCostCents,
    remainingCents: Math.max(0, limit - row.tokenCostCents),
    breakdown: {
      embeddingTokens: row.embeddingTokens,
      judgeTokens: row.judgeTokens,
      suggestionTokens: row.suggestionTokens,
    },
  };
}
