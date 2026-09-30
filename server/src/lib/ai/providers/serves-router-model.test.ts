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

  // Review of PR #523 — an unknown adapter counts as "cannot serve"; so does an
  // unknown Anthropic-compatible host (a proxy or another vendor).
  it("Anthropic's API named explicitly serves Claude tier ids", () => {
    const p = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com" });
    expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(true);
  });

  it.each([
    "https://llm-proxy.example.com/anthropic",
    "https://api.anthropic.com.evil.test",
    "not a url",
  ])("an Anthropic-compatible endpoint that is not Anthropic's API (%s) does not", (baseUrl) => {
    const p = new AnthropicProvider({ apiKey: "k", baseUrl });
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
