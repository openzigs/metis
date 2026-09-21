/**
 * Tests for the cached-Sonnet vs uncached-Haiku crossover analysis (#701).
 *
 * These are PURE math tests — no LLM, no gateway, no server. They verify the two
 * cost legs, the break-even solver, the winning-ratio ceiling, and that every
 * figure is derived from the SAME rate table in `token-tracker.ts` (no divergent
 * second copy of the pricing).
 */
import { describe, it, expect } from "vitest";
import { CACHE_READ_MULTIPLIER, MODEL_PRICING, estimateCostUsd } from "./token-tracker.js";
import {
  CLAIM_EXTRACTION_STATIC_ESTIMATE,
  breakEvenCacheReadFraction,
  compareCachedSonnetVsHaiku,
  haikuUncachedCostUsd,
  maxWinningOutputInputRatio,
  sonnetCachedCostUsd,
} from "./cache-crossover.js";

describe("sonnetCachedCostUsd / haikuUncachedCostUsd", () => {
  it("prices Haiku uncached at the full input+output rate", () => {
    // 1M input + 1M output on Haiku = $1 + $5 = $6.
    expect(haikuUncachedCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(
      6,
      6,
    );
  });

  it("prices a fully-cached Sonnet input at the 0.1x read rate", () => {
    // 1M input all cache-read (f=1) + 0 output: 1M * $3 * 0.1 = $0.30.
    expect(
      sonnetCachedCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadFraction: 1 }),
    ).toBeCloseTo(0.3, 6);
  });

  it("clamps the cache-read fraction to [0,1]", () => {
    const over = sonnetCachedCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadFraction: 5,
    });
    const at1 = sonnetCachedCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadFraction: 1,
    });
    expect(over).toBeCloseTo(at1, 9);
    const under = sonnetCachedCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadFraction: -1,
    });
    // f<=0 → all fresh input: 1M * $3 = $3.
    expect(under).toBeCloseTo(3, 6);
  });
});

describe("compareCachedSonnetVsHaiku", () => {
  it("CASE Sonnet-cached WINS: tiny output, high hit rate", () => {
    // Huge cacheable input, negligible output, near-full hit rate. Output ratio
    // 0.01 << 0.07 ceiling, so caching flips the input economics to Sonnet.
    const r = compareCachedSonnetVsHaiku({
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadFraction: 1,
    });
    expect(r.cheaper).toBe("sonnet-cached");
    expect(r.savingsUsd).toBeGreaterThan(0);
    expect(r.savingsFraction).toBeGreaterThan(0);
  });

  it("CASE Haiku WINS: output-heavy flow (claim-extraction shape)", () => {
    // Output:input ~0.47 — far above the 0.07 ceiling, so Sonnet's 3x output
    // premium dominates regardless of hit rate.
    const r = compareCachedSonnetVsHaiku({
      inputTokens: 1_500,
      outputTokens: 700,
      cacheReadFraction: 1,
    });
    expect(r.cheaper).toBe("haiku-uncached");
    expect(r.savingsUsd).toBeLessThan(0);
  });

  it("CASE BREAK-EVEN: costs match at the solved fraction and the winner flips across it", () => {
    const shape = { inputTokens: 100_000, outputTokens: 3_000 };
    const f = breakEvenCacheReadFraction(shape);
    expect(f).not.toBeNull();
    const at = compareCachedSonnetVsHaiku({ ...shape, cacheReadFraction: f as number });
    // Costs are equal to sub-cent precision at the break-even (token rounding
    // aside). The winner is deterministic ABOVE/BELOW the break-even:
    expect(at.sonnetCachedUsd).toBeCloseTo(at.haikuUncachedUsd, 5);
    // A higher hit rate lowers Sonnet's input cost → Sonnet-cached wins above f*.
    expect(
      compareCachedSonnetVsHaiku({ ...shape, cacheReadFraction: (f as number) + 0.05 }).cheaper,
    ).toBe("sonnet-cached");
    // Below f*, Haiku wins.
    expect(
      compareCachedSonnetVsHaiku({ ...shape, cacheReadFraction: (f as number) - 0.05 }).cheaper,
    ).toBe("haiku-uncached");
  });
});

