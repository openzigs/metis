/**
 * #1277 — whether a fan-out should send one call first to write the prompt
 * cache before the rest go out in parallel.
 */
import { describe, expect, it } from "vitest";
import { needsPromptCacheWarmUp, estimatePromptTokens } from "./prompt-cache-warmup.js";
import type { ProviderKey } from "./types.js";

const prefixOf = (tokens: number) => "x".repeat(tokens * 4);
const provider = (key: ProviderKey, model: string, serves?: boolean) => ({
  key,
  model,
  ...(serves === undefined ? {} : { servesRouterModel: () => serves }),
});

describe("needsPromptCacheWarmUp", () => {
  it("warms a Claude prefix over the model minimum on Anthropic and on the Bedrock gateway", () => {
    expect(
      needsPromptCacheWarmUp(provider("anthropic", "claude-sonnet-5-5", true), prefixOf(600)),
    ).toBe(true);
    expect(
      needsPromptCacheWarmUp(
        provider("bedrock-gateway", "us.anthropic.claude-sonnet-5-5", true),
        prefixOf(600),
      ),
    ).toBe(true);
  });

  it("skips a prefix under the model minimum: it would not be cached at all", () => {
    // 512 on the 5.5 generation, 4,096 on Haiku 4.5.
    expect(needsPromptCacheWarmUp(provider("anthropic", "claude-haiku-5-5"), prefixOf(400))).toBe(
      false,
    );
    expect(needsPromptCacheWarmUp(provider("anthropic", "claude-haiku-4-5"), prefixOf(3_000))).toBe(
      false,
    );
    expect(needsPromptCacheWarmUp(provider("anthropic", "claude-haiku-4-5"), prefixOf(5_000))).toBe(
      true,
    );
  });

  // #1284 — a model id newer than the floor table must still warm up: the
  // fallback floor is the family's lowest, so a wrong guess costs a wait,
  // never a parallel cache write per batch.
  it("warms a made-up new Opus id with a typical section prefix", () => {
    expect(
      needsPromptCacheWarmUp(provider("anthropic", "claude-opus-6", true), prefixOf(1_500)),
    ).toBe(true);
    expect(
      needsPromptCacheWarmUp(
        provider("bedrock-gateway", "us.anthropic.claude-opus-6-1-v1:0", true),
        prefixOf(1_500),
      ),
    ).toBe(true);
  });

  it("skips DeepSeek, which caches automatically: by model id, and by endpoint", () => {
    expect(needsPromptCacheWarmUp(provider("anthropic", "deepseek-flash"), prefixOf(9_000))).toBe(
      false,
    );
    // DeepSeek's Anthropic-compatible endpoint maps claude-* names onto its own models.
    expect(
      needsPromptCacheWarmUp(provider("anthropic", "claude-sonnet-5-5", false), prefixOf(9_000)),
    ).toBe(false);
  });

  it("skips providers with no explicit prompt cache", () => {
    for (const key of ["local-gemma", "openai", "azure", "offline-stub"] as const) {
      expect(needsPromptCacheWarmUp(provider(key, "claude-sonnet-5-5"), prefixOf(9_000))).toBe(
        false,
      );
    }
  });
});

describe("estimatePromptTokens", () => {
  it("estimates about four characters per token, rounding up", () => {
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens("abcde")).toBe(2);
  });
});
