/**
 * Cached-Sonnet vs uncached-Haiku cost crossover (Epic #696 / Issue #701).
 *
 * Two doc-gen / analysis flows deliberately route to Haiku below its 4,096-token
 * prompt-cache floor (the largest legitimate stable prefix is ~2,225 tokens), so
 * they take **zero** cache hits by construction:
 *
 *   1. Docs-gen CLAIM EXTRACTION (`claimModel` in `holistic-synthesizer.ts`).
 *   2. Model-router BUDGET DOWNGRADE (`model-router.ts`) — Sonnet analysis
 *      demoted to Haiku once the monthly-token threshold is crossed.
 *
 * Sonnet 4.6 clears its own floor (1,024 on Bedrock) with that same prefix, so a
 * cached-Sonnet variant is *feasible* where cached-Haiku is not. The economic
 * question is whether cached-Sonnet actually beats uncached-Haiku, and that turns
 * on the flow's **input:output ratio** and its **cache-read (hit) rate** — not on
 * the sticker price of the "cheap" model.
 *
 * This module is PURE and deterministic. It does not price a second copy of the
 * rate table: every dollar figure is produced by {@link estimateCostUsd} and
 * every break-even is derived from the SAME {@link MODEL_PRICING} /
 * {@link CACHE_READ_MULTIPLIER} constants in `token-tracker.ts`. There are no
 * live LLM or gateway calls — real production ratios and hit rates arrive later
 * via the #699 telemetry endpoint and the #698 cache-aware cost field, which is
 * how this preliminary decision gets validated under load (#704).
 */
import { CACHE_READ_MULTIPLIER, MODEL_PRICING, estimateCostUsd } from "./token-tracker.js";

/** Model keys as recognised by {@link MODEL_PRICING} / {@link estimateCostUsd}. */
export const SONNET_PRICING_KEY = "sonnet";
export const HAIKU_PRICING_KEY = "haiku";

/** A single flow's token shape for one representative call/batch. */
export interface FlowTokenShape {
  /** Total prompt (input) tokens for the call — cached + fresh combined. */
  inputTokens: number;
  /** Completion (output) tokens the call produces. */
  outputTokens: number;
  /**
   * Fraction of the INPUT tokens served from cache (billed at
   * {@link CACHE_READ_MULTIPLIER} × input rate). Equivalent to the steady-state
   * cache-read/hit rate against the input. Clamped to `[0, 1]`. Only meaningful
   * for the cached-Sonnet leg; the uncached-Haiku leg ignores it.
   */
  cacheReadFraction: number;
}

/** Which model is cheaper for a given flow shape, and by how much. */
export interface CrossoverResult {
  sonnetCachedUsd: number;
  haikuUncachedUsd: number;
  /** The cheaper option, or `"tie"` when the two costs are equal. */
  cheaper: "sonnet-cached" | "haiku-uncached" | "tie";
  /** `haikuUncachedUsd - sonnetCachedUsd` — positive when Sonnet-cached wins. */
  savingsUsd: number;
  /** Savings as a fraction of the more expensive option (`[0, 1)`), or 0 at tie. */
  savingsFraction: number;
}

const clampFraction = (n: number): number => {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? 1 : n;
};

/**
 * The family keys this module prices always resolve to a published rate; a
 * `null` here means the pricing table lost a Claude family, which must fail
 * loudly rather than read as a $0 flow (#22).
 */
function priced(usd: number | null): number {
  if (usd === null) throw new Error("cache-crossover: Claude family price missing");
  return usd;
}

/**
 * Cost of running a flow on Sonnet WITH prompt caching. `cacheReadFraction` of
 * the input is billed at the reduced cache-read rate; the remainder is fresh
 * input. Cache WRITES are intentionally excluded: for a high-volume, warm-cache
 * flow the one-time write amortises toward zero across many reads, so this is the
 * steady-state (best-case-for-Sonnet) estimate. Output is always full-priced.
 */
export function sonnetCachedCostUsd(shape: FlowTokenShape): number {
  const f = clampFraction(shape.cacheReadFraction);
  const cacheReadTokens = Math.round(shape.inputTokens * f);
  const freshInput = shape.inputTokens - cacheReadTokens;
  return priced(
    estimateCostUsd(SONNET_PRICING_KEY, freshInput, shape.outputTokens, {
      cacheReadTokens,
    }),
  );
}

/** Cost of running a flow on Haiku with NO caching (the current behaviour). */
export function haikuUncachedCostUsd(
  shape: Pick<FlowTokenShape, "inputTokens" | "outputTokens">,
): number {
  return priced(estimateCostUsd(HAIKU_PRICING_KEY, shape.inputTokens, shape.outputTokens, {}));
}

/** Compare cached-Sonnet against uncached-Haiku for one flow shape. */
export function compareCachedSonnetVsHaiku(shape: FlowTokenShape): CrossoverResult {
  const sonnetCachedUsd = sonnetCachedCostUsd(shape);
  const haikuUncachedUsd = haikuUncachedCostUsd(shape);
  const savingsUsd = haikuUncachedUsd - sonnetCachedUsd;
  const denom = Math.max(sonnetCachedUsd, haikuUncachedUsd);
  let cheaper: CrossoverResult["cheaper"];
  if (savingsUsd > 0) cheaper = "sonnet-cached";
  else if (savingsUsd < 0) cheaper = "haiku-uncached";
  else cheaper = "tie";
  return {
    sonnetCachedUsd,
    haikuUncachedUsd,
    cheaper,
    savingsUsd,
    savingsFraction: denom > 0 ? Math.abs(savingsUsd) / denom : 0,
  };
}