describe("compareCachedSonnetVsHaiku — degenerate shapes", () => {
  it("reports a tie with zero savings-fraction for an empty (0/0) shape", () => {
    const r = compareCachedSonnetVsHaiku({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadFraction: 0,
    });
    expect(r.cheaper).toBe("tie");
    expect(r.sonnetCachedUsd).toBe(0);
    expect(r.haikuUncachedUsd).toBe(0);
    expect(r.savingsFraction).toBe(0);
  });
});

describe("breakEvenCacheReadFraction", () => {
  it("returns a fraction in [0,1] just below the ratio ceiling", () => {
    // output/input = 0.05 < 0.07 → an interior break-even exists.
    const f = breakEvenCacheReadFraction({ inputTokens: 100_000, outputTokens: 5_000 });
    expect(f).not.toBeNull();
    expect(f as number).toBeGreaterThan(0);
    expect(f as number).toBeLessThanOrEqual(1);
  });

  it("returns null when Sonnet-cached can never win (output ratio above ceiling)", () => {
    // output/input = 0.5 >> 0.07 → f* > 1, unreachable.
    expect(breakEvenCacheReadFraction({ inputTokens: 1_000, outputTokens: 500 })).toBeNull();
  });

  it("matches the analytic formula for a mid-range shape", () => {
    const I = 200_000;
    const O = 4_000;
    const s = MODEL_PRICING.sonnet;
    const h = MODEL_PRICING.haiku;
    const expected =
      (I * (s.input - h.input) + O * (s.output - h.output)) /
      (I * s.input * (1 - CACHE_READ_MULTIPLIER));
    const f = breakEvenCacheReadFraction({ inputTokens: I, outputTokens: O });
    // Only assert when the analytic value is actually in-range (else null).
    if (expected >= 0 && expected <= 1) {
      expect(f).toBeCloseTo(expected, 9);
    } else {
      expect(f).toBeNull();
    }
  });

  it("guards against a zero-input shape (no divide-by-zero)", () => {
    expect(breakEvenCacheReadFraction({ inputTokens: 0, outputTokens: 100 })).toBeNull();
  });
});

describe("maxWinningOutputInputRatio", () => {
  it("is 0.07 for the current rate table", () => {
    expect(maxWinningOutputInputRatio()).toBeCloseTo(0.07, 9);
  });

  it("is derived from MODEL_PRICING, not hardcoded", () => {
    const s = MODEL_PRICING.sonnet;
    const h = MODEL_PRICING.haiku;
    const expected = (s.input * CACHE_READ_MULTIPLIER - h.input) / (h.output - s.output);
    expect(maxWinningOutputInputRatio()).toBeCloseTo(expected, 12);
  });
});

describe("pricing reuse (no divergent rate copy)", () => {
  it("cost legs equal a direct estimateCostUsd call with the same shape", () => {
    // Sonnet cached: 50k input at f=0.4 (20k read / 30k fresh) + 2k output.
    const shape = { inputTokens: 50_000, outputTokens: 2_000, cacheReadFraction: 0.4 };
    const direct = estimateCostUsd("sonnet", 30_000, 2_000, { cacheReadTokens: 20_000 });
    expect(sonnetCachedCostUsd(shape)).toBeCloseTo(direct, 12);
    // Haiku uncached mirrors a plain estimateCostUsd with no cache.
    expect(haikuUncachedCostUsd(shape)).toBeCloseTo(
      estimateCostUsd("haiku", 50_000, 2_000, {}),
      12,
    );
  });
});

describe("CLAIM_EXTRACTION_STATIC_ESTIMATE (verdict fixture)", () => {
  it("keeps Haiku the cheaper model at the estimated ratio, even at its cache-read fraction", () => {
    const r = compareCachedSonnetVsHaiku(CLAIM_EXTRACTION_STATIC_ESTIMATE);
    expect(r.cheaper).toBe("haiku-uncached");
  });

  it("has an output:input ratio above the winning ceiling (Sonnet can never win)", () => {
    const ratio =
      CLAIM_EXTRACTION_STATIC_ESTIMATE.outputTokens / CLAIM_EXTRACTION_STATIC_ESTIMATE.inputTokens;
    expect(ratio).toBeGreaterThan(maxWinningOutputInputRatio());
    expect(breakEvenCacheReadFraction(CLAIM_EXTRACTION_STATIC_ESTIMATE)).toBeNull();
  });
});
