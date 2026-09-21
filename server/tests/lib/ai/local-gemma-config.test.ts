/**
 * Epic #108 (#111 + #112) — local-gemma provider config wiring.
 *
 * Covers:
 *   • `defaultModel()` resolves `gemma4:12b` for local-gemma and NEVER falls
 *     through to the Bedrock default.
 *   • `buildSdkProvider()` builds the OpenAI-compatible config from the
 *     `LOCAL_GEMMA_*` env matrix, defaulting the dummy key to `ollama`.
 *   • `validateLocalProviderUrl()` accepts loopback / RFC-1918 hosts (even
 *     over http in production) but rejects public LLM + public hosts.
 *   • The Bedrock branch + `validateBedrockGatewayUrl` remain unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/config/config-service.js", () => ({
  getConfigService: () => {
    throw new Error("no config service in this test");
  },
}));

import {
  buildSdkProvider,
  loadAIConfig,
  validateLocalProviderUrl,
  type AIEnv,
} from "../../../src/lib/ai/config.js";
import { AIConfigError } from "../../../src/lib/ai/errors.js";

const BASE = "http://localhost:11434/v1";

function env(overrides: Record<string, string | undefined> = {}): AIEnv {
  return {
    AI_PROVIDER: "local-gemma",
    LOCAL_GEMMA_BASE_URL: BASE,
    ...overrides,
  } as unknown as AIEnv;
}

const savedNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv;
  vi.unstubAllEnvs();
});

describe("local-gemma default model (#111)", () => {
  it("resolves gemma4:12b by default", () => {
    const cfg = loadAIConfig({ AI_PROVIDER: "local-gemma", LOCAL_GEMMA_BASE_URL: BASE });
    expect(cfg.provider).toBe("local-gemma");
    expect(cfg.model).toBe("gemma4:12b");
  });

  it("honors LOCAL_GEMMA_MODEL override", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "local-gemma",
      LOCAL_GEMMA_BASE_URL: BASE,
      LOCAL_GEMMA_MODEL: "gemma3:12b",
    });
    expect(cfg.model).toBe("gemma3:12b");
  });

  it("rejects an over-long LOCAL_GEMMA_MODEL (mirrors key-registry max(200))", () => {
    expect(() =>
      loadAIConfig({
        AI_PROVIDER: "local-gemma",
        LOCAL_GEMMA_BASE_URL: BASE,
        LOCAL_GEMMA_MODEL: "g".repeat(201),
      }),
    ).toThrow(AIConfigError);
  });

  it("AI_MODEL override beats the provider default", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "local-gemma",
      LOCAL_GEMMA_BASE_URL: BASE,
      AI_MODEL: "custom-model",
    });
    expect(cfg.model).toBe("custom-model");
  });

  it("never falls through to the Bedrock default model", () => {
    const cfg = loadAIConfig({ AI_PROVIDER: "local-gemma", LOCAL_GEMMA_BASE_URL: BASE });
    expect(cfg.model).not.toContain("claude");
    expect(cfg.model).not.toContain("anthropic");
  });

  it("surfaces localBaseUrl + localApiKey (dummy default) on the config", () => {
    const cfg = loadAIConfig({ AI_PROVIDER: "local-gemma", LOCAL_GEMMA_BASE_URL: BASE });
    expect(cfg.localBaseUrl).toBe(BASE);
    expect(cfg.localApiKey).toBe("ollama");
    expect(cfg.sdkProvider).toEqual({ type: "openai", baseUrl: BASE, apiKey: "ollama" });
  });
});

describe("buildSdkProvider local-gemma branch (#112)", () => {
  it("builds an openai-typed config with the configured key", () => {
    const out = buildSdkProvider(env({ LOCAL_GEMMA_API_KEY: "secret-token" }));
    expect(out).toEqual({ type: "openai", baseUrl: BASE, apiKey: "secret-token" });
  });

  it("defaults the api key to the ollama dummy when unset", () => {
    const out = buildSdkProvider(env());
    expect(out).toEqual({ type: "openai", baseUrl: BASE, apiKey: "ollama" });
  });

  it("throws a clear AIConfigError when LOCAL_GEMMA_BASE_URL is missing", () => {
    expect(() => buildSdkProvider(env({ LOCAL_GEMMA_BASE_URL: undefined }))).toThrow(
      /LOCAL_GEMMA_BASE_URL/,
    );
  });
});

describe("validateLocalProviderUrl (#112)", () => {
  const e = {} as AIEnv;

  it("accepts http://localhost", () => {
    expect(() => validateLocalProviderUrl("http://localhost:11434/v1", e)).not.toThrow();
  });

  it("accepts 127.0.0.1", () => {
    expect(() => validateLocalProviderUrl("http://127.0.0.1:11434/v1", e)).not.toThrow();
  });

  it("accepts ::1 loopback", () => {
    expect(() => validateLocalProviderUrl("http://[::1]:11434/v1", e)).not.toThrow();
  });

  it("accepts RFC-1918 10/8, 172.16/12, 192.168/16", () => {
    expect(() => validateLocalProviderUrl("http://10.0.0.5:11434/v1", e)).not.toThrow();
    expect(() => validateLocalProviderUrl("http://172.16.4.2:11434/v1", e)).not.toThrow();
    expect(() => validateLocalProviderUrl("http://192.168.1.50:11434/v1", e)).not.toThrow();
  });

  it("allows http://localhost even in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => validateLocalProviderUrl("http://localhost:11434/v1", e)).not.toThrow();
  });

  it("rejects public LLM hosts", () => {
    expect(() => validateLocalProviderUrl("https://api.openai.com/v1", e)).toThrow(AIConfigError);
    expect(() => validateLocalProviderUrl("https://foo.openai.com/v1", e)).toThrow(AIConfigError);
    expect(() => validateLocalProviderUrl("https://x.anthropic.com/v1", e)).toThrow(AIConfigError);
    expect(() => validateLocalProviderUrl("https://y.azure.com/v1", e)).toThrow(AIConfigError);
  });

  it("rejects a public non-LLM host", () => {
    expect(() => validateLocalProviderUrl("http://example.com/v1", e)).toThrow(
      /loopback or private/,
    );
    expect(() => validateLocalProviderUrl("http://8.8.8.8/v1", e)).toThrow(/loopback or private/);
  });

  it("rejects a non-http(s) protocol", () => {
    expect(() => validateLocalProviderUrl("ftp://localhost/v1", e)).toThrow(/http or https/);
  });

  it("rejects a malformed URL", () => {
    expect(() => validateLocalProviderUrl("not a url", e)).toThrow(/not a valid URL/);
  });
});

describe("bedrock-gateway remains unchanged (#108 regression)", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  it("still builds the direct provider config with the Bedrock default model", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "bedrock-gateway",
      BEDROCK_GATEWAY_URL: "https://gateway.internal.example.com",
      BEDROCK_GATEWAY_API_KEY: "bedrock-key",
      BEDROCK_ALLOWED_HOSTS: "gateway.internal.example.com",
    });
    expect(cfg.provider).toBe("bedrock-gateway");
    expect(cfg.model).toBe("us.anthropic.claude-sonnet-5");
    expect(cfg.sdkProvider?.baseUrl).toBe("https://gateway.internal.example.com");
  });

  it("still rejects http://localhost for bedrock in production", () => {
    process.env.NODE_ENV = "production";
    expect(() =>
      loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "http://localhost:8080",
        BEDROCK_GATEWAY_API_KEY: "k",
      }),
    ).toThrow(/https in production/);
  });
});
