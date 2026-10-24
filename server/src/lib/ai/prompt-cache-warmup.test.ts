/**
 * #1277 — whether a fan-out should send one call first to write the prompt
 * cache before the rest go out in parallel.
 */
import { describe, expect, it } from "vitest";
import {
  estimatePromptTokens,
  hasExplicitPromptCache,
  needsPrefixCacheWarmUp,
  needsPromptCacheWarmUp,
  PREFIX_WARM_UP_MAX_TOKENS,
  PREFIX_WARM_UP_MIN_TOKENS,
} from "./prompt-cache-warmup.js";
import { scopedToGeneration } from "../docs-gen/generation-control.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "./providers/bedrock-direct-provider.js";
import type { AIProvider, ProviderKey } from "./types.js";

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

describe("hasExplicitPromptCache (#1329)", () => {
  it("is a Claude model on native Anthropic or the Bedrock gateway, served as named", () => {
    expect(hasExplicitPromptCache(provider("anthropic", "claude-sonnet-5-5"))).toBe(true);
    expect(hasExplicitPromptCache(provider("bedrock-gateway", "us.anthropic.claude-x", true))).toBe(
      true,
    );
    expect(hasExplicitPromptCache(provider("anthropic", "claude-sonnet-5-5", false))).toBe(false);
    expect(hasExplicitPromptCache(provider("anthropic", "deepseek-flash"))).toBe(false);
    expect(hasExplicitPromptCache(provider("openai", "claude-sonnet-5-5"))).toBe(false);
  });
});

describe("needsPrefixCacheWarmUp (#1329)", () => {
  const lead = (tokens: number) => "x".repeat(tokens * 4);

  // PR #1516 review — the cache is DeepSeek's API's, so the gate is the host the
  // adapter points at, never the model id.
  const anthropicAt = (baseUrl: string | undefined) =>
    new AnthropicProvider({
      apiKey: "k",
      model: "deepseek-flash",
      ...(baseUrl ? { baseUrl } : {}),
    });
  const openAiAt = (baseUrl: string, providerKey: ProviderKey) =>
    new OpenAICompatibleProvider({ baseUrl, apiKey: "k", model: "deepseek-flash", providerKey });

  it("warms a lead at or over the minimum on an adapter pointed at DeepSeek's own API", () => {
    for (const p of [
      anthropicAt("https://api.deepseek.com/anthropic"),
      openAiAt("https://api.deepseek.com/v1", "openai"),
    ]) {
      expect(p.deepSeekPrefixCache).toBe(true);
      expect(needsPrefixCacheWarmUp(p, lead(PREFIX_WARM_UP_MIN_TOKENS))).toBe(true);
    }
    // Docs-gen reaches the adapter through the run's generation proxy.
    expect(
      scopedToGeneration(anthropicAt("https://api.deepseek.com/anthropic")).deepSeekPrefixCache,
    ).toBe(true);
    // A Claude alias sent to DeepSeek's endpoint is DeepSeek's cache too.
    expect(
      needsPrefixCacheWarmUp(
        new AnthropicProvider({
          apiKey: "k",
          model: "claude-haiku-4-5",
          baseUrl: "https://api.deepseek.com/anthropic",
        }),
        lead(PREFIX_WARM_UP_MIN_TOKENS),
      ),
    ).toBe(true);
  });

  it("never warms a DeepSeek model served by another host: the gateway, Azure, Anthropic, a local runtime", () => {
    for (const p of [
      openAiAt("https://gateway.example.internal/api/v1", "bedrock-gateway"),
      openAiAt("https://contoso.openai.azure.com/openai/v1", "openai"),
      openAiAt("https://openrouter.ai/api/v1", "openai"),
      openAiAt("http://127.0.0.1:11434/v1", "local-gemma"),
      anthropicAt(undefined),
    ]) {
      expect(p.deepSeekPrefixCache).toBe(false);
      expect(needsPrefixCacheWarmUp(p, lead(50_000))).toBe(false);
    }
    // A test double that does not declare it is not DeepSeek's API either.
    const undeclared: Pick<AIProvider, "deepSeekPrefixCache"> = {};
    expect(needsPrefixCacheWarmUp(undeclared, lead(50_000))).toBe(false);
  });

  it("skips a lead under the minimum", () => {
    expect(
      needsPrefixCacheWarmUp({ deepSeekPrefixCache: true }, lead(PREFIX_WARM_UP_MIN_TOKENS - 1)),
    ).toBe(false);
  });

  it("caps the warm-up's reply at one token", () => {
    expect(PREFIX_WARM_UP_MAX_TOKENS).toBe(1);
  });
});
