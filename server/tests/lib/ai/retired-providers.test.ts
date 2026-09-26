/**
 * #149 (epic #130, P4) — GitHub Copilot support is removed. Every place that can
 * still NAME the removed `copilot-native` provider must refuse it loudly, with
 * one message that names the supported providers and the migration note —
 * never fall through to another provider:
 *
 *   • `AI_PROVIDER` in env                 → `loadAIConfig` + the boot check
 *   • `AI_PROVIDER` in the runtime config  → `loadAIConfig` (it overlays env)
 *                                            + the boot-time runtime check
 *   • a Copilot-era env fallback name      → `loadAIConfig`, naming the rename
 *   • the runtime-config write path        → the registry schema
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    runtimeConfig: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
  },
}));

import { AI_PROVIDER_KEYS } from "@metis/shared";
import {
  assertNoRetiredProviderConfig,
  loadAIConfig,
  SUPPORTED_PROVIDER_KEYS,
} from "../../../src/lib/ai/config.js";
import { AIConfigError } from "../../../src/lib/ai/errors.js";
import {
  COPILOT_MIGRATION_DOC,
  findRetiredEnvRenames,
  isRetiredProviderKey,
  retiredProviderMessage,
} from "../../../src/lib/ai/retired-providers.js";
import { __resetConfigSingleton, getConfigService } from "../../../src/lib/config/index.js";
import { getKeyDef } from "../../../src/lib/config/key-registry.js";
import {
  assertStartupAIProviderConfig,
  assertStartupRuntimeAIProvider,
} from "../../../src/index.js";

beforeEach(() => __resetConfigSingleton());
afterEach(() => __resetConfigSingleton());

/** Every supported key, verbatim, in the message. */
function expectNamesSupportedProviders(message: string): void {
  for (const key of AI_PROVIDER_KEYS) expect(message).toContain(key);
}

describe("the retired-provider vocabulary", () => {
  it("copilot-native is retired, matched case- and whitespace-insensitively; supported keys are not", () => {
    expect(isRetiredProviderKey("copilot-native")).toBe(true);
    expect(isRetiredProviderKey("  Copilot-Native ")).toBe(true);
    for (const key of AI_PROVIDER_KEYS) expect(isRetiredProviderKey(key)).toBe(false);
    expect(isRetiredProviderKey(undefined)).toBe(false);
    expect(isRetiredProviderKey(42)).toBe(false);
  });

  it("the supported list no longer contains copilot-native — in the server and the shared constant", () => {
    expect(SUPPORTED_PROVIDER_KEYS as readonly string[]).not.toContain("copilot-native");
    expect(AI_PROVIDER_KEYS as readonly string[]).not.toContain("copilot-native");
    // One list: the UI picker and the server validator agree exactly.
    expect([...SUPPORTED_PROVIDER_KEYS].sort()).toEqual([...AI_PROVIDER_KEYS].sort());
  });

  it("the message names what was found, the supported providers and the migration note", () => {
    const m = retiredProviderMessage("copilot-native");
    expect(m).toContain('AI_PROVIDER is set to "copilot-native"');
    expect(m).toContain("GitHub Copilot support was removed");
    expectNamesSupportedProviders(m);
    expect(m).toContain(COPILOT_MIGRATION_DOC);
  });

  it("a session message says the session stays readable instead of listing providers", () => {
    const m = retiredProviderMessage("copilot-native", "session");
    expect(m).toMatch(/stays readable/);
    expect(m).toMatch(/start a new chat/);
    expect(m).toContain(COPILOT_MIGRATION_DOC);
  });
});

