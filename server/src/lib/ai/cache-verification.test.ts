/**
 * Issue #697 — unit tests for the prompt-cache verification logic. Every case
 * uses synthetic usage payloads: NO live gateway, NO network, NO real provider.
 * Covers the two provider conventions that disagree on the prompt-token
 * denominator (OpenAI-compatible INCLUDES cached; Anthropic-native EXCLUDES it).
 */
import { describe, expect, it } from "vitest";
import {
  cacheFloorTokens,
  conventionForProvider,
  expectedCacheOutcome,
  normalizeAnthropicNativeUsage,
  normalizeOpenAICompatibleUsage,
  normalizeTokenUsage,
  summarizeCacheVerification,
  type NormalizedCacheUsage,
} from "./cache-verification.js";
import type { TokenUsage } from "./types.js";

describe("normalizeOpenAICompatibleUsage", () => {
  it("treats prompt_tokens as INCLUSIVE of cached tokens", () => {
    const n = normalizeOpenAICompatibleUsage({
      prompt_tokens: 2000,
      completion_tokens: 100,
      total_tokens: 2100,
      prompt_tokens_details: { cached_tokens: 1500 },
    });
    expect(n.totalPromptTokens).toBe(2000);
    expect(n.cacheReadTokens).toBe(1500);
    expect(n.freshInputTokens).toBe(500);
    expect(n.cacheWriteTokens).toBe(0);
    expect(n.cacheWriteReported).toBe(false);
  });

  it("reports zero reads when the details object is absent", () => {
    const n = normalizeOpenAICompatibleUsage({ prompt_tokens: 900 });
    expect(n.totalPromptTokens).toBe(900);
    expect(n.cacheReadTokens).toBe(0);
    expect(n.freshInputTokens).toBe(900);
  });

  it("tolerates null / undefined / empty payloads", () => {
    for (const raw of [null, undefined, {}]) {
      const n = normalizeOpenAICompatibleUsage(raw);
      expect(n).toMatchObject({
        totalPromptTokens: 0,
        freshInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWriteReported: false,
      });
    }
  });

  it("clamps a malformed read larger than the prompt so fresh never goes negative", () => {
    const n = normalizeOpenAICompatibleUsage({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 5000 },
    });
    expect(n.cacheReadTokens).toBe(1000);
    expect(n.freshInputTokens).toBe(0);
  });

  it("coerces negative / NaN counts to zero", () => {
    const n = normalizeOpenAICompatibleUsage({
      prompt_tokens: Number.NaN,
      prompt_tokens_details: { cached_tokens: -50 },
    });
    expect(n.totalPromptTokens).toBe(0);
    expect(n.cacheReadTokens).toBe(0);
  });
});

describe("normalizeAnthropicNativeUsage", () => {
  it("treats input_tokens as EXCLUSIVE of the cache fields", () => {
    const n = normalizeAnthropicNativeUsage({
      input_tokens: 300,
      output_tokens: 80,
      cache_read_input_tokens: 1500,
      cache_creation_input_tokens: 200,
    });
    // True total = fresh 300 + read 1500 + write 200.
    expect(n.totalPromptTokens).toBe(2000);
    expect(n.freshInputTokens).toBe(300);
    expect(n.cacheReadTokens).toBe(1500);
    expect(n.cacheWriteTokens).toBe(200);
    expect(n.cacheWriteReported).toBe(true);
  });

  it("reports writes on the cold call and reads on the warm call", () => {
    const cold = normalizeAnthropicNativeUsage({
      input_tokens: 200,
      cache_creation_input_tokens: 1800,
    });
    expect(cold.cacheWriteTokens).toBe(1800);
    expect(cold.cacheReadTokens).toBe(0);

    const warm = normalizeAnthropicNativeUsage({
      input_tokens: 200,
      cache_read_input_tokens: 1800,
    });
    expect(warm.cacheReadTokens).toBe(1800);
    expect(warm.cacheWriteTokens).toBe(0);
  });

  it("tolerates null / undefined payloads", () => {
    for (const raw of [null, undefined]) {
      const n = normalizeAnthropicNativeUsage(raw);
      expect(n.totalPromptTokens).toBe(0);
      expect(n.cacheWriteReported).toBe(true);
    }
  });
});

describe("normalizeTokenUsage", () => {
  const base: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  it("openai-compatible: promptTokens is inclusive, matching the gateway path", () => {
    const usage: TokenUsage = { ...base, promptTokens: 2000, cacheReadTokens: 1500 };
    const n = normalizeTokenUsage(usage, "openai-compatible");
    expect(n.totalPromptTokens).toBe(2000);
    expect(n.freshInputTokens).toBe(500);
    expect(n.cacheReadTokens).toBe(1500);
    expect(n.cacheWriteReported).toBe(false);
  });

  it("anthropic-native: promptTokens is exclusive, so cache tokens are added back", () => {
    const usage: TokenUsage = {
      ...base,
      promptTokens: 300,
      cacheReadTokens: 1500,
      cacheWriteTokens: 200,
    };
    const n = normalizeTokenUsage(usage, "anthropic-native");
    expect(n.totalPromptTokens).toBe(2000);
    expect(n.freshInputTokens).toBe(300);
    expect(n.cacheWriteReported).toBe(true);
  });

  it("the SAME numbers normalize differently per convention (the core gotcha)", () => {
    const usage: TokenUsage = { ...base, promptTokens: 1000, cacheReadTokens: 900 };
    const openai = normalizeTokenUsage(usage, "openai-compatible");
    const anthropic = normalizeTokenUsage(usage, "anthropic-native");
    expect(openai.totalPromptTokens).toBe(1000);
    expect(anthropic.totalPromptTokens).toBe(1900);
  });

  it("openai-compatible clamps reads that exceed promptTokens", () => {
    const usage: TokenUsage = { ...base, promptTokens: 500, cacheReadTokens: 900 };
    const n = normalizeTokenUsage(usage, "openai-compatible");
    expect(n.cacheReadTokens).toBe(500);
    expect(n.freshInputTokens).toBe(0);
  });

  it("defaults missing cache fields to zero", () => {
    const usage: TokenUsage = { ...base, promptTokens: 800 };
    const n = normalizeTokenUsage(usage, "openai-compatible");
    expect(n.cacheReadTokens).toBe(0);
    expect(n.freshInputTokens).toBe(800);
  });
});

