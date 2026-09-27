/**
 * #254 / #283 — the deployment-wide model (`AI_MODEL`, or Admin
 * `AI_DEFAULT_MODEL` mapped onto it) is a model of the DEPLOYMENT's provider.
 * A provider override (`loadAIConfig(env, { provider })`, and
 * `providerDefaultModel` for chat session creation) must not inherit it unless
 * the override names that same provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: { runtimeConfig: { findMany: vi.fn(async () => []) } },
}));

import { loadAIConfig, providerDefaultModel } from "../../../src/lib/ai/config.js";
import { __resetConfigSingleton, getConfigService } from "../../../src/lib/config/index.js";

const base = (): NodeJS.ProcessEnv => ({
  AI_PROVIDER: "openai",
  AI_MODEL: "gpt-deployment-pinned",
  OPENAI_BASE_URL: "https://openai.example.test/v1",
  OPENAI_API_KEY: "k-openai",
  ANTHROPIC_API_KEY: "k-anthropic",
  LOCAL_GEMMA_BASE_URL: "http://localhost:11434/v1",
});

beforeEach(() => __resetConfigSingleton());
afterEach(() => __resetConfigSingleton());

describe("provider override and the deployment-wide model", () => {
  it("an override to another provider drops AI_MODEL for that provider's own default", () => {
    expect(loadAIConfig(base(), { provider: "anthropic" }).model).toBe("claude-sonnet-4-6");
    expect(providerDefaultModel("anthropic", base())).toBe("claude-sonnet-4-6");
  });

  it("the override provider's own *_MODEL setting is honoured", () => {
    const env = { ...base(), ANTHROPIC_MODEL: "claude-own", LOCAL_GEMMA_MODEL: "gemma-own" };
    expect(loadAIConfig(env, { provider: "anthropic" }).model).toBe("claude-own");
    expect(loadAIConfig(env, { provider: "local-gemma" }).model).toBe("gemma-own");
    expect(providerDefaultModel("local-gemma", env)).toBe("gemma-own");
  });

  it("an override naming the deployment's provider keeps AI_MODEL", () => {
    expect(loadAIConfig(base(), { provider: "openai" }).model).toBe("gpt-deployment-pinned");
    expect(providerDefaultModel("openai", base())).toBe("gpt-deployment-pinned");
  });

  it("no override keeps AI_MODEL (unchanged deployment behaviour)", () => {
    expect(loadAIConfig(base()).model).toBe("gpt-deployment-pinned");
  });

  it("the deployment provider is the runtime one when Admin set AI_PROVIDER / AI_DEFAULT_MODEL", () => {
    const svc = getConfigService();
    // @ts-expect-error — test seam: admin-set runtime_config values.
    svc["tunableCache"].set("AI_PROVIDER", "anthropic");
    // @ts-expect-error — see above.
    svc["tunableCache"].set("AI_DEFAULT_MODEL", "claude-admin-pick");
    // @ts-expect-error — see above.
    svc["tunableDbBacked"].add("AI_PROVIDER");
    // @ts-expect-error — see above.
    svc["tunableDbBacked"].add("AI_DEFAULT_MODEL");

    expect(loadAIConfig(base(), { provider: "anthropic" }).model).toBe("claude-admin-pick");
    expect(loadAIConfig(base(), { provider: "openai" }).model).toBe("gpt-4.1");
    expect(providerDefaultModel("openai", base())).toBe("gpt-4.1");
  });

  it("providerDefaultModel does not require the provider's credentials", () => {
    const env = { ...base(), ANTHROPIC_API_KEY: undefined };
    expect(() => loadAIConfig(env, { provider: "anthropic" })).toThrow();
    expect(providerDefaultModel("anthropic", env)).toBe("claude-sonnet-4-6");
  });

  it("an offline deployment reports the offline-stub model, as loadAIConfig does", () => {
    const env = { ...base(), AI_OFFLINE: "1" };
    expect(providerDefaultModel("anthropic", env)).toBe(
      loadAIConfig(env, { provider: "anthropic" }).model,
    );
    expect(providerDefaultModel("anthropic", env)).toBe("offline-stub");
  });

  it("an unset AI_PROVIDER is the offline-stub deployment, so AI_MODEL does not follow an override", () => {
    const env = { ...base(), AI_PROVIDER: undefined };
    expect(providerDefaultModel("anthropic", env)).toBe("claude-sonnet-4-6");
    expect(providerDefaultModel("offline-stub", env)).toBe("gpt-deployment-pinned");
  });

  it("an invalid configuration throws the loader's error", () => {
    expect(() => providerDefaultModel("not-a-provider", base())).toThrow(
      "Invalid AI configuration",
    );
  });
});