describe("loadAIConfig refuses copilot-native by name (#149)", () => {
  it("AI_PROVIDER=copilot-native is an AIConfigError naming the supported providers", () => {
    let caught: unknown;
    try {
      loadAIConfig({ AI_PROVIDER: "copilot-native" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIConfigError);
    const message = (caught as Error).message;
    expect(message).toContain('AI_PROVIDER is set to "copilot-native"');
    expectNamesSupportedProviders(message);
    expect(message).toContain(COPILOT_MIGRATION_DOC);
    // Not the schema's generic "Invalid enum value".
    expect(message).not.toMatch(/Invalid AI configuration/);
  });

  it("is refused even with credentials for another (paid) provider present — never a fallback", () => {
    expect(() =>
      loadAIConfig({
        AI_PROVIDER: "copilot-native",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_API_KEY: "sk",
      }),
    ).toThrow(/GitHub Copilot support was removed/);
  });

  it("a runtime-config row selecting copilot-native wins over env and is refused as such", () => {
    const svc = getConfigService();
    // @ts-expect-error — test seam: prime the tunable cache as loadTunables() would.
    svc["tunableCache"].set("AI_PROVIDER", "copilot-native");
    // @ts-expect-error — see above.
    svc["tunableDbBacked"].add("AI_PROVIDER");
    const env = { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant" };
    expect(() => loadAIConfig(env)).toThrow(
      /runtime configuration .* selects AI provider "copilot-native"/,
    );
  });

  it("the runtime-config write path rejects copilot-native", () => {
    const def = getKeyDef("AI_PROVIDER")!;
    expect(def.schema.safeParse("copilot-native").success).toBe(false);
    expect(def.schema.safeParse("anthropic").success).toBe(true);
  });

  it("AI_OFFLINE still wins over a leftover Copilot-era variable", () => {
    expect(
      loadAIConfig({
        AI_PROVIDER: "openai",
        AI_OFFLINE: "1",
        COPILOT_PROVIDER_BASE_URL: "http://x",
      }).provider,
    ).toBe("offline-stub");
  });

  it("a leftover COPILOT_* variable is harmless for a provider that never read it", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "local-gemma",
      LOCAL_GEMMA_BASE_URL: "http://localhost:11434/v1",
      COPILOT_PROVIDER_BASE_URL: "https://proxy.example.com/v1",
      COPILOT_PROVIDER_API_KEY: "sk-legacy",
      COPILOT_MODEL: "gpt-4.1",
      COPILOT_OFFLINE: "true",
    });
    expect(cfg.provider).toBe("local-gemma");
    expect(cfg.model).toBe("gemma4:12b");
  });
});

describe("findRetiredEnvRenames", () => {
  it("names only the retired names whose replacement is unset, and only for openai/azure", () => {
    const env = {
      COPILOT_PROVIDER_BASE_URL: "https://x",
      COPILOT_PROVIDER_API_KEY: "  ",
      COPILOT_MODEL: "gpt-5",
      AI_MODEL: "gpt-4o",
    };
    expect(findRetiredEnvRenames("openai", env)).toEqual([
      { retired: "COPILOT_PROVIDER_BASE_URL", replacement: "OPENAI_BASE_URL" },
    ]);
    expect(findRetiredEnvRenames("azure", env)).toEqual([
      { retired: "COPILOT_PROVIDER_BASE_URL", replacement: "AZURE_OPENAI_ENDPOINT" },
    ]);
    expect(findRetiredEnvRenames("anthropic", env)).toEqual([]);
  });
});

describe("boot-time checks (#149)", () => {
  it("assertStartupAIProviderConfig throws for AI_PROVIDER=copilot-native and passes a supported one", () => {
    expect(() => assertStartupAIProviderConfig({ AI_PROVIDER: "copilot-native" })).toThrow(
      /GitHub Copilot support was removed/,
    );
    expect(() => assertStartupAIProviderConfig({ AI_PROVIDER: "offline-stub" })).not.toThrow();
    expect(() => assertStartupAIProviderConfig({})).not.toThrow();
  });

  it("assertStartupAIProviderConfig names an un-renamed Copilot-era variable", () => {
    expect(() =>
      assertStartupAIProviderConfig({
        AI_PROVIDER: "openai",
        COPILOT_PROVIDER_BASE_URL: "https://x",
      }),
    ).toThrow(/COPILOT_PROVIDER_BASE_URL → OPENAI_BASE_URL/);
  });

  it("assertStartupRuntimeAIProvider throws for a runtime-config row naming copilot-native", async () => {
    await expect(assertStartupRuntimeAIProvider(async () => "copilot-native")).rejects.toThrow(
      /runtime configuration .* selects AI provider "copilot-native"/,
    );
    await expect(assertStartupRuntimeAIProvider(async () => "anthropic")).resolves.toBeUndefined();
    await expect(assertStartupRuntimeAIProvider(async () => null)).resolves.toBeUndefined();
  });

  it("the default reader looks up the AI_PROVIDER runtime_config row", async () => {
    const { prisma } = await import("../../../src/lib/prisma.js");
    const findUnique = prisma.runtimeConfig.findUnique as unknown as ReturnType<typeof vi.fn>;
    findUnique.mockResolvedValueOnce({ key: "AI_PROVIDER", value: "copilot-native" });
    await expect(assertStartupRuntimeAIProvider()).rejects.toThrow(/copilot-native/);
    expect(findUnique).toHaveBeenCalledWith({ where: { key: "AI_PROVIDER" } });
  });

  it("assertNoRetiredProviderConfig names the runtime config only when the value came from it", () => {
    expect(() => assertNoRetiredProviderConfig({ AI_PROVIDER: "copilot-native" })).toThrow(
      /AI_PROVIDER is set to/,
    );
    expect(() =>
      assertNoRetiredProviderConfig(
        { AI_PROVIDER: "anthropic" },
        { AI_PROVIDER: "copilot-native" },
      ),
    ).toThrow(/runtime configuration/);
  });
});
