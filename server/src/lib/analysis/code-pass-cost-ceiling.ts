/**
 * #2569 — the analysis code pass's dollar ceiling.
 *
 * The pass is bounded in tokens (`ANALYSIS_AGENT_TOKEN_BUDGET`) and turns, and
 * the deployment per month (`ANALYSIS_MONTHLY_TOKEN_CAP`). An exploring pass
 * (#2565) spends more per item (+46% on Miniflux, up to $0.31 for one item in
 * #2560), so the pass is also bounded in dollars, as the eval's `$1` cap was.
 *
 * The ceiling sits on the PROVIDER the pass calls, so every model call of the
 * pass passes through it: each loop turn (the explorer nudge and #1388's
 * continuation are ordinary turns), the final-answer retry, the transcript
 * salvage's repair call, the evidence-only salvage, and the support panel and
 * faithfulness calls. Before each call it refuses once the priced spend has
 * reached the ceiling ({@link CostCeilingReachedError}); after each call it adds
 * the call's cost, priced from the ledger rates exactly as `recordUsage` prices
 * the call's `token_usages` row.
 *
 * Checked BEFORE a call, so a pass can overshoot by at most one call's cost:
 * with $0.10 calls and a $0.25 ceiling the third call starts at $0.20 and ends
 * at $0.30, and the fourth is refused.
 *
 * Unpriced (#22): a call whose model has no ledger rate has an unknown cost,
 * never $0. It adds nothing to the priced spend, the ceiling is logged once and
 * recorded as `cost-ceiling-unpriced`, and the pass is bounded by its token
 * budget. The priced spend stays a lower bound, so a ceiling it has already
 * passed still refuses.
 */
import type { CodePassCostCeilingRecord } from "@metis/shared";
import { decorateProvider } from "../ai/provider-decorator.js";
import type { AIProvider, ChatChunk, ChatMessage, ChatOptions, TokenUsage } from "../ai/types.js";
import { getConfigService } from "../config/config-service.js";
import { resolveRate } from "../finops/provider-rates.js";
import { priceLedgerTokensExact } from "../finops/token-tracker.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("code-pass-cost-ceiling");

/** The ceiling, in USD per requirement the pass investigates. `0` turns it off. */
export const CODE_PASS_MAX_USD_KEY = "ANALYSIS_CODE_PASS_MAX_USD";
/** A20's `$1` cap was per requirement (#2560), so the default is too. */
export const DEFAULT_CODE_PASS_MAX_USD = 1;

/** Thrown by a guarded provider in place of a model call the ceiling refuses. */
export class CostCeilingReachedError extends Error {
  readonly limitUsd: number;
  readonly spentUsd: number;
  constructor(limitUsd: number, spentUsd: number) {
    super(
      `Code pass cost ceiling reached: $${spentUsd.toFixed(4)} spent of $${limitUsd.toFixed(4)}`,
    );
    this.name = "CostCeilingReachedError";
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
  }
}

export function isCostCeilingReachedError(err: unknown): err is CostCeilingReachedError {
  return err instanceof CostCeilingReachedError;
}

/**
 * `ANALYSIS_CODE_PASS_MAX_USD`, or its default. The key's schema is applied on
 * a write through the config service only; a value from the environment is not
 * validated, so a negative or a non-number degrades to the default rather than
 * turning the ceiling off.
 */
export function readCodePassMaxUsd(): number {
  const raw = getConfigService().get(CODE_PASS_MAX_USD_KEY)?.trim();
  if (!raw) return DEFAULT_CODE_PASS_MAX_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CODE_PASS_MAX_USD;
}

/** The priced cost of one call in USD, or `null` when its model has no ledger rate. */
export function priceCallUsd(provider: string, model: string, usage: TokenUsage): number | null {
  const cents = priceLedgerTokensExact(
    provider,
    resolveRate(provider, model),
    {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    },
    null,
  );
  return cents === null ? null : cents / 100;
}

/** One code pass's (or one multi-repository run's) dollar ceiling. */
export class CodePassCostCeiling {
  private spent = 0;
  private refused = 0;
  private refusedGrading = 0;
  private unpriced = false;

  /** `limitUsd` of 0 (or less) turns the ceiling off; spend is still counted. */
  constructor(readonly limitUsd: number) {}

  /** Priced spend so far, in USD. A lower bound once a call was unpriced. */
  get spentUsd(): number {
    return this.spent;
  }

