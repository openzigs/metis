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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRate,
  computeCostCents,
  DEFAULT_RATE,
  __testRateKeys,
  claudeFamilyRate,
  isThirdPartyAnthropicEndpoint,
  modelPricesSchema,
  resolveRate,
} from "./provider-rates.js";
import { ConfigService } from "../config/config-service.js";

/** A ConfigService reading only the given env — no DB, no vault, no process.env. */
function configWith(env: Record<string, string>): ConfigService {
  return new ConfigService({ env, vault: {} as never });
}

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
    const rate = getRate("anthropic", model)!;
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

  it("records an unrecognised anthropic id as UNPRICED, not at a Sonnet default (#22)", () => {
    // #22 reverses #428's "never $0.00" fallback: that default billed EVERY
    // unrecognised model on the anthropic provider — including a DeepSeek model
    // reached through ANTHROPIC_BASE_URL — at Sonnet 4.6 rates. An unknown id is
    // now unpriced (null), which the views show as unknown spend, not $0.
    expect(getRate("anthropic", "claude-imaginary-9-9")).toBeNull();
    expect(getRate("anthropic", "deepseek-v4-pro")).toBeNull();
  });

  it("records a genuinely unknown provider as UNPRICED, not as a zero rate (#22)", () => {
    expect(getRate("totally-unknown-provider", "some-model")).toBeNull();
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

describe("provider-rates — one pricing source, unpriced is null (#22)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not price the #22 measured DeepSeek run at Sonnet rates", () => {
    // Measured in #22: 1,334,017 in + 1,297,372 out on deepseek-v4-pro were
    // recorded as 2,349 cents — exactly Sonnet 4.6's $3/$15.
    const rate = resolveRate("anthropic", "deepseek-v4-pro", { config: configWith({}), env: {} });
    expect(rate).toBeNull();
    expect(computeCostCents(rate, { inputTokens: 1_334_017, outputTokens: 1_297_372 })).toBeNull();
  });

  it("prices a model from the administrator's MODEL_PRICES (USD per MTok)", () => {
    const config = configWith({
      MODEL_PRICES: JSON.stringify({
        "deepseek-v4-pro": { inputPerMTok: 1.32, outputPerMTok: 3.96, cacheReadPerMTok: 0.044 },
      }),
    });
    const rate = resolveRate("anthropic", "deepseek-v4-pro", { config, env: {} });
    expect(rate?.inputPer1k).toBeCloseTo(0.132, 12);
    expect(rate?.outputPer1k).toBeCloseTo(0.396, 12);
    expect(rate?.cacheReadPer1k).toBeCloseTo(0.0044, 12);
    // No cache-write price given → none invented (falls back to input at compute time).
    expect(rate?.cacheWritePer1k).toBeUndefined();
    // 1M in @ $1.32 + 1M out @ $3.96 = $5.28 = 528 cents.
    expect(computeCostCents(rate, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(528);
  });

  it("prefers a provider:model price over a bare model price", () => {
    const config = configWith({
      MODEL_PRICES: JSON.stringify({
        "m-1": { inputPerMTok: 1, outputPerMTok: 1 },
        "openai:m-1": { inputPerMTok: 9, outputPerMTok: 9 },
      }),
    });
    expect(resolveRate("openai", "m-1", { config, env: {} })?.inputPer1k).toBe(0.9);
    expect(resolveRate("anthropic", "m-1", { config, env: {} })?.inputPer1k).toBe(0.1);
    // No provider known (model-only caller): the bare key applies.
    expect(resolveRate(undefined, "m-1", { config, env: {} })?.inputPer1k).toBe(0.1);
  });

  it("lets an administrator's price replace a built-in one", () => {
    const config = configWith({
      MODEL_PRICES: JSON.stringify({ "gpt-4o": { inputPerMTok: 1, outputPerMTok: 2 } }),
    });
    expect(resolveRate("openai", "gpt-4o", { config, env: {} })?.inputPer1k).toBe(0.1);
  });

  it("never resolves a model id to an Object.prototype member", () => {
    const config = configWith({
      MODEL_PRICES: JSON.stringify({ "m-1": { inputPerMTok: 1, outputPerMTok: 1 } }),
    });
    expect(resolveRate("openai", "constructor", { config, env: {} })).toBeNull();
    expect(resolveRate(undefined, "toString", { config, env: {} })).toBeNull();
  });

  it("ignores a MODEL_PRICES value that does not validate rather than throwing", () => {
    const config = configWith({ MODEL_PRICES: "{not json" });
    expect(resolveRate("anthropic", "deepseek-v4-pro", { config, env: {} })).toBeNull();
    expect(resolveRate("openai", "gpt-4o", { config, env: {} })?.inputPer1k).toBe(0.25);
  });

  it("does not apply Anthropic list prices behind a third-party ANTHROPIC_BASE_URL", () => {
    // DeepSeek maps claude-haiku-* to deepseek-flash and bills its own price
    // (https://api-docs.deepseek.com/guides/anthropic_api).
    const env = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" };
    const config = configWith({});
    expect(resolveRate("anthropic", "claude-haiku-4-5", { config, env })).toBeNull();
    // ...but an administrator's price still applies there.
    const priced = configWith({
      MODEL_PRICES: JSON.stringify({
        "claude-haiku-4-5": { inputPerMTok: 0.3, outputPerMTok: 1.2 },
      }),
    });
    expect(resolveRate("anthropic", "claude-haiku-4-5", { config: priced, env })?.inputPer1k).toBe(
      0.03,
    );
    // Bedrock is unaffected by the anthropic provider's base URL.
    expect(
      resolveRate("bedrock-gateway", "us.anthropic.claude-sonnet-4-6", { config, env })?.inputPer1k,
    ).toBe(0.3);
  });

  it("treats api.anthropic.com (or no base URL) as Anthropic itself", () => {
    expect(isThirdPartyAnthropicEndpoint({})).toBe(false);
    expect(isThirdPartyAnthropicEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(
      false,
    );
    expect(isThirdPartyAnthropicEndpoint({ ANTHROPIC_BASE_URL: "http://localhost:8080" })).toBe(
      true,
    );
    expect(isThirdPartyAnthropicEndpoint({ ANTHROPIC_BASE_URL: "not a url" })).toBe(true);
    expect(
      resolveRate("anthropic", "claude-sonnet-4-6", {
        config: configWith({}),
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      })?.inputPer1k,
    ).toBe(0.3);
  });

  it("reads the process-wide config and env by default", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic");
    expect(getRate("anthropic", "claude-sonnet-4-6")).toBeNull();
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    vi.stubEnv(
      "MODEL_PRICES",
      JSON.stringify({ "x-model": { inputPerMTok: 2, outputPerMTok: 4 } }),
    );
    expect(getRate("anthropic", "x-model")?.outputPer1k).toBe(0.4);
  });

  it("prices each Claude family at its published rate, on any provider spelling", () => {
    // Opus 4 / 4.1 are $15/$75; Opus 4.5+ are $5/$25 (pricing page, 2026-09-21).
    expect(claudeFamilyRate("us.anthropic.claude-opus-4-20250514-v1:0")?.inputPer1k).toBe(1.5);
    expect(claudeFamilyRate("claude-opus-4-1")?.outputPer1k).toBe(7.5);
    expect(claudeFamilyRate("claude-opus-4-5")?.inputPer1k).toBe(0.5);
    expect(claudeFamilyRate("claude-opus-5")?.inputPer1k).toBe(0.5);
    // Sonnet 5 is $2/$10; earlier Sonnets $3/$15.
    expect(claudeFamilyRate("claude-sonnet-5")?.inputPer1k).toBe(0.2);
    expect(claudeFamilyRate("claude-sonnet-5")?.outputPer1k).toBe(1);
    expect(claudeFamilyRate("claude-sonnet-4-5-20250929")?.inputPer1k).toBe(0.3);
    expect(claudeFamilyRate("Claude-Haiku-v3")?.inputPer1k).toBe(0.1);
    expect(claudeFamilyRate("deepseek-v4-pro")).toBeUndefined();
    expect(claudeFamilyRate("gpt-4o")).toBeUndefined();
  });

  it("validates MODEL_PRICES writes", () => {
    expect(
      modelPricesSchema.safeParse('{"m": {"inputPerMTok": 1, "outputPerMTok": 2}}').success,
    ).toBe(true);
    expect(modelPricesSchema.safeParse({ m: { inputPerMTok: 1, outputPerMTok: 2 } }).success).toBe(
      true,
    );
    expect(modelPricesSchema.safeParse("{bad").success).toBe(false);
    expect(modelPricesSchema.safeParse({ m: { inputPerMTok: -1, outputPerMTok: 2 } }).success).toBe(
      false,
    );
    // Unknown fields are rejected so a typo (outputPerMtok) cannot silently price at 0.
    expect(modelPricesSchema.safeParse({ m: { inputPerMTok: 1, outputPerMtok: 2 } }).success).toBe(
      false,
    );
    expect(modelPricesSchema.safeParse({ "": { inputPerMTok: 1, outputPerMTok: 2 } }).success).toBe(
      false,
    );
  });
});
