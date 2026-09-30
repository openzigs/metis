/**
 * #512 — which adapters can run the ModelRouter's Claude tier ids as sent.
 * The Model card and auto-mode agent selection route on this answer, so a
 * non-Claude endpoint must say "no" and a Claude-serving one "yes".
 */
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic-provider.js";
import { BedrockDirectProvider } from "./bedrock-direct-provider.js";
import { HAIKU_MODEL_ID, SONNET_MODEL_ID } from "../model-router.js";

const direct = (providerKey: string, modelProfileMap?: Record<string, string>) =>
  new BedrockDirectProvider({
    baseUrl: "https://llm.example.com/v1",
    apiKey: "k",
    model: "configured-model",
    providerKey: providerKey as never,
    ...(modelProfileMap ? { modelProfileMap } : {}),
  });

describe("servesRouterModel (#512)", () => {
  it("Anthropic's own endpoint serves Claude tier ids", () => {
    const p = new AnthropicProvider({ apiKey: "k" });
    expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(true);
  });

  it("DeepSeek's Anthropic-compatible endpoint does not (it maps claude-* onto its own models)", () => {
    const p = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.deepseek.com/anthropic" });
    expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(false);
  });

  it("the Bedrock gateway serves Claude tier ids", () => {
    expect(direct("bedrock-gateway").servesRouterModel(SONNET_MODEL_ID)).toBe(true);
  });

  it.each(["openai", "azure", "local-gemma"])("%s does not serve an unmapped tier id", (key) => {
    expect(direct(key).servesRouterModel(SONNET_MODEL_ID)).toBe(false);
  });

  it("an OpenAI-compatible provider serves a tier id its modelProfileMap maps", () => {
    const p = direct("openai", { [HAIKU_MODEL_ID]: "gpt-4.1-mini" });
    expect(p.servesRouterModel(HAIKU_MODEL_ID)).toBe(true);
    expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(false);
  });
});
