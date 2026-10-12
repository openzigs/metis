/**
 * #1080 — Claude Sonnet 5.5, Haiku 5.5 and Opus 5.5 are priced at their
 * published prices, and Haiku 5.5's prompt-length tier is applied PER REQUEST.
 *
 * Prices: https://platform.claude.com/docs/en/about-claude/pricing, read
 * 2026-10-11 (USD per MTok):
 *
 *   Sonnet 5.5                 $2    in / $10   out / $0.10 read / $2.50  write
 *   Opus 5.5                   $4    in / $20   out / $0.20 read / $5     write
 *   Haiku 5.5, prompt ≤ 100k   $0.10 in / $0.50 out / $0.01 read / $0.125 write
 *   Haiku 5.5, prompt > 100k   $0.50 in / $2.50 out / $0.05 read / $0.625 write
 *
 * "A request's prompt length counts all of its input tokens, including cache
 * reads and cache writes. Each request is priced on its own."
 *
 * Every expected figure below is worked by hand from that table, never
 * derived from the code under test. Nothing here calls a model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenUsageCreate = vi.fn(async (_: unknown) => ({}));
const aiTokenUsageCreate = vi.fn(async (_: unknown) => ({}));

vi.mock("../prisma.js", () => ({
  prisma: {
    tokenUsage: { create: (a: unknown) => tokenUsageCreate(a) },
    aITokenUsage: { create: (a: unknown) => aiTokenUsageCreate(a) },
  },
}));

import { ConfigService } from "../config/config-service.js";
import { TokenTracker, estimateUsageCostUsd, usagePromptTier } from "../ai/token-tracker.js";
import {
  HAIKU_5_5_LONG_PROMPT_TOKENS,
  claudeFamilyRate,
  computeCostCents,
  computeCostCentsExact,
  isLongPrompt,
  resolveRate,
  tierRate,
} from "./provider-rates.js";
import {
  canonicalTokenCounts,
  priceCanonicalTokensExact,
  recordUsageAndFlush,
} from "./token-tracker.js";

const configWith = (env: Record<string, string>) => new ConfigService({ env, vault: {} as never });
const builtin = (model: string, provider = "anthropic") =>
  resolveRate(provider, model, { config: configWith({}), env: {} })!;

beforeEach(() => {
  tokenUsageCreate.mockClear();
  aiTokenUsageCreate.mockClear();
  // A third-party ANTHROPIC_BASE_URL would unprice the anthropic rows, and an
  // operator's MODEL_PRICES would replace them.
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  vi.stubEnv("MODEL_PRICES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#1080 the 5.5 models have explicit prices", () => {
  it("prices 1M in / 1M out / 1M cache read / 1M cache write at the published figures", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    // Sonnet 5.5: $2 + $10 + $0.10 + $2.50 = $14.60.
    expect(computeCostCentsExact(builtin("claude-sonnet-5-5"), usage)).toBeCloseTo(1460, 6);
    // Opus 5.5: $4 + $20 + $0.20 + $5 = $29.20.
    expect(computeCostCentsExact(builtin("claude-opus-5-5"), usage)).toBeCloseTo(2920, 6);
  });

  it("no longer prices them as the older generation the family match gave", () => {
    // Before: Haiku 4.5's $1 in, Opus 4.5+'s $5 in, Sonnet 5's $0.20 cache read.
    expect(builtin("claude-haiku-5-5").inputPer1k).toBeCloseTo(0.01, 12);
    expect(builtin("claude-opus-5-5").inputPer1k).toBeCloseTo(0.4, 12);
    expect(builtin("claude-sonnet-5-5").cacheReadPer1k).toBeCloseTo(0.01, 12);
  });

  it("leaves the neighbouring generations where they were", () => {
    expect(claudeFamilyRate("claude-opus-5")?.inputPer1k).toBe(0.5);
    expect(claudeFamilyRate("claude-sonnet-5")?.cacheReadPer1k).toBe(0.02);
    expect(claudeFamilyRate("claude-haiku-4-5")?.inputPer1k).toBe(0.1);
    expect(claudeFamilyRate("claude-opus-5")?.longPrompt).toBeUndefined();
    expect(builtin("claude-sonnet-5-5").longPrompt).toBeUndefined();
    expect(builtin("claude-opus-5-5").longPrompt).toBeUndefined();
  });

  it("prices a dated or Bedrock spelling of a 5.5 id the same way", () => {
    expect(claudeFamilyRate("claude-opus-5-5-20260922")?.outputPer1k).toBeCloseTo(2, 12);
    expect(claudeFamilyRate("global.anthropic.claude-sonnet-5-5")?.cacheReadPer1k).toBeCloseTo(
      0.01,
      12,
    );
    // A geo profile bills at Bedrock's Regional SKU, 1.1x — both tiers.
    const regional = claudeFamilyRate("us.anthropic.claude-haiku-5-5")!;
    expect(regional.inputPer1k).toBeCloseTo(0.011, 12);
    expect(regional.longPrompt?.overPromptTokens).toBe(100_000);
    expect(regional.longPrompt?.rate.inputPer1k).toBeCloseTo(0.055, 12);
    expect(regional.longPrompt?.rate.outputPer1k).toBeCloseTo(0.275, 12);
  });
});

describe("#1080 Haiku 5.5 bills each request in one prompt-length tier", () => {
  const haiku = () => builtin("claude-haiku-5-5");

  it("the threshold is 100,000 prompt tokens", () => {
    expect(HAIKU_5_5_LONG_PROMPT_TOKENS).toBe(100_000);
    expect(haiku().longPrompt?.overPromptTokens).toBe(100_000);
  });

  it("exactly 100,000 prompt tokens bills at the lower prices", () => {
    // 100,000 × $0.10/M = $0.01; 1,000 out × $0.50/M = $0.0005 → 1.05¢.
    const usage = { inputTokens: 100_000, outputTokens: 1_000 };
    expect(isLongPrompt(haiku(), usage)).toBe(false);
    expect(computeCostCentsExact(haiku(), usage)).toBeCloseTo(1.05, 9);
  });

  it("100,001 prompt tokens bills the WHOLE request at the higher prices, output included", () => {
    // 100,001 × $0.50/M = $0.0500005; 1,000 out × $2.50/M = $0.0025 → 5.25005¢.
    const usage = { inputTokens: 100_001, outputTokens: 1_000 };
    expect(isLongPrompt(haiku(), usage)).toBe(true);
    expect(computeCostCentsExact(haiku(), usage)).toBeCloseTo(5.25005, 9);
  });

  it("counts cache reads and cache writes toward the prompt, on both sides of the boundary", () => {
    // 40,000 + 50,000 + 10,000 = 100,000 → lower prices:
    // 40,000 × $0.10/M + 50,000 × $0.01/M + 10,000 × $0.125/M = 0.4¢ + 0.05¢ + 0.125¢.
    const at = {
      inputTokens: 40_000,
      outputTokens: 0,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 10_000,
    };
    expect(computeCostCentsExact(haiku(), at)).toBeCloseTo(0.575, 9);
    // One more cache-read token → 100,001 → higher prices, cache hit or not:
    // 40,000 × $0.50/M + 50,001 × $0.05/M + 10,000 × $0.625/M = 2¢ + 0.250005¢ + 0.625¢.
    const over = { ...at, cacheReadTokens: 50_001 };
    expect(computeCostCentsExact(haiku(), over)).toBeCloseTo(2.875005, 9);
    // …and one more cache-WRITE token does the same.
    expect(isLongPrompt(haiku(), { ...at, cacheWriteTokens: 10_001 })).toBe(true);
  });

  it("does not count output tokens toward the prompt", () => {
    // 90,000 in × $0.10/M + 50,000 out × $0.50/M = 0.9¢ + 2.5¢.
    const usage = { inputTokens: 90_000, outputTokens: 50_000 };
    expect(isLongPrompt(haiku(), usage)).toBe(false);
    expect(computeCostCentsExact(haiku(), usage)).toBeCloseTo(3.4, 9);
  });

  it("rounds the tiered cost to whole cents like any other", () => {
    // 5.25005¢ → 5¢; 1.05¢ → 1¢.
    expect(computeCostCents(haiku(), { inputTokens: 100_001, outputTokens: 1_000 })).toBe(5);
    expect(computeCostCents(haiku(), { inputTokens: 100_000, outputTokens: 1_000 })).toBe(1);
  });

  it("tierRate names one tier as a flat rate that is never re-decided", () => {
    const standard = tierRate(haiku(), false);
    const long = tierRate(haiku(), true);
    expect(standard).toEqual({
      inputPer1k: 0.01,
      outputPer1k: 0.05,
      cacheReadPer1k: 0.001,
      cacheWritePer1k: 0.0125,
    });
    expect(long).toEqual({
      inputPer1k: 0.05,
      outputPer1k: 0.25,
      cacheReadPer1k: 0.005,
      cacheWritePer1k: 0.0625,
    });
    // 300,000 tokens summed over three 100,000-token requests: still the lower prices.
    expect(computeCostCentsExact(standard, { inputTokens: 300_000, outputTokens: 0 })).toBeCloseTo(
      3,
      9,
    );
    // A rate with no tier is returned as it is, whichever tier is asked for.
    const sonnet = builtin("claude-sonnet-5-5");
    expect(tierRate(sonnet, true)).toBe(sonnet);
    expect(isLongPrompt(sonnet, { inputTokens: 900_000, outputTokens: 0 })).toBe(false);
  });
});

describe("#1080 the tier reaches every per-call cost that is stored", () => {
  async function ledgerCost(input: number, cacheRead = 0): Promise<unknown> {
    tokenUsageCreate.mockClear();
    await recordUsageAndFlush({
      projectId: "p-1",
      sessionId: "s-1",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: input,
      outputTokens: 1_000,
      cacheReadTokens: cacheRead,
    });
    return (tokenUsageCreate.mock.calls[0]?.[0] as { data: { costUsd: unknown } }).data.costUsd;
  }

  it("token_usages.costUsd (recordUsage) is priced per call, on both sides of the boundary", async () => {
    expect(await ledgerCost(100_000)).toBeCloseTo(0.0105, 12);
    expect(await ledgerCost(100_001)).toBeCloseTo(0.0525005, 12);
    // Native Anthropic reports cache reads apart from input: 60,000 + 40,001 = 100,001.
    // 60,000 × $0.50/M + 40,001 × $0.05/M + 1,000 × $2.50/M = 3¢ + 0.200005¢ + 0.25¢.
    expect(await ledgerCost(60_000, 40_001)).toBeCloseTo(0.03450005, 12);
  });

  it("ai_token_usages.estimatedCostUsd (TokenTracker) agrees with the ledger", async () => {
    for (const [input, usd] of [
      [100_000, 0.0105],
      [100_001, 0.0525005],
    ] as const) {
      aiTokenUsageCreate.mockClear();
      await new TokenTracker().recordAndFlush({
        sessionId: "s-1",
        userId: "u-1",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        usage: { promptTokens: input, completionTokens: 1_000 },
      });
      const row = aiTokenUsageCreate.mock.calls[0]?.[0] as { data: { estimatedCostUsd: number } };
      expect(row.data.estimatedCostUsd).toBeCloseTo(usd, 12);
    }
  });

  it("a ledger row re-priced for the budget ceiling is priced on its own prompt", () => {
    // What `projectMonthlyCostForCeiling` does per row whose stored cost is NULL.
    const reprice = (inputTokens: number) =>
      priceCanonicalTokensExact(
        builtin("claude-haiku-5-5"),
        canonicalTokenCounts("anthropic", {
          inputTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      );
    expect(reprice(100_000)).toBeCloseTo(1, 9);
    expect(reprice(100_001)).toBeCloseTo(5.00005, 9);
  });

  it("on the gateway convention the prompt count already holds the cache reads — counted once", () => {
    // prompt_tokens 100,000 of which 60,000 were cache reads: a 100,000-token
    // prompt, not 160,000 → lower prices at the Regional SKU (1.1x):
    // 40,000 × $0.11/M + 60,000 × $0.011/M = 0.44¢ + 0.066¢.
    const model = "us.anthropic.claude-haiku-5-5";
    const usage = { promptTokens: 100_000, completionTokens: 0, cacheReadTokens: 60_000 };
    expect(usagePromptTier(model, usage, "bedrock-gateway")).toBe("standard");
    expect(estimateUsageCostUsd(model, usage, "bedrock-gateway")).toBeCloseTo(0.00506, 12);
    // 100,001 prompt tokens → higher prices: 40,001 × $0.55/M + 60,000 × $0.055/M.
    const over = { ...usage, promptTokens: 100_001 };
    expect(usagePromptTier(model, over, "bedrock-gateway")).toBe("long");
    expect(estimateUsageCostUsd(model, over, "bedrock-gateway")).toBeCloseTo(
      // $0.02200055 + $0.0033
      0.02530055,
      12,
    );
  });

  it("the 1-hour cache write is 2x the input price of the tier the request is in", () => {
    // 10,000 in + 20,000 written = 30,000 → lower: 10,000 × $0.10/M + 20,000 × $0.20/M.
    expect(
      estimateUsageCostUsd(
        "claude-haiku-5-5",
        { promptTokens: 10_000, completionTokens: 0, cacheWriteTokens: 20_000 },
        "anthropic",
        "1h",
      ),
    ).toBeCloseTo(0.005, 12);
    // 90,000 in + 20,000 written = 110,000 → higher: 90,000 × $0.50/M + 20,000 × $1/M.
    expect(
      estimateUsageCostUsd(
        "claude-haiku-5-5",
        { promptTokens: 90_000, completionTokens: 0, cacheWriteTokens: 20_000 },
        "anthropic",
        "1h",
      ),
    ).toBeCloseTo(0.065, 12);
  });

  it("a caller pricing summed requests names the tier instead of having it re-decided", () => {
    // Three 60,000-token requests summed: 180,000 tokens, every one of them short.
    const summed = { promptTokens: 180_000, completionTokens: 0 };
    expect(
      estimateUsageCostUsd("claude-haiku-5-5", summed, "anthropic", "5m", "standard"),
    ).toBeCloseTo(0.018, 12);
    expect(estimateUsageCostUsd("claude-haiku-5-5", summed, "anthropic", "5m", "long")).toBeCloseTo(
      0.09,
      12,
    );
    // An unpriced model, or one with no tier, is always "standard".
    expect(usagePromptTier("deepseek-flash", summed, "anthropic")).toBe("standard");
    expect(usagePromptTier("claude-sonnet-5-5", summed, "anthropic")).toBe("standard");
  });
});

describe("#1080 MODEL_PRICES against a built-in rate — the administrator's price wins", () => {
  const prices = (value: unknown) => configWith({ MODEL_PRICES: JSON.stringify(value) });

  it("an entry for a model with a built-in rate replaces it", () => {
    const config = prices({ "claude-opus-5-5": { inputPerMTok: 1, outputPerMTok: 2 } });
    const rate = resolveRate("anthropic", "claude-opus-5-5", { config, env: {} })!;
    expect(rate.inputPer1k).toBeCloseTo(0.1, 12);
    expect(rate.outputPer1k).toBeCloseTo(0.2, 12);
    // The built-in cache prices do not leak into the override: with none of its
    // own, a cache read bills at the override's input price.
    expect(rate.cacheReadPer1k).toBeUndefined();
    // A model the entry does not name keeps its built-in rate.
    expect(resolveRate("anthropic", "claude-sonnet-5-5", { config, env: {} })?.inputPer1k).toBe(
      0.2,
    );
  });

  it("an entry for Haiku 5.5 is flat: it replaces BOTH built-in tiers", () => {
    const config = prices({ "claude-haiku-5-5": { inputPerMTok: 9, outputPerMTok: 9 } });
    const rate = resolveRate("anthropic", "claude-haiku-5-5", { config, env: {} })!;
    expect(rate.longPrompt).toBeUndefined();
    // 200,000 prompt tokens at $9/M = $1.80, with no long-prompt uplift…
    expect(computeCostCentsExact(rate, { inputTokens: 200_000, outputTokens: 0 })).toBeCloseTo(
      180,
      9,
    );
    // …and 50,000 at the same price.
    expect(computeCostCentsExact(rate, { inputTokens: 50_000, outputTokens: 0 })).toBeCloseTo(
      45,
      9,
    );
  });

  it("a provider-qualified entry beats a bare one, and both beat the built-in", () => {
    const config = prices({
      "claude-haiku-5-5": { inputPerMTok: 9, outputPerMTok: 9 },
      "anthropic:claude-haiku-5-5": { inputPerMTok: 7, outputPerMTok: 7 },
    });
    expect(
      resolveRate("anthropic", "claude-haiku-5-5", { config, env: {} })?.inputPer1k,
    ).toBeCloseTo(0.7, 12);
    expect(
      resolveRate("bedrock-gateway", "claude-haiku-5-5", { config, env: {} })?.inputPer1k,
    ).toBeCloseTo(0.9, 12);
  });

  // PR #1092 review — usage is recorded under the id the API reports back
  // (`anthropic-provider.ts`: `message.model ?? model`), which can be the dated
  // spelling of the alias the administrator priced.
  describe("an entry keyed on the alias also prices the dated and region-prefixed spellings", () => {
    const alias = prices({ "claude-haiku-5-5": { inputPerMTok: 9, outputPerMTok: 9 } });
    const input = (provider: string | undefined, model: string, config = alias) =>
      resolveRate(provider, model, { config, env: {} })?.inputPer1k;

    it("applies to the dated id, the Bedrock ids and a mixed-case id — flat, no tier", () => {
      for (const [provider, model] of [
        ["anthropic", "claude-haiku-5-5-20261007"],
        ["bedrock-gateway", "us.anthropic.claude-haiku-5-5-20261007-v1:0"],
        ["bedrock-gateway", "eu.anthropic.claude-haiku-5-5"],
        ["bedrock-gateway", "global.anthropic.claude-haiku-5-5-20261007-v1:0"],
        ["bedrock-gateway", "anthropic.claude-haiku-5-5"],
        ["anthropic", "Claude-Haiku-5-5-20261007"],
        [undefined, "claude-haiku-5-5-20261007"],
      ] as const) {
        const rate = resolveRate(provider, model, { config: alias, env: {} })!;
        expect(rate.inputPer1k, model).toBeCloseTo(0.9, 12);
        expect(rate.longPrompt, model).toBeUndefined();
      }
    });

    it("an exact entry for the dated id still wins over the alias entry", () => {
      const config = prices({
        "claude-haiku-5-5": { inputPerMTok: 9, outputPerMTok: 9 },
        "claude-haiku-5-5-20261007": { inputPerMTok: 3, outputPerMTok: 3 },
      });
      expect(input("anthropic", "claude-haiku-5-5-20261007", config)).toBeCloseTo(0.3, 12);
      // …and it does not travel the other way: the alias keeps its own entry.
      expect(input("anthropic", "claude-haiku-5-5", config)).toBeCloseTo(0.9, 12);
    });

    it("order of precedence: exact provider:model, exact model, provider:alias, alias", () => {
      const dated = "claude-haiku-5-5-20261007";
      const all = {
        [`anthropic:${dated}`]: { inputPerMTok: 1, outputPerMTok: 1 },
        [dated]: { inputPerMTok: 2, outputPerMTok: 2 },
        "anthropic:claude-haiku-5-5": { inputPerMTok: 3, outputPerMTok: 3 },
        "claude-haiku-5-5": { inputPerMTok: 4, outputPerMTok: 4 },
      };
      const without = (...keys: string[]) =>
        prices(Object.fromEntries(Object.entries(all).filter(([k]) => !keys.includes(k))));
      expect(input("anthropic", dated, prices(all))).toBeCloseTo(0.1, 12);
      expect(input("anthropic", dated, without(`anthropic:${dated}`))).toBeCloseTo(0.2, 12);
      expect(input("anthropic", dated, without(`anthropic:${dated}`, dated))).toBeCloseTo(0.3, 12);
      expect(
        input(
          "anthropic",
          dated,
          without(`anthropic:${dated}`, dated, "anthropic:claude-haiku-5-5"),
        ),
      ).toBeCloseTo(0.4, 12);
    });

    it("never reaches a different model", () => {
      // An entry for Haiku 5 must not price Haiku 5.5, in any spelling: the
      // built-in Haiku 5.5 price ($0.10 → 0.01¢/1k, or 0.011 at Bedrock's
      // Regional SKU) still applies.
      const haiku5 = prices({ "claude-haiku-5": { inputPerMTok: 9, outputPerMTok: 9 } });
      for (const [model, builtIn] of [
        ["claude-haiku-5-5", 0.01],
        ["claude-haiku-5-5-20261007", 0.01],
        ["us.anthropic.claude-haiku-5-5-20261007-v1:0", 0.011],
      ] as const) {
        expect(
          resolveRate("anthropic", model, { config: haiku5, env: {} })?.longPrompt,
          model,
        ).toBeDefined();
        expect(input(undefined, model, haiku5), model).toBeCloseTo(builtIn, 12);
      }
      // …but it does price Haiku 5's own dated id.
      expect(input("anthropic", "claude-haiku-5-20260601", haiku5)).toBeCloseTo(0.9, 12);
      // An entry for Haiku 5.5 does not price Haiku 5, a longer id, or a
      // non-Claude model.
      expect(input("anthropic", "claude-haiku-5")).toBeCloseTo(0.1, 12); // Haiku 4.5 family price
      expect(input("anthropic", "claude-haiku-5-20260601")).toBeCloseTo(0.1, 12);
      expect(input("anthropic", "claude-haiku-5-50")).toBeCloseTo(0.1, 12);
      expect(input("anthropic", "claude-haiku-5-5-preview")).toBeCloseTo(0.01, 12); // built-in
      expect(input("openai", "deepseek-flash")).toBeUndefined();
    });

    it("leaves an id with nothing to strip exactly as it was: deepseek-flash", () => {
      const config = prices({ "deepseek-flash": { inputPerMTok: 5, outputPerMTok: 5 } });
      expect(input("openai", "deepseek-flash", config)).toBeCloseTo(0.5, 12);
      // Not a spelling of it: a different DeepSeek model stays unpriced.
      expect(input("openai", "deepseek-flash-lite", config)).toBeUndefined();
      expect(input("openai", "deepseek-v4-pro", config)).toBeUndefined();
    });

    it("is what a call recorded under the dated id is billed at", async () => {
      vi.stubEnv(
        "MODEL_PRICES",
        JSON.stringify({ "claude-haiku-5-5": { inputPerMTok: 9, outputPerMTok: 9 } }),
      );
      tokenUsageCreate.mockClear();
      await recordUsageAndFlush({
        projectId: "p-1",
        sessionId: "s-1",
        provider: "anthropic",
        model: "claude-haiku-5-5-20261007",
        inputTokens: 200_000,
        outputTokens: 0,
      });
      const row = tokenUsageCreate.mock.calls[0]?.[0] as { data: { costUsd: number } };
      // 200,000 × $9/M = $1.80 — not the built-in long-prompt 200,000 × $0.50/M = $0.10.
      expect(row.data.costUsd).toBeCloseTo(1.8, 12);
    });
  });

  it("an invalid MODEL_PRICES value is ignored and the built-in rate applies", () => {
    const config = configWith({ MODEL_PRICES: "{not json" });
    const rate = resolveRate("anthropic", "claude-haiku-5-5", { config, env: {} })!;
    expect(rate.inputPer1k).toBeCloseTo(0.01, 12);
    expect(rate.longPrompt?.rate.inputPer1k).toBeCloseTo(0.05, 12);
  });

  it("the override is what a recorded call is billed at", async () => {
    vi.stubEnv(
      "MODEL_PRICES",
      JSON.stringify({ "claude-haiku-5-5": { inputPerMTok: 9, outputPerMTok: 9 } }),
    );
    tokenUsageCreate.mockClear();
    await recordUsageAndFlush({
      projectId: "p-1",
      sessionId: "s-1",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 200_000,
      outputTokens: 0,
    });
    const row = tokenUsageCreate.mock.calls[0]?.[0] as { data: { costUsd: number } };
    expect(row.data.costUsd).toBeCloseTo(1.8, 12);
  });
});
