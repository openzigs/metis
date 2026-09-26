/**
 * #134 — factory routing edges: every direct key refuses a config with no
 * resolved endpoint, a per-session key override reaches the direct clients,
 * a removed or unknown provider key is refused by name (#149), and the
 * singleton memoises.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetProviderSingleton,
  buildProvider,
  getProvider,
} from "../../../src/lib/ai/providers/factory.js";
import { loadAIConfig, type AIConfig } from "../../../src/lib/ai/config.js";
import { AIConfigError, AIProviderError } from "../../../src/lib/ai/errors.js";

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
    "%s without a resolved sdkProvider is a provider error, never a fallback",
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

  // #149 — a config that still carries the removed key (a project override or
  // stored session reaches the factory without passing loadAIConfig's check)
  // is refused by name. Before #149 it built the Copilot provider; it must
  // never be routed to another (possibly paid) provider instead.
  it("the removed copilot-native key is refused by name, never routed elsewhere", () => {
    const config = { ...bare("anthropic"), provider: "copilot-native" } as unknown as AIConfig;
    expect(() => buildProvider({ config })).toThrow(AIConfigError);
    expect(() => buildProvider({ config })).toThrow(/GitHub Copilot support was removed/);
    expect(() => buildProvider({ config })).toThrow(/MIGRATING_FROM_COPILOT/);
  });

  it("an unknown provider key is a config error, not a silent fallback", () => {
    const config = { ...bare("anthropic"), provider: "made-up" } as unknown as AIConfig;
    expect(() => buildProvider({ config })).toThrow(/Unknown AI provider "made-up"/);
  });

  it("getProvider memoises until reset", () => {
    const cfg = loadAIConfig({});
    const a = getProvider({ config: cfg });
    expect(getProvider({ config: cfg })).toBe(a);
    __resetProviderSingleton();
    expect(getProvider({ config: cfg })).not.toBe(a);
  });
});
