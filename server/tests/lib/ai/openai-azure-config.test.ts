/**
 * #134 — config for the directly-routed openai / azure keys: the
 * OPENAI_* / AZURE_OPENAI_* names and a validated Azure api-version.
 * #149 — the Copilot-era COPILOT_PROVIDER_* fallback is gone: a deployment
 * still relying on it is refused with the rename it needs, never run with a
 * silently missing base URL or key.
 */
import { describe, expect, it } from "vitest";
import { loadAIConfig } from "../../../src/lib/ai/config.js";

describe("openai config", () => {
  it("reads OPENAI_BASE_URL / OPENAI_API_KEY", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_API_KEY: "sk-native",
      COPILOT_PROVIDER_API_KEY: "sk-legacy",
    });
    expect(cfg.sdkProvider).toEqual({
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-native",
    });
  });

  it("#149 — refuses the retired COPILOT_PROVIDER_* matrix and names each rename", () => {
    const run = () =>
      loadAIConfig({
        AI_PROVIDER: "openai",
        COPILOT_PROVIDER_BASE_URL: "https://proxy.example.com/v1",
        COPILOT_PROVIDER_API_KEY: "sk-legacy",
      });
    expect(run).toThrow(/COPILOT_PROVIDER_BASE_URL → OPENAI_BASE_URL/);
    expect(run).toThrow(/COPILOT_PROVIDER_API_KEY → OPENAI_API_KEY/);
    expect(run).toThrow(/MIGRATING_FROM_COPILOT/);
  });

  it("#149 — refuses a retired key even when only the key is left un-renamed", () => {
    expect(() =>
      loadAIConfig({
        AI_PROVIDER: "openai",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        COPILOT_PROVIDER_API_KEY: "sk-legacy",
      }),
    ).toThrow(/COPILOT_PROVIDER_API_KEY → OPENAI_API_KEY/);
  });

  it("#149 — refuses COPILOT_MODEL without AI_MODEL, and ignores it once AI_MODEL is set", () => {
    const base = { AI_PROVIDER: "openai", OPENAI_BASE_URL: "https://api.openai.com/v1" };
    expect(() => loadAIConfig({ ...base, COPILOT_MODEL: "gpt-5" })).toThrow(
      /COPILOT_MODEL → AI_MODEL/,
    );
    expect(loadAIConfig({ ...base, COPILOT_MODEL: "gpt-5", AI_MODEL: "gpt-4o" }).model).toBe(
      "gpt-4o",
    );
    // With neither set, the openai default model is used.
    expect(loadAIConfig(base).model).toBe("gpt-4.1");
    // A leftover COPILOT_MODEL equal to that default (what .env.example shipped)
    // changes nothing when dropped, so it is not refused.
    expect(loadAIConfig({ ...base, COPILOT_MODEL: "gpt-4.1" }).model).toBe("gpt-4.1");
  });

  it("names OPENAI_BASE_URL when no base URL is set", () => {
    expect(() => loadAIConfig({ AI_PROVIDER: "openai" })).toThrow(
      /openai provider requires OPENAI_BASE_URL/,
    );
  });
});

describe("azure config", () => {
  it("reads the AZURE_OPENAI_* names and defaults the api-version", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "azure",
      AZURE_OPENAI_ENDPOINT: "https://contoso.openai.azure.com",
      AZURE_OPENAI_API_KEY: "az",
      AZURE_OPENAI_DEPLOYMENT: "prod-4o",
    });
    expect(cfg.sdkProvider).toEqual({
      type: "azure",
      baseUrl: "https://contoso.openai.azure.com",
      apiKey: "az",
      apiVersion: "2024-10-21",
      deployment: "prod-4o",
    });
  });

  it("#149 — refuses the retired matrix, naming the AZURE_OPENAI_* renames", () => {
    const run = () =>
      loadAIConfig({
        AI_PROVIDER: "azure",
        COPILOT_PROVIDER_BASE_URL: "https://contoso.openai.azure.com",
        COPILOT_PROVIDER_API_KEY: "k",
        AZURE_OPENAI_API_VERSION: "2025-01-01-preview",
      });
    expect(run).toThrow(/COPILOT_PROVIDER_BASE_URL → AZURE_OPENAI_ENDPOINT/);
    expect(run).toThrow(/COPILOT_PROVIDER_API_KEY → AZURE_OPENAI_API_KEY/);
  });

  it("works without a deployment", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "azure",
      AZURE_OPENAI_ENDPOINT: "https://contoso.openai.azure.com",
      AZURE_OPENAI_API_KEY: "k",
      AZURE_OPENAI_API_VERSION: "2025-01-01-preview",
    });
    expect(cfg.sdkProvider).toEqual({
      type: "azure",
      baseUrl: "https://contoso.openai.azure.com",
      apiKey: "k",
      apiVersion: "2025-01-01-preview",
    });
  });

  it("rejects a malformed api-version and a missing endpoint", () => {
    expect(() =>
      loadAIConfig({
        AI_PROVIDER: "azure",
        AZURE_OPENAI_ENDPOINT: "https://contoso.openai.azure.com",
        AZURE_OPENAI_API_VERSION: "latest&x=1",
      }),
    ).toThrow(/Invalid AI configuration/);
    expect(() => loadAIConfig({ AI_PROVIDER: "azure" })).toThrow(/AZURE_OPENAI_ENDPOINT/);
  });
});

// Review finding on PR #194: aiEnvSchema validates every key whatever
// AI_PROVIDER is, so a blank placeholder for one of the six new #134 keys must
// behave as unset rather than break config for an unrelated provider.
describe("blank OPENAI_* / AZURE_OPENAI_* values are treated as unset", () => {
  const NEW_KEYS = [
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT",
  ] as const;

  for (const key of NEW_KEYS) {
    for (const blank of ["", "   "]) {
      it(`${key}=${JSON.stringify(blank)} does not break local-gemma`, () => {
        const cfg = loadAIConfig({
          AI_PROVIDER: "local-gemma",
          LOCAL_GEMMA_BASE_URL: "http://localhost:11434/v1",
          [key]: blank,
        });
        expect(cfg.provider).toBe("local-gemma");
        expect(cfg.localBaseUrl).toBe("http://localhost:11434/v1");
      });
    }
  }

  it("a blank OPENAI_* value is unset — so a retired COPILOT_PROVIDER_* beside it is refused by name", () => {
    expect(() =>
      loadAIConfig({
        AI_PROVIDER: "openai",
        OPENAI_BASE_URL: "",
        OPENAI_API_KEY: "",
        COPILOT_PROVIDER_BASE_URL: "https://proxy.example.com/v1",
        COPILOT_PROVIDER_API_KEY: "sk-legacy",
      }),
    ).toThrow(/COPILOT_PROVIDER_BASE_URL → OPENAI_BASE_URL/);
  });

  it("a blank AZURE_OPENAI_API_VERSION falls back to the default", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "azure",
      AZURE_OPENAI_ENDPOINT: "https://contoso.openai.azure.com",
      AZURE_OPENAI_API_KEY: "az",
      AZURE_OPENAI_API_VERSION: "",
    });
    expect(cfg.sdkProvider).toMatchObject({ apiVersion: "2024-10-21" });
  });

  it("a non-blank invalid value is still rejected", () => {
    expect(() =>
      loadAIConfig({
        AI_PROVIDER: "local-gemma",
        LOCAL_GEMMA_BASE_URL: "http://localhost:11434/v1",
        OPENAI_BASE_URL: "not a url",
      }),
    ).toThrow(/Invalid AI configuration/);
  });
});
