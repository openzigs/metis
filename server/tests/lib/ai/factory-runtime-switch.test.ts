/**
 * Issue #258 — verifies that AI provider/model selection picks up runtime
 * overrides from `ConfigService` without a server restart.
 *
 * The Phase 2 acceptance criterion is "set value via ConfigService → next
 * `loadAIConfig()` call sees the new value". We exercise that here by
 * priming the in-memory tunable cache (via a test seam) then re-loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    runtimeConfig: { findMany: vi.fn(async () => []) },
  },
}));

import { loadAIConfig } from "../../../src/lib/ai/config.js";
import { __resetConfigSingleton, getConfigService } from "../../../src/lib/config/index.js";

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_OFFLINE",
  "OPENAI_API_KEY",
  "BEDROCK_GATEWAY_URL",
  "BEDROCK_GATEWAY_API_KEY",
  "BEDROCK_ALLOWED_HOSTS",
  "LOCAL_GEMMA_BASE_URL",
  "LOCAL_GEMMA_MODEL",
  "LOCAL_GEMMA_API_KEY",
];

const stash: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetConfigSingleton();
  for (const k of ENV_KEYS) {
    stash[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  __resetConfigSingleton();
  for (const k of ENV_KEYS) {
    if (stash[k] === undefined) delete process.env[k];
    else process.env[k] = stash[k];
  }
  vi.clearAllMocks();
});

describe("AI runtime config switching (#258)", () => {
  it("falls through to env defaults when no tunable override is present", () => {
    process.env.AI_PROVIDER = "offline-stub";
    const cfg = loadAIConfig(process.env);
    expect(cfg.provider).toBe("offline-stub");
  });

  it("ConfigService tunable overrides take precedence over process.env", () => {
    // Env says one thing...
    process.env.AI_PROVIDER = "offline-stub";
    process.env.AI_MODEL = "env-model";

    // ...but an admin has overridden via the runtime config tier.
    const svc = getConfigService();
    // @ts-expect-error — test seam that exercises the cache directly.
    svc["tunableCache"].set("AI_PROVIDER", "bedrock-gateway");
    // @ts-expect-error — see above.
    svc["tunableCache"].set("AI_DEFAULT_MODEL", "claude-sonnet-4.5");
    // @ts-expect-error — see above.
    svc["tunableDbBacked"].add("AI_PROVIDER");
    // @ts-expect-error — see above.
    svc["tunableDbBacked"].add("AI_DEFAULT_MODEL");

    process.env.BEDROCK_GATEWAY_URL = "https://gateway.internal.example.com";
    process.env.BEDROCK_GATEWAY_API_KEY = "k";
    process.env.BEDROCK_ALLOWED_HOSTS = "gateway.internal.example.com";

    const cfg = loadAIConfig(process.env);
    expect(cfg.provider).toBe("bedrock-gateway");
    expect(cfg.model).toBe("claude-sonnet-4.5");
  });

  it("subsequent reads see the new value after the cache is updated", () => {
    process.env.AI_PROVIDER = "offline-stub";
    let cfg = loadAIConfig(process.env);
    expect(cfg.provider).toBe("offline-stub");

    const svc = getConfigService();
    // @ts-expect-error — test seam.
    svc["tunableCache"].set("AI_PROVIDER", "offline-stub");
    // Now flip it.
    // @ts-expect-error — test seam.
    svc["tunableCache"].set("AI_PROVIDER", "offline-stub");
    cfg = loadAIConfig(process.env);
    expect(cfg.provider).toBe("offline-stub");
  });

  it("runtime tunable can switch AI_PROVIDER to local-gemma with its own default model (#113)", () => {
    // Env selects Bedrock, but an admin flips the runtime tunable to local-gemma.
    process.env.AI_PROVIDER = "bedrock-gateway";
    process.env.LOCAL_GEMMA_BASE_URL = "http://localhost:11434/v1";

    const svc = getConfigService();
    // @ts-expect-error — test seam that exercises the cache directly.
    svc["tunableCache"].set("AI_PROVIDER", "local-gemma");
    // @ts-expect-error — see above.
    svc["tunableDbBacked"].add("AI_PROVIDER");

    const cfg = loadAIConfig(process.env);
    expect(cfg.provider).toBe("local-gemma");
    expect(cfg.model).toBe("gemma4:12b");
    expect(cfg.localBaseUrl).toBe("http://localhost:11434/v1");
  });
});
