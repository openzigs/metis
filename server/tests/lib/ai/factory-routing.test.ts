/**
 * #134 — factory routing edges: every direct key refuses a config with no
 * resolved endpoint, a per-session key override reaches the direct clients,
 * a wrapper that fails to construct surfaces as a provider error, and the
 * singleton memoises.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetProviderSingleton,
  buildProvider,
  getProvider,
} from "../../../src/lib/ai/providers/factory.js";
import { loadAIConfig, type AIConfig } from "../../../src/lib/ai/config.js";
import { AIProviderError } from "../../../src/lib/ai/errors.js";

const bare = (provider: AIConfig["provider"]): AIConfig => ({
  provider,
  model: "m",
  offline: false,
  rateLimit: { windowMs: 1, max: 1 },
  pingTimeoutMs: 1,
});

afterEach(() => __resetProviderSingleton());

describe("buildProvider routing edges", () => {
  it.each(["anthropic", "local-gemma", "bedrock-gateway", "openai", "azure"] as const)(
    "%s without a resolved sdkProvider is a provider error, never a Copilot fallback",
    (key) => {
      expect(() => buildProvider({ config: bare(key) })).toThrow(AIProviderError);
      expect(() => buildProvider({ config: bare(key) })).toThrow(/without a resolved sdkProvider/);
    },
  );

  it("a per-session key override reaches the direct client's auth header", async () => {
    const p = buildProvider({
      config: loadAIConfig({
        AI_PROVIDER: "openai",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_API_KEY: "env-key",
      }),
      apiKeyOverride: "session-key",
    });
    const original = globalThis.fetch;
    let auth = "";
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await p.ping();
    } finally {
      globalThis.fetch = original;
    }
    expect(auth).toBe("Bearer session-key");
  });

  it("a Copilot wrapper that throws is reported as a provider error", () => {
    expect(() =>
      buildProvider({
        config: loadAIConfig({ AI_PROVIDER: "copilot-native" }),
        wrapperFactory: () => {
          throw new Error("no sdk");
        },
      }),
    ).toThrow(/failed to construct Copilot wrapper: no sdk/);
  });

  it("getProvider memoises until reset", () => {
    const cfg = loadAIConfig({});
    const a = getProvider({ config: cfg });
    expect(getProvider({ config: cfg })).toBe(a);
    __resetProviderSingleton();
    expect(getProvider({ config: cfg })).not.toBe(a);
  });
});
