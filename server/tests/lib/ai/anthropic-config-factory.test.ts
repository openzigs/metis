/**
 * Issue #285 — config resolution + factory routing for the native Anthropic
 * provider.
 *
 *   • `loadAIConfig` resolves `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/
 *     `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` into the sdkProvider config, with
 *     `claude-sonnet-4-6` as the bare default model.
 *   • The public-LLM-host guard does NOT block api.anthropic.com here.
 *   • The factory builds an `AnthropicProvider` and
 *     short-circuits to the offline stub when offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: { runtimeConfig: { findMany: vi.fn(async () => []) } },
}));

// The SDK is mocked so constructing AnthropicProvider never opens a network
// client. We only need the constructor + the typed-error statics to exist.
const ctorMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create: vi.fn(), stream: vi.fn() };
    models = { list: vi.fn() };
    constructor(opts: unknown) {
      ctorMock(opts);
    }
    static APIError = class extends Error {};
  }
  return { default: Anthropic };
});

import { loadAIConfig } from "../../../src/lib/ai/config.js";
import { buildProvider, __resetProviderSingleton } from "../../../src/lib/ai/providers/factory.js";
import { AnthropicProvider } from "../../../src/lib/ai/providers/anthropic-provider.js";

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_OFFLINE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "COPILOT_PROVIDER_BASE_URL",
  "COPILOT_PROVIDER_API_KEY",
];
const stash: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    stash[k] = process.env[k];
    delete process.env[k];
  }
  __resetProviderSingleton();
  ctorMock.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (stash[k] === undefined) delete process.env[k];
    else process.env[k] = stash[k];
  }
  __resetProviderSingleton();
  vi.clearAllMocks();
});

describe("loadAIConfig — native anthropic (#285)", () => {
  it("resolves ANTHROPIC_API_KEY and defaults to the bare claude-sonnet-4-6", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = loadAIConfig(process.env);
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.sdkProvider).toMatchObject({ type: "anthropic", apiKey: "sk-ant-test" });
  });

  it("honours ANTHROPIC_MODEL override (bare id)", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_MODEL = "claude-opus-4-8";
    const cfg = loadAIConfig(process.env);
    expect(cfg.model).toBe("claude-opus-4-8");
  });

  it("carries authToken and a custom baseUrl when supplied", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-tok";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    const cfg = loadAIConfig(process.env);
    expect(cfg.sdkProvider).toMatchObject({
      type: "anthropic",
      authToken: "oauth-tok",
      baseUrl: "https://api.anthropic.com",
    });
  });

  it("does NOT block api.anthropic.com as a base URL (guard targets bedrock only)", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    expect(() => loadAIConfig(process.env)).not.toThrow();
  });

  it("throws AIConfigError when neither key nor token is set", () => {
    process.env.AI_PROVIDER = "anthropic";
    expect(() => loadAIConfig(process.env)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("resolves authToken-only auth (ANTHROPIC_AUTH_TOKEN without ANTHROPIC_API_KEY)", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-tok";
    const cfg = loadAIConfig(process.env);
    expect(cfg.sdkProvider).toMatchObject({ type: "anthropic", authToken: "oauth-tok" });
    expect((cfg.sdkProvider as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it("does NOT fall back to COPILOT_PROVIDER_API_KEY when ANTHROPIC_API_KEY is absent", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.COPILOT_PROVIDER_API_KEY = "copilot-key";
    // No ANTHROPIC_API_KEY and no ANTHROPIC_AUTH_TOKEN → must throw, not borrow
    // the unrelated Copilot credential.
    expect(() => loadAIConfig(process.env)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("uses ANTHROPIC_API_KEY even when COPILOT_PROVIDER_API_KEY is also set", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.COPILOT_PROVIDER_API_KEY = "copilot-key";
    const cfg = loadAIConfig(process.env);
    expect(cfg.sdkProvider).toMatchObject({ type: "anthropic", apiKey: "sk-ant-test" });
  });

  it("does NOT require COPILOT_PROVIDER_BASE_URL (unlike openai/azure)", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(() => loadAIConfig(process.env)).not.toThrow();
  });
});

describe("factory routing — anthropic → AnthropicProvider (#285)", () => {
  it("builds the native AnthropicProvider", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = loadAIConfig(process.env);
    const provider = buildProvider({ config: cfg });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.key).toBe("anthropic");
  });

  it("passes the resolved apiKey through to the SDK client", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = loadAIConfig(process.env);
    buildProvider({ config: cfg });
    expect(ctorMock).toHaveBeenCalledTimes(1);
    expect(ctorMock.mock.calls[0][0]).toMatchObject({ apiKey: "sk-ant-test" });
  });

  it("honours apiKeyOverride (per-session BYOK key)", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-env";
    const cfg = loadAIConfig(process.env);
    buildProvider({ config: cfg, apiKeyOverride: "sk-session" });
    expect(ctorMock.mock.calls[0][0]).toMatchObject({ apiKey: "sk-session" });
  });

  it("AI_OFFLINE short-circuits to the offline stub BEFORE requiring a key", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.AI_OFFLINE = "1";
    // No ANTHROPIC_API_KEY set — must not throw.
    const cfg = loadAIConfig(process.env);
    expect(cfg.offline).toBe(true);
    const provider = buildProvider({ config: cfg });
    expect(provider.offline).toBe(true);
    expect(provider).not.toBeInstanceOf(AnthropicProvider);
  });

  it("forceOffline short-circuits even with anthropic selected", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = loadAIConfig(process.env);
    const provider = buildProvider({ config: cfg, forceOffline: true });
    expect(provider.offline).toBe(true);
  });
});