describe("conventionForProvider", () => {
  it("maps the native anthropic provider to the exclusive convention", () => {
    expect(conventionForProvider("anthropic")).toBe("anthropic-native");
  });

  it("maps every gateway/openai-compatible key to the inclusive convention", () => {
    for (const key of [
      "bedrock-gateway",
      "openai",
      "azure",
      "local-gemma",
      "copilot-native",
    ] as const) {
      expect(conventionForProvider(key)).toBe("openai-compatible");
    }
  });
});

describe("summarizeCacheVerification", () => {
  const write = (n: number): NormalizedCacheUsage => ({
    totalPromptTokens: 2000,
    freshInputTokens: 2000 - n,
    cacheReadTokens: 0,
    cacheWriteTokens: n,
    cacheWriteReported: true,
  });
  const read = (n: number): NormalizedCacheUsage => ({
    totalPromptTokens: 2000,
    freshInputTokens: 2000 - n,
    cacheReadTokens: n,
    cacheWriteTokens: 0,
    cacheWriteReported: n === 0 ? false : true,
  });

  it("cache-confirmed when the measured call reports reads", () => {
    const r = summarizeCacheVerification({ warmup: write(1800), measured: read(1800) });
    expect(r.verdict).toBe("cache-confirmed");
    expect(r.cacheReadObserved).toBe(true);
    expect(r.hitRatio).toBeCloseTo(0.9, 5);
  });

  it("write-only when a write was reported but no read follows", () => {
    const r = summarizeCacheVerification({ warmup: write(1800), measured: read(0) });
    expect(r.verdict).toBe("write-only");
    expect(r.cacheWriteObserved).toBe(true);
    expect(r.cacheReadObserved).toBe(false);
    expect(r.hitRatio).toBe(0);
  });

  it("no-cache-observed when neither read nor write is reported (gateway silent-fail case)", () => {
    const noWrite: NormalizedCacheUsage = {
      totalPromptTokens: 2000,
      freshInputTokens: 2000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWriteReported: false,
    };
    const r = summarizeCacheVerification({ warmup: noWrite, measured: noWrite });
    expect(r.verdict).toBe("no-cache-observed");
    expect(r.cacheWriteObserved).toBe(false);
    expect(r.cacheReadObserved).toBe(false);
  });

  it("counts a read on the warm call even if the write call was silent", () => {
    const noWrite: NormalizedCacheUsage = {
      totalPromptTokens: 2000,
      freshInputTokens: 2000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWriteReported: false,
    };
    const r = summarizeCacheVerification({ warmup: noWrite, measured: read(1000) });
    expect(r.verdict).toBe("cache-confirmed");
    expect(r.hitRatio).toBeCloseTo(0.5, 5);
  });
});

describe("cacheFloorTokens", () => {
  it("Sonnet 4.6 is 1024 on Bedrock and 2048 on direct Anthropic", () => {
    expect(cacheFloorTokens("us.anthropic.claude-sonnet-4-6", "bedrock")).toBe(1024);
    expect(cacheFloorTokens("claude-sonnet-4-6", "anthropic")).toBe(2048);
  });

  it("Haiku 4.5 is 4096 on both platforms", () => {
    expect(cacheFloorTokens("us.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock")).toBe(4096);
    expect(cacheFloorTokens("claude-haiku-4-5", "anthropic")).toBe(4096);
  });

  it("legacy Sonnet 4.5 / Opus carry the 4096 floor on both platforms", () => {
    expect(cacheFloorTokens("us.anthropic.claude-sonnet-4-5", "bedrock")).toBe(4096);
    expect(cacheFloorTokens("claude-opus-4-6", "anthropic")).toBe(4096);
  });

  it("unknown Sonnet-family ids fall back to the platform-split floor", () => {
    expect(cacheFloorTokens("some-sonnet-model", "bedrock")).toBe(1024);
    expect(cacheFloorTokens("some-sonnet-model", "anthropic")).toBe(2048);
  });
});

describe("expectedCacheOutcome", () => {
  it("the ~2225-tok analysis prefix clears the Sonnet Bedrock floor", () => {
    expect(expectedCacheOutcome(2225, "us.anthropic.claude-sonnet-4-6", "bedrock")).toBe(
      "expected-hit",
    );
  });

  it("the ~2225-tok analysis prefix is below the Haiku 4096 floor → expected zero", () => {
    expect(
      expectedCacheOutcome(2225, "us.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock"),
    ).toBe("below-floor-expected-zero");
  });

  it("the same Sonnet prefix is below the higher 2048 direct-Anthropic floor at the low end", () => {
    expect(expectedCacheOutcome(1800, "claude-sonnet-4-6", "anthropic")).toBe(
      "below-floor-expected-zero",
    );
    expect(expectedCacheOutcome(2225, "claude-sonnet-4-6", "anthropic")).toBe("expected-hit");
  });

  it("coerces a NaN prefix to zero (below any floor)", () => {
    expect(expectedCacheOutcome(Number.NaN, "claude-sonnet-4-6", "bedrock")).toBe(
      "below-floor-expected-zero",
    );
  });
});
