/**
 * #241 — `loadAIConfig(env, { provider })` loads the configuration of a chat
 * session's STORED provider (a per-project override) from the same env +
 * Admin → Settings view the deployment uses: that provider's own endpoint and
 * credentials, never the global provider's. It must win over a runtime-config
 * `AI_PROVIDER` (Admin → Settings), which the overlay would otherwise restore.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAIConfig } from "../src/lib/ai/config.js";
import { __resetConfigSingleton, getConfigService } from "../src/lib/config/index.js";

const ENV = {
  AI_PROVIDER: "openai",
  OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
  OPENAI_API_KEY: "k-openai",
  ANTHROPIC_API_KEY: "k-anthropic",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:2",
} as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  vi.restoreAllMocks();
  __resetConfigSingleton();
});

describe("loadAIConfig for a session's stored provider (#241)", () => {
  it("builds the named provider's endpoint and credentials, not the global one's", () => {
    expect(loadAIConfig(ENV).provider).toBe("openai");
    const cfg = loadAIConfig(ENV, { provider: "anthropic" });
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.sdkProvider).toMatchObject({
      type: "anthropic",
      baseUrl: "http://127.0.0.1:2",
      apiKey: "k-anthropic",
    });
  });

  it("wins over an AI_PROVIDER chosen in Admin → Settings (runtime config)", () => {
    const svc = getConfigService();
    const describe = svc.describeSource.bind(svc);
    const get = svc.get.bind(svc);
    vi.spyOn(svc, "describeSource").mockImplementation((key: string) =>
      key === "AI_PROVIDER"
        ? { source: "db", hasVaultEntry: false, hasDbEntry: true, hasEnvEntry: true }
        : describe(key),
    );
    vi.spyOn(svc, "get").mockImplementation((key: string) =>
      key === "AI_PROVIDER" ? "openai" : get(key),
    );
    const env = { ...ENV, AI_PROVIDER: "anthropic" } as NodeJS.ProcessEnv;
    // The runtime config really does override the env's choice…
    expect(loadAIConfig(env).provider).toBe("openai");
    // …but not the session's.
    expect(loadAIConfig(env, { provider: "anthropic" }).provider).toBe("anthropic");
  });

  it("refuses a provider whose endpoint is not configured — no fall-back", () => {
    expect(() => loadAIConfig(ENV, { provider: "azure" })).toThrow(/AZURE_OPENAI_ENDPOINT/);
  });
});
