/**
 * #1753 — what a localization run spends, priced the way METIS's usage ledger
 * prices it, so the dollar cap and the per-requirement cost are the ledger's
 * own numbers rather than an estimate.
 *
 * Every model call an arm makes goes through {@link meterProvider}, which
 * prices the reported usage with `priceLedgerTokensExact` + `resolveRate` —
 * the single pricing source `recordUsage` writes `token_usages` with — and
 * adds it to a {@link LedgerCostMeter}. A model METIS has no price for is
 * counted as UNPRICED, never as $0: with an unpriced call the cap cannot be
 * enforced, and the runner stops.
 */
import type { AIProvider, ChatChunk, TokenUsage } from "../../ai/types.js";
import { resolveRate } from "../../finops/provider-rates.js";
import { priceLedgerTokensExact } from "../../finops/token-tracker.js";

/** What the runner reads to enforce the cap. */
export interface CostMeter {
  spentUsd(): number;
  /** Calls whose model has no price: their spend is unknown. */
  unpricedCalls(): number;
}

/** Sums the ledger price of every recorded call. */
export class LedgerCostMeter implements CostMeter {
  private cents = 0;
  private unpriced = 0;
  private calls = 0;

  /** Price one call's usage and add it. Returns its dollars, or null when unpriced. */
  record(provider: string, model: string, usage: TokenUsage | undefined): number | null {
    if (!usage) return 0;
    this.calls++;
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
    if (cents === null) {
      this.unpriced++;
      return null;
    }
    this.cents += cents;
    return cents / 100;
  }

  spentUsd(): number {
    return this.cents / 100;
  }

  unpricedCalls(): number {
    return this.unpriced;
  }

  callCount(): number {
    return this.calls;
  }
}

/**
 * The provider with every `chat` and `stream` call metered. Everything else
 * passes through unchanged.
 */
export function meterProvider(provider: AIProvider, meter: LedgerCostMeter): AIProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "chat") {
        return async (...args: Parameters<AIProvider["chat"]>) => {
          const res = await target.chat(...args);
          meter.record(target.key, res.model ?? target.model, res.usage);
          return res;
        };
      }
      if (prop === "stream") {
        return async function* (
          ...args: Parameters<AIProvider["stream"]>
        ): AsyncGenerator<ChatChunk> {
          for await (const chunk of target.stream(...args)) {
            if (chunk.type === "usage")
              meter.record(target.key, chunk.model ?? target.model, chunk.usage);
            yield chunk;
          }
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
