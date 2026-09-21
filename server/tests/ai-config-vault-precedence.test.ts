/**
 * Issue #251 — verify the AI provider config loader applies the vault → env
 * precedence rule for runtime secrets via `ConfigService`.
 *
 * The factory already constructs per-request, so a vault rotation MUST be
 * picked up on the next `loadAIConfig()` call without any restart.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAIConfig } from "../src/lib/ai/config.js";
import { buildProvider } from "../src/lib/ai/providers/factory.js";
import {
  ConfigService,
  __resetConfigSingleton,
  getConfigService,
} from "../src/lib/config/index.js";
import { __resetVaultSingleton, VaultService } from "../src/lib/vault/vault-service.js";

const MASTER = Buffer.alloc(32, 7).toString("base64");

const SECRET_KEYS_TO_ISOLATE = [
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "BEDROCK_GATEWAY_API_KEY",
  "GATEWAY_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Isolate from any ambient .env values that might mask the test's intent.
  for (const k of SECRET_KEYS_TO_ISOLATE) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetConfigSingleton();
  __resetVaultSingleton();
});

afterEach(() => {
  for (const k of SECRET_KEYS_TO_ISOLATE) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  __resetConfigSingleton();
  __resetVaultSingleton();
});

/**
 * In-memory ConfigService backed by a stub vault that does not touch Prisma.
 * We install the singleton via direct mutation of the env + a manual cache
 * seed so loadAIConfig's overlay finds the vault value.
 */
function installConfigServiceWithVaultValue(key: string, value: string): void {
  const vault = new VaultService({ masterKey: MASTER, isProduction: false });
  // Stub the vault list/read so the ConfigService preload finds our entry.
  // We drive it through the public API instead of poking internals.
  const svc = new ConfigService({ vault, env: process.env });
  // Reach into the cache directly — ConfigService exposes a test seam.
  // (Keeping the test focused on the precedence rule, not vault crypto.)
  // @ts-expect-error — accessing a private field for test seeding.
  svc["secretCache"].set(key, value);
  // @ts-expect-error — accessing a private field for test seeding.
  svc["secretSummaries"].set(key, {
    id: "v1",
    label: key,
    description: "",
    scope: "global",
    keyVersion: 1,
    algorithm: "aes-256-gcm",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // Replace the ConfigService singleton with our stubbed instance.
  __resetConfigSingleton();
  // @ts-expect-error — module-internal singleton swap for tests.
  (getConfigService as unknown as { __setForTests?: (s: ConfigService) => void }).__setForTests?.(
    svc,
  );
  // Fallback: install via global since `getConfigService` will lazily build a
  // fresh instance otherwise. We patch by monkey-replacing the module export
  // through the singleton accessor pattern: simply call get and overwrite.
  const live = getConfigService();
  // @ts-expect-error — direct private-field write to seed the singleton cache.
  live["secretCache"].set(key, value);
  // @ts-expect-error — direct private-field write to seed the singleton cache.
  live["secretSummaries"].set(key, {
    id: "v1",
    label: key,
    description: "",
    scope: "global",
    keyVersion: 1,
    algorithm: "aes-256-gcm",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("loadAIConfig vault → env precedence (#251)", () => {
  it("uses vault value when both vault and env have BEDROCK_GATEWAY_API_KEY", () => {
    installConfigServiceWithVaultValue("BEDROCK_GATEWAY_API_KEY", "vault-bedrock-key");
    const env = {
      AI_PROVIDER: "bedrock-gateway",
      BEDROCK_GATEWAY_URL: "http://gateway.internal",
      BEDROCK_GATEWAY_API_KEY: "env-bedrock-key",
      BEDROCK_ALLOWED_HOSTS: "gateway.internal",
    } as unknown as NodeJS.ProcessEnv;
    const cfg = loadAIConfig(env);
    expect(cfg.gatewayApiKey).toBe("vault-bedrock-key");
    expect(cfg.sdkProvider?.apiKey).toBe("vault-bedrock-key");
  });

  it("falls back to env when vault has no entry for the key", () => {
    // No vault seeding — just env.
    const env = {
      AI_PROVIDER: "bedrock-gateway",
      BEDROCK_GATEWAY_URL: "http://gateway.internal",
      BEDROCK_GATEWAY_API_KEY: "env-only-key",
      BEDROCK_ALLOWED_HOSTS: "gateway.internal",
    } as unknown as NodeJS.ProcessEnv;
    const cfg = loadAIConfig(env);
    expect(cfg.gatewayApiKey).toBe("env-only-key");
  });

  it("preserves provider failure semantics when neither vault nor env supplies a key", () => {
    const env = {
      AI_PROVIDER: "bedrock-gateway",
      BEDROCK_GATEWAY_URL: "http://gateway.internal",
      BEDROCK_ALLOWED_HOSTS: "gateway.internal",
    } as unknown as NodeJS.ProcessEnv;
    // No env key + no vault → loadAIConfig throws AIConfigError, same as today.
    expect(() => loadAIConfig(env)).toThrow(/BEDROCK_GATEWAY_API_KEY/);
  });

  it("does not cache the key reference across two factory builds — second build sees the rotation", () => {
    // First call: vault has "first".
    installConfigServiceWithVaultValue("BEDROCK_GATEWAY_API_KEY", "first");
    const env = {
      AI_PROVIDER: "bedrock-gateway",
      BEDROCK_GATEWAY_URL: "http://gateway.internal",
      BEDROCK_GATEWAY_API_KEY: "env-fallback",
      BEDROCK_ALLOWED_HOSTS: "gateway.internal",
      AI_OFFLINE: "1", // force offline-stub provider so buildProvider doesn't load real SDK
    } as unknown as NodeJS.ProcessEnv;
    const cfg1 = loadAIConfig(env);
    expect(cfg1.gatewayApiKey).toBe("first");
    const p1 = buildProvider({ config: cfg1 });
    expect(p1).toBeDefined();

    // Rotate the vault value out-of-band, mimicking an admin clicking "Save".
    const live = getConfigService();
    // @ts-expect-error — direct cache write for the test rotation.
    live["secretCache"].set("BEDROCK_GATEWAY_API_KEY", "second");

    const cfg2 = loadAIConfig(env);
    expect(cfg2.gatewayApiKey).toBe("second");
    expect(cfg1).not.toBe(cfg2); // each load returns a fresh AIConfig object
  });

  it("AI_PROVIDER selection still respects env (provider key is a tunable, not a secret)", () => {
    const env = {
      AI_PROVIDER: "offline-stub",
    } as unknown as NodeJS.ProcessEnv;
    const cfg = loadAIConfig(env);
    expect(cfg.provider).toBe("offline-stub");
  });
});
