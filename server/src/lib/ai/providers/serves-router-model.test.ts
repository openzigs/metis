/**
 * #512 — which adapters can run the ModelRouter's Claude tier ids as sent.
 * The Model card and auto-mode agent selection route on this answer, so a
 * non-Claude endpoint must say "no" and a Claude-serving one "yes".
 */
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic-provider.js";
import { BedrockDirectProvider } from "./bedrock-direct-provider.js";
import { HAIKU_MODEL_ID, ModelRouter, SONNET_MODEL_ID } from "../model-router.js";
import type { TaskProfile } from "../types.js";
import { ConfigService } from "../../config/config-service.js";

/** A ConfigService reading only the given env — no DB, no vault, no process.env. */
const configWith = (env: Record<string, string>) => new ConfigService({ env, vault: {} as never });

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

  // Adversarial panel on PR #523 — a proxy or gateway relaying to Anthropic is
  // a supported setup, opted into with ANTHROPIC_BASE_URL_BILLS_AS=anthropic
  // (the same setting pricing honours).
  describe("ANTHROPIC_BASE_URL_BILLS_AS opt-in", () => {
    const proxy = "https://llm-proxy.example.com/anthropic";

    it("a proxy host with the opt-in serves Claude tier ids", () => {
      const config = configWith({ ANTHROPIC_BASE_URL_BILLS_AS: "anthropic" });
      const p = new AnthropicProvider({ apiKey: "k", baseUrl: proxy, config });
      expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(true);
    });

    it.each([{}, { ANTHROPIC_BASE_URL_BILLS_AS: "auto" }])(
      "the same proxy host without the opt-in (%o) does not",
      (env) => {
        const p = new AnthropicProvider({ apiKey: "k", baseUrl: proxy, config: configWith(env) });
        expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(false);
      },
    );

    it("DeepSeek with the setting at something other than 'anthropic' does not", () => {
      const config = configWith({ ANTHROPIC_BASE_URL_BILLS_AS: "auto" });
      const p = new AnthropicProvider({
        apiKey: "k",
        baseUrl: "https://api.deepseek.com/anthropic",
        config,
      });
      expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(false);
    });

    it("reads the setting per call, so a tunable change applies without a restart", () => {
      const env: Record<string, string> = {};
      const p = new AnthropicProvider({ apiKey: "k", baseUrl: proxy, config: configWith(env) });
      expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(false);
      env.ANTHROPIC_BASE_URL_BILLS_AS = "anthropic";
      expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(true);
    });
  });

  it("the Bedrock gateway serves Claude tier ids", () => {
    expect(direct("bedrock-gateway").servesRouterModel(SONNET_MODEL_ID)).toBe(true);
  });

  it.each(["openai", "azure", "local-gemma"])("%s does not serve a Claude tier id", (key) => {
    expect(direct(key).servesRouterModel(SONNET_MODEL_ID)).toBe(false);
  });

  // Adversarial panel round 2 on PR #523 — modelProfileMap is built for every
  // provider, but only from the BEDROCK_*_PROFILE settings, so its values are
  // Bedrock inference-profile ARNs. A leftover entry must not make OpenAI,
  // Azure or a local runtime claim a Claude tier id.
  describe("a leftover Bedrock profile mapping", () => {
    const ARN = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.sonnet";
    const leftover = { [SONNET_MODEL_ID]: ARN, [HAIKU_MODEL_ID]: `${ARN}-haiku` };
    const complex: TaskProfile = {
      tokenEstimate: 10_000,
      reasoningDepth: "complex",
      latencySLA: "background",
      taskType: "synthesis",
    };

    it.each(["openai", "azure", "local-gemma"])("does not make %s serve the tier id", (key) => {
      const p = direct(key, leftover);
      expect(p.servesRouterModel(SONNET_MODEL_ID)).toBe(false);
      expect(p.servesRouterModel(HAIKU_MODEL_ID)).toBe(false);
    });

    it("the Model card and the run use openai's configured model, not the ARN", () => {
      const router = new ModelRouter({ provider: direct("openai", leftover) });
      const card = router.select(complex);
      expect(card.modelId).toBe("configured-model");
      expect(card.estimatedCost).toBeNull();
      expect(router.resolveRunModel("force-sonnet")).toBe("configured-model");
      expect(JSON.stringify(card)).not.toContain("arn:aws:bedrock");
    });

    it("the Bedrock gateway still serves the mapped tier id", () => {
      const gateway = direct("bedrock-gateway", leftover);
      expect(gateway.servesRouterModel(SONNET_MODEL_ID)).toBe(true);
      const router = new ModelRouter({ provider: gateway });
      expect(router.select(complex).modelId).toBe(SONNET_MODEL_ID);
      expect(router.resolveRunModel("force-sonnet")).toBe(SONNET_MODEL_ID);
    });
  });
});
