/**
 * #178 — Phase-2 batch concurrency: a registry tunable whose default depends on
 * the provider kind, clamped like the Phase-1 setting.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import { ConfigService as RealConfigService } from "../config/config-service.js";
import {
  DEFAULT_PHASE2_CONCURRENCY_CLOUD,
  DEFAULT_PHASE2_CONCURRENCY_LOCAL,
  MAX_PHASE2_CONCURRENCY,
  PHASE2_CONCURRENCY_KEY,
  defaultPhase2Concurrency,
  resolvePhase2Concurrency,
} from "./phase2-concurrency.js";

function stubConfig(values: Record<string, number> = {}): ConfigService {
  return {
    getNumber: (key: string, d?: number) => values[key] ?? d,
  } as unknown as ConfigService;
}

describe("resolvePhase2Concurrency (#178)", () => {
  it("defaults to 1 for local-gemma and to a higher value for every cloud provider", () => {
    expect(DEFAULT_PHASE2_CONCURRENCY_LOCAL).toBe(1);
    expect(DEFAULT_PHASE2_CONCURRENCY_CLOUD).toBe(4);
    expect(resolvePhase2Concurrency("local-gemma", stubConfig())).toBe(1);
    for (const key of ["bedrock-gateway", "anthropic", "openai", "azure"]) {
      expect(resolvePhase2Concurrency(key, stubConfig()), key).toBe(4);
      expect(defaultPhase2Concurrency(key), key).toBe(4);
    }
  });

  it("defaults to 1 for every provider not named as cloud (copilot-native, offline-stub, a new key)", () => {
    for (const key of ["copilot-native", "offline-stub", "some-future-provider"]) {
      expect(defaultPhase2Concurrency(key), key).toBe(1);
      expect(resolvePhase2Concurrency(key, stubConfig()), key).toBe(1);
    }
  });

  it("applies a configured value to every provider kind, clamped to 1..64", () => {
    const k = PHASE2_CONCURRENCY_KEY;
    expect(resolvePhase2Concurrency("local-gemma", stubConfig({ [k]: 3 }))).toBe(3);
    expect(resolvePhase2Concurrency("anthropic", stubConfig({ [k]: 12 }))).toBe(12);
    expect(resolvePhase2Concurrency("anthropic", stubConfig({ [k]: 1000 }))).toBe(
      MAX_PHASE2_CONCURRENCY,
    );
    expect(resolvePhase2Concurrency("anthropic", stubConfig({ [k]: 2.7 }))).toBe(2);
  });

  it("falls back to the provider's default for a non-positive or non-numeric value", () => {
    const k = PHASE2_CONCURRENCY_KEY;
    expect(resolvePhase2Concurrency("anthropic", stubConfig({ [k]: 0 }))).toBe(4);
    expect(resolvePhase2Concurrency("local-gemma", stubConfig({ [k]: -4 }))).toBe(1);
    expect(resolvePhase2Concurrency("anthropic", stubConfig({ [k]: Number.NaN }))).toBe(4);
  });

  it("is a registered key readable from the environment (db → env)", () => {
    const config = new RealConfigService({
      env: { DOCS_GEN_PHASE2_CONCURRENCY: "8" },
      vault: {} as never,
    });
    expect(resolvePhase2Concurrency("local-gemma", config)).toBe(8);
    const unset = new RealConfigService({ env: {}, vault: {} as never });
    expect(resolvePhase2Concurrency("bedrock-gateway", unset)).toBe(4);
  });
});

describe("an openai provider pointed at a self-hosted server (#208)", () => {
  it("defaults to 1 when the base URL's host is loopback or a private address", () => {
    for (const url of [
      "http://localhost:8000/v1",
      "http://127.0.0.1:11434/v1",
      "http://[::1]:8080/v1",
      "http://10.0.0.5:8000/v1",
      "https://192.168.1.20/v1",
      "http://172.16.4.2:9000/v1",
    ]) {
      expect(defaultPhase2Concurrency("openai", { OPENAI_BASE_URL: url }), url).toBe(1);
      expect(resolvePhase2Concurrency("openai", stubConfig(), { OPENAI_BASE_URL: url }), url).toBe(
        1,
      );
    }
    // COPILOT_PROVIDER_BASE_URL is the provider's fallback base URL.
    expect(
      defaultPhase2Concurrency("openai", { COPILOT_PROVIDER_BASE_URL: "http://localhost:1234/v1" }),
    ).toBe(1);
  });

  it("keeps the cloud default for a public host, an unset or unparsable URL", () => {
    for (const env of [
      { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      { OPENAI_BASE_URL: "https://llm.example.com/v1" },
      { OPENAI_BASE_URL: "not a url" },
      {},
    ]) {
      expect(defaultPhase2Concurrency("openai", env), JSON.stringify(env)).toBe(4);
    }
    // OPENAI_BASE_URL wins over the fallback, as it does in the provider config.
    expect(
      defaultPhase2Concurrency("openai", {
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        COPILOT_PROVIDER_BASE_URL: "http://localhost:1234/v1",
      }),
    ).toBe(4);
  });

  it("applies only to the openai provider, and an explicit setting still wins", () => {
    const env = { OPENAI_BASE_URL: "http://localhost:8000/v1" };
    expect(defaultPhase2Concurrency("anthropic", env)).toBe(4);
    expect(defaultPhase2Concurrency("bedrock-gateway", env)).toBe(4);
    expect(
      resolvePhase2Concurrency("openai", stubConfig({ [PHASE2_CONCURRENCY_KEY]: 6 }), env),
    ).toBe(6);
  });
});
