/**
 * Epic #108 (#113) — provider selection / factory guard.
 *
 * Proves:
 *   • Selecting `bedrock-gateway` still builds the direct OpenAI-compatible
 *     provider with the Bedrock default model (regression — Bedrock unbroken).
 *   • Selecting `local-gemma` builds the direct provider with `gemma4:12b`.
 *   • Toggling `AI_PROVIDER` via env switches the built provider + default
 *     model each way.
 *   • The factory guard never routes `local-gemma`/`bedrock-gateway` into the
 *     Copilot SDK wrapper — even if it reaches `buildProvider` directly — and
 *     fails fast when the resolved sdkProvider config is missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/config/config-service.js", () => ({
  getConfigService: () => {
    throw new Error("no config service in this test");
  },
}));

import { loadAIConfig, type AIConfig } from "../../../src/lib/ai/config.js";
import { buildProvider } from "../../../src/lib/ai/providers/factory.js";
import {
  OpenAICompatibleProvider,
  BedrockDirectProvider,
} from "../../../src/lib/ai/providers/openai-compatible-provider.js";
import { AIProviderError } from "../../../src/lib/ai/errors.js";
import type { AIProvider } from "../../../src/lib/ai/types.js";

const BEDROCK_ENV = {
  AI_PROVIDER: "bedrock-gateway",
  BEDROCK_GATEWAY_URL: "https://gateway.internal.example.com",
  BEDROCK_GATEWAY_API_KEY: "bedrock-key",
  BEDROCK_ALLOWED_HOSTS: "gateway.internal.example.com",
} as const;

const GEMMA_ENV = {
  AI_PROVIDER: "local-gemma",
  LOCAL_GEMMA_BASE_URL: "http://localhost:11434/v1",
} as const;

/**
 * Mirror the provider-construction interception in `server.ts` (~L117) and
 * `routes/analysis.ts` (~L98): both `bedrock-gateway` and `local-gemma` build
 * the direct OpenAI-compatible provider instead of the SDK.
 */
function selectProvider(cfg: AIConfig): AIProvider {
  if ((cfg.provider === "bedrock-gateway" || cfg.provider === "local-gemma") && cfg.sdkProvider) {
    return new BedrockDirectProvider({
      baseUrl: cfg.sdkProvider.baseUrl,
      apiKey: cfg.sdkProvider.apiKey ?? "",
      model: cfg.model,
      providerKey: cfg.provider,
      modelProfileMap: cfg.modelProfileMap,
    });
  }
  return buildProvider({ config: cfg });
}

const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv;
  vi.restoreAllMocks();
});

describe("provider selection via route interception (#113)", () => {
  it("bedrock-gateway builds the direct provider with the Bedrock default model", () => {
    const cfg = loadAIConfig({ ...BEDROCK_ENV });
    const provider = selectProvider(cfg);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.key).toBe("bedrock-gateway");
    expect(provider.model).toBe("us.anthropic.claude-sonnet-5");
  });

  it("local-gemma builds the direct provider with the gemma4:12b default model", () => {
    const cfg = loadAIConfig({ ...GEMMA_ENV });
    const provider = selectProvider(cfg);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.key).toBe("local-gemma");
    expect(provider.model).toBe("gemma4:12b");
  });

  it("toggling AI_PROVIDER between bedrock-gateway and local-gemma switches the provider", () => {
    const bedrock = selectProvider(loadAIConfig({ ...BEDROCK_ENV }));
    expect(bedrock.key).toBe("bedrock-gateway");
    expect(bedrock.model).toBe("us.anthropic.claude-sonnet-5");

    const gemma = selectProvider(loadAIConfig({ ...GEMMA_ENV }));
    expect(gemma.key).toBe("local-gemma");
    expect(gemma.model).toBe("gemma4:12b");

    // ...and back again, proving no cross-contamination of defaults.
    const bedrockAgain = selectProvider(loadAIConfig({ ...BEDROCK_ENV }));
    expect(bedrockAgain.key).toBe("bedrock-gateway");
    expect(bedrockAgain.model).toBe("us.anthropic.claude-sonnet-5");
  });
});

describe("factory guard (#113)", () => {
  it("never routes local-gemma into the Copilot SDK — uses the direct provider", () => {
    const cfg = loadAIConfig({ ...GEMMA_ENV });
    // A wrapperFactory that throws if invoked proves the SDK path is skipped.
    const provider = buildProvider({
      config: cfg,
      wrapperFactory: () => {
        throw new Error("SDK wrapper must NOT be constructed for local-gemma");
      },
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.key).toBe("local-gemma");
  });

  it("applies an apiKeyOverride to the guarded local-gemma provider", async () => {
    const cfg = loadAIConfig({ ...GEMMA_ENV });
    const provider = buildProvider({ config: cfg, apiKeyOverride: "rotated-token" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await provider.ping();
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe("Bearer rotated-token");
  });

  it("fails fast when local-gemma reaches the factory without sdkProvider config", () => {
    const cfg: AIConfig = {
      provider: "local-gemma",
      model: "gemma4:12b",
      offline: false,
      rateLimit: { windowMs: 1000, max: 1 },
      pingTimeoutMs: 1000,
      sdkProvider: undefined,
    };
    expect(() => buildProvider({ config: cfg })).toThrow(AIProviderError);
  });
});
