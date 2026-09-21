/**
 * Issue #428 (Epic #407) — provider→cost-rate mapping tests.
 *
 * Guards the two defects fixed in #428:
 *   1. `anthropic` provider rows must report non-zero cost whenever tokens are
 *      non-zero. The bare 4.x model ids the AnthropicProvider emits
 *      (`claude-sonnet-4-6`, `claude-opus-4-8`, `claude-haiku-4-5`, …) were
 *      missing from the rate table, so `getRate` fell through to DEFAULT_RATE
 *      (zero) and the "By provider" anthropic row showed $0.00.
 *   2. The rate-table unit convention (cents per 1k tokens) must be preserved.
 *
 * Rate source: Anthropic published API pricing
 * (https://platform.claude.com/docs/en/docs/about-claude/pricing), read
 * 2026-06-25. Conversion: $X / MTok === (X / 10) cents per 1k tokens.
 *   Sonnet 4.x  $3 in / $15 out / $0.30 cacheRead / $3.75 cacheWrite(5m)
 *               → 0.3 / 1.5 / 0.03 / 0.375 cents-per-1k
 *   Opus 4.5+   $5 in / $25 out / $0.50 cacheRead / $6.25 cacheWrite(5m)
 *               → 0.5 / 2.5 / 0.05 / 0.625 cents-per-1k
 *   Haiku 4.5   $1 in / $5 out / $0.10 cacheRead / $1.25 cacheWrite(5m)
 *               → 0.1 / 0.5 / 0.01 / 0.125 cents-per-1k
 */
import { describe, expect, it } from "vitest";
import { getRate, computeCostCents, DEFAULT_RATE, __testRateKeys } from "./provider-rates.js";

describe("provider-rates — anthropic cost attribution (#428)", () => {
  // The bare model ids the direct AnthropicProvider emits after
  // normalizeAnthropicModelId(). These are what land in TokenUsage.model.
  const bareAnthropicModels = [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-8",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-haiku-4-5",
  ];

  it.each(bareAnthropicModels)("has a non-zero input/output rate for anthropic:%s", (model) => {
    const rate = getRate("anthropic", model);
    expect(rate).not.toBe(DEFAULT_RATE);
    expect(rate.inputPer1k).toBeGreaterThan(0);
    expect(rate.outputPer1k).toBeGreaterThan(0);
  });

  it.each(bareAnthropicModels)(
    "produces non-zero cost when anthropic:%s has non-zero tokens",
    (model) => {
      const rate = getRate("anthropic", model);
      // The #428 walkthrough showed 137,514 tokens billed at $0.00. Split the
      // observed total across input/output and assert cost is now non-zero.
      const cost = computeCostCents(rate, { inputTokens: 100_000, outputTokens: 37_514 });
      expect(cost).toBeGreaterThan(0);
    },
  );

  it("prices claude-sonnet-4-6 at the published 0.3/1.5 cents-per-1k", () => {
    const rate = getRate("anthropic", "claude-sonnet-4-6");
    expect(rate.inputPer1k).toBe(0.3);
    expect(rate.outputPer1k).toBe(1.5);
    expect(rate.cacheReadPer1k).toBe(0.03);
    expect(rate.cacheWritePer1k).toBe(0.375);
  });

  it("prices claude-opus-4-8 at the published 0.5/2.5 cents-per-1k", () => {
    const rate = getRate("anthropic", "claude-opus-4-8");
    expect(rate.inputPer1k).toBe(0.5);
    expect(rate.outputPer1k).toBe(2.5);
  });

  it("prices claude-haiku-4-5 at the published 0.1/0.5 cents-per-1k", () => {
    const rate = getRate("anthropic", "claude-haiku-4-5");
    expect(rate.inputPer1k).toBe(0.1);
    expect(rate.outputPer1k).toBe(0.5);
  });

  it("computes the same cost for a known sonnet token volume (regression guard)", () => {
    // 1M input + 1M output of Sonnet 4.6 = $3 + $15 = $18.00 = 1800 cents.
    const rate = getRate("anthropic", "claude-sonnet-4-6");
    const cost = computeCostCents(rate, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBe(1800);
  });

  it("bills an unknown anthropic model at a conservative non-zero default (never $0.00)", () => {
    // Core #428 invariant: anthropic tokens must never bill at $0.00. An
    // unrecognised anthropic id falls back to the sonnet-tier default rather
    // than DEFAULT_RATE, so cost stays non-zero whenever tokens are non-zero.
    const rate = getRate("anthropic", "claude-imaginary-9-9");
    expect(rate).not.toBe(DEFAULT_RATE);
    expect(rate.inputPer1k).toBeGreaterThan(0);
    expect(computeCostCents(rate, { inputTokens: 50_000, outputTokens: 50_000 })).toBeGreaterThan(
      0,
    );
  });

  it("still falls through to DEFAULT_RATE for a genuinely unknown provider", () => {
    const rate = getRate("totally-unknown-provider", "some-model");
    expect(rate).toBe(DEFAULT_RATE);
  });

  it("maps dated/suffixed anthropic ids to the correct family tier (#428)", () => {
    // Opus family — most expensive tier.
    const opus = getRate("anthropic", "claude-opus-4-8-20260101");
    expect(opus.inputPer1k).toBe(0.5);
    expect(opus.outputPer1k).toBe(2.5);
    // Sonnet family.
    const sonnet = getRate("anthropic", "claude-sonnet-4-5-20250929");
    expect(sonnet.inputPer1k).toBe(0.3);
    expect(sonnet.outputPer1k).toBe(1.5);
    // Haiku family — cheapest tier.
    const haiku = getRate("anthropic", "claude-haiku-4-5-20251001");
    expect(haiku.inputPer1k).toBe(0.1);
    expect(haiku.outputPer1k).toBe(0.5);
  });

  it("bills explicit anthropic cache-read/write rates when present", () => {
    const rate = getRate("anthropic", "claude-sonnet-4-6");
    // 1M cache-read @ $0.30/MTok = $0.30 = 30 cents; 1M cache-write(5m) @
    // $3.75/MTok = $3.75 = 375 cents. Total = 405 cents.
    const cost = computeCostCents(rate, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBe(405);
  });

  it("falls back to the input rate for cache when a rate omits cache prices", () => {
    // The legacy bare sonnet entry has no explicit cache rates, so cache
    // tokens are billed at the input rate (0.3 cents/1k) — never $0.00.
    const rate = getRate("anthropic", "claude-3-5-sonnet");
    expect(rate.cacheReadPer1k).toBeUndefined();
    const cost = computeCostCents(rate, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    // 1M cache-read @ input rate 0.3 cents/1k = 300 cents.
    expect(cost).toBe(300);
  });

  it("does not regress the existing legacy/openai/bedrock keys", () => {
    const keys = __testRateKeys();
    // Pre-existing entries that must remain intact.
    expect(keys).toContain("anthropic:claude-3-5-sonnet-20241022");
    expect(keys).toContain("openai:gpt-4o");
    expect(keys).toContain("bedrock-gateway:us.anthropic.claude-sonnet-4-6");
    // Pre-existing bedrock sonnet 4.6 rate is unchanged.
    const bedrock = getRate("bedrock-gateway", "us.anthropic.claude-sonnet-4-6");
    expect(bedrock.inputPer1k).toBe(0.3);
    expect(bedrock.outputPer1k).toBe(1.5);
  });
});