  /** Model calls refused so far, the pass's own and the grading calls'. */
  get refusedCalls(): number {
    return this.refused + this.refusedGrading;
  }

  /**
   * The ceiling refused at least one of the PASS's own calls (a loop turn, the
   * final-answer retry, a salvage or repair call), so a pass stopped short. A
   * refused grading call (support panel, faithfulness — `guard(p, { grading:
   * true })`) only leaves a finding ungraded, and does not count.
   */
  get reached(): boolean {
    return this.refused > 0;
  }

  /**
   * Throws {@link CostCeilingReachedError} once the priced spend has reached
   * the ceiling: a call is allowed only while `spent < limit`.
   */
  assertCanCall(opts: { grading?: boolean } = {}): void {
    if (this.limitUsd <= 0 || this.spent < this.limitUsd) return;
    if (opts.grading) this.refusedGrading += 1;
    else this.refused += 1;
    throw new CostCeilingReachedError(this.limitUsd, this.spent);
  }

  /** Add one finished call's cost. */
  record(provider: string, model: string, usage: TokenUsage | undefined): void {
    if (!usage) return;
    const usd = priceCallUsd(provider, model, usage);
    if (usd === null) {
      if (!this.unpriced && this.limitUsd > 0) {
        log.warn("Code pass model is unpriced; the cost ceiling falls back to the token budget", {
          provider,
          model,
          limitUsd: this.limitUsd,
        });
      }
      this.unpriced = true;
      return;
    }
    this.spent += usd;
  }

  /**
   * `provider` with every `chat` / `stream` call checked against, and counted
   * towards, this ceiling. Every other member reaches the adapter unchanged.
   * `grading: true` is for the support panel and faithfulness calls: their
   * spend counts, but a refusal of one does not make {@link reached} true.
   *
   * The provider key prices the call as `meterAnalysisProvider` prices its
   * `token_usages` row: the key the response reports, else the adapter's. A
   * stream's `usage` chunk reports no provider (`ChatChunk`), so a stream is
   * priced on the adapter's key, exactly as its ledger row is.
   */
  guard(provider: AIProvider, guardOpts: { grading?: boolean } = {}): AIProvider {
    const keyOf = (reported: string | undefined) => reported ?? provider.key;
    const chat = async (messages: ChatMessage[], opts?: ChatOptions) => {
      this.assertCanCall(guardOpts);
      const res = await provider.chat(messages, opts);
      this.record(keyOf(res.provider), res.model ?? opts?.model ?? provider.model, res.usage);
      return res;
    };
    const assertCanCall = () => this.assertCanCall(guardOpts);
    const record = (model: string, usage: TokenUsage) =>
      this.record(keyOf(undefined), model, usage);
    async function* stream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<ChatChunk> {
      assertCanCall();
      for await (const chunk of provider.stream(messages, opts)) {
        if (chunk.type === "usage")
          record(chunk.model ?? opts?.model ?? provider.model, chunk.usage);
        yield chunk;
      }
    }
    return decorateProvider(provider, { chat, stream });
  }

  /**
   * What the capability record says, or `null` when the ceiling neither
   * stopped a pass nor met an unpriced call (an off ceiling says nothing).
   */
  outcome(): CodePassCostCeilingRecord | null {
    if (this.limitUsd <= 0 || (!this.reached && !this.unpriced)) return null;
    return {
      limitUsd: this.limitUsd,
      spentUsd: Math.round(this.spent * 1e6) / 1e6,
      reached: this.reached,
      pricing: this.unpriced ? "cost-ceiling-unpriced" : "priced",
    };
  }
}

/**
 * The ceiling for a code pass over `requirementCount` requirements:
 * `ANALYSIS_CODE_PASS_MAX_USD` per requirement (A20's cap was per requirement,
 * and a fixed ceiling would cut a large pass short and turn the rest into
 * could-not-verify), times `multiplier` — a "Continue with a larger budget"
 * rerun gets the same multiple of the ceiling as of its token budget.
 */
export function createCodePassCostCeiling(input: {
  requirementCount: number;
  multiplier?: number;
}): CodePassCostCeiling {
  const perRequirement = readCodePassMaxUsd();
  const requirements = Math.max(1, input.requirementCount);
  const multiplier = input.multiplier && input.multiplier > 0 ? input.multiplier : 1;
  return new CodePassCostCeiling(perRequirement * requirements * multiplier);
}