/**
 * The cache-read fraction `f` at which cached-Sonnet cost EQUALS uncached-Haiku
 * cost for a given input/output shape. Above this fraction Sonnet-cached is
 * cheaper; below it, Haiku wins.
 *
 * Derived analytically from the shared rate table (no second copy):
 *
 *   sonnetCached(f) = I·Sᵢ·(1 − (1 − m)·f) + O·Sₒ
 *   haiku          = I·Hᵢ + O·Hₒ
 *   ⇒ f* = [ I·(Sᵢ − Hᵢ) + O·(Sₒ − Hₒ) ] / [ I·Sᵢ·(1 − m) ]
 *
 * where Sᵢ/Sₒ, Hᵢ/Hₒ are the Sonnet/Haiku input/output rates and
 * m = {@link CACHE_READ_MULTIPLIER}.
 *
 * Returns `null` when the break-even is UNREACHABLE — i.e. `f* > 1` (Sonnet-cached
 * loses even at a 100% hit rate) or `f* < 0` (Sonnet-cached wins even uncached).
 * A `null` therefore means "no interior crossover"; use {@link compareCachedSonnetVsHaiku}
 * to see which side owns the whole range.
 */
export function breakEvenCacheReadFraction(
  shape: Pick<FlowTokenShape, "inputTokens" | "outputTokens">,
): number | null {
  const s = MODEL_PRICING[SONNET_PRICING_KEY];
  const h = MODEL_PRICING[HAIKU_PRICING_KEY];
  const { inputTokens: I, outputTokens: O } = shape;
  const denom = I * s.input * (1 - CACHE_READ_MULTIPLIER);
  if (denom <= 0) return null;
  const f = (I * (s.input - h.input) + O * (s.output - h.output)) / denom;
  if (f < 0 || f > 1) return null;
  return f;
}

/**
 * The maximum output:input ratio at which cached-Sonnet can EVER beat uncached-
 * Haiku — evaluated at a perfect 100% cache-read rate (the most favourable case
 * for Sonnet). Above this ratio Sonnet's 3× output premium ($15 vs $5/MTok)
 * outweighs any input saving, so Haiku wins regardless of hit rate.
 *
 * At f = 1: I·Sᵢ·m + O·Sₒ = I·Hᵢ + O·Hₒ
 *   ⇒ (O/I)* = (Sᵢ·m − Hᵢ) / (Hₒ − Sₒ)
 *
 * With the current table (Sᵢ=3, Sₒ=15, Hᵢ=1, Hₒ=5, m=0.1) this is 0.07 — a flow
 * whose output exceeds 7% of its input can never be made cheaper on Sonnet by
 * caching alone. Derived from {@link MODEL_PRICING}, never hardcoded.
 */
export function maxWinningOutputInputRatio(): number {
  const s = MODEL_PRICING[SONNET_PRICING_KEY];
  const h = MODEL_PRICING[HAIKU_PRICING_KEY];
  return (s.input * CACHE_READ_MULTIPLIER - h.input) / (h.output - s.output);
}

/**
 * Static, source-derived token estimate for a representative docs-gen
 * CLAIM-EXTRACTION batch — used to reach a preliminary verdict WITHOUT a live
 * run (see the reliability constraint on #701). Derivation, documented in
 * `docs/OPERATIONS.md` §7.5:
 *
 *  - INPUT: the `SYSTEM_PROMPT` in `grounding/claim-extractor.ts` (~230 tok) +
 *    the enumerated source-id list (~250 tok) + the section passage (~1,000 tok)
 *    ≈ 1,480 tok. Rounded to the ~1,500 order of magnitude. The cacheable stable
 *    prefix (system + source ids) is only ~480 tok, so even the cache-read
 *    fraction is small — but the ratio verdict below holds at ANY hit rate.
 *  - OUTPUT: a section decomposes into ~15–25 atomic claims, each a full sentence
 *    plus its `sourceIds` array (~35 tok/claim) ≈ 700 tok.
 *
 * Output:input ≈ 700 / 1,500 ≈ 0.47 — nearly 7× the {@link maxWinningOutputInputRatio}
 * ceiling of 0.07, so Haiku wins decisively for claim extraction. These are
 * order-of-magnitude figures; production-validated numbers finalise via #699.
 */
export const CLAIM_EXTRACTION_STATIC_ESTIMATE: FlowTokenShape = {
  inputTokens: 1_500,
  outputTokens: 700,
  // Only ~480 tok of the input (system + source ids) is a stable, cacheable
  // prefix; the passage varies per section. ~480/1,500 ≈ 0.32 best-case read
  // fraction, but the verdict is ratio-bound, not hit-rate-bound.
  cacheReadFraction: 0.32,
};
