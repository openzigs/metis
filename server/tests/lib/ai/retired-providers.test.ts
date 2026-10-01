/**
 * #149 (epic #130, P4) — GitHub Copilot support is removed. Every place that can
 * still NAME the removed `copilot-native` provider must refuse it loudly, with
 * one message that names the supported providers and the migration note —
 * never fall through to another provider:
 *
 *   • `AI_PROVIDER` in env                 → `loadAIConfig` + the pre-I/O boot check
 *   • `AI_PROVIDER` in the runtime config  → `loadAIConfig` (it overlays env)
 *                                            + the effective boot check (logged)
 *   • a Copilot-era env fallback name      → `loadAIConfig`, naming the rename,
 *                                            + the effective boot check (fatal) —
 *                                            both over the SAME overlaid view
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
import { AIConfigError, AIProviderRetiredError } from "../../../src/lib/ai/errors.js";
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
  assertStartupEffectiveAIProviderConfig,
  isBootTolerableAIConfigError,
} from "../../../src/index.js";

/** Prime the ConfigService caches as `loadSecrets()` / `loadTunables()` would. */
function primeOverlay(opts: {
  secrets?: Record<string, string>;
  tunables?: Record<string, string>;
}) {
  const svc = getConfigService();
  for (const [k, v] of Object.entries(opts.secrets ?? {})) {
    // Test seam: the vault preload cache (bracket access reaches the private field).
    svc["secretCache"].set(k, v);
  }
  for (const [k, v] of Object.entries(opts.tunables ?? {})) {
    // Test seam: the runtime_config preload cache (bracket access reaches the private field).
    svc["tunableCache"].set(k, v);
    svc["tunableDbBacked"].add(k);
  }
}

beforeEach(() => __resetConfigSingleton());
afterEach(() => {
  vi.restoreAllMocks();
  __resetConfigSingleton();
});

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
    // Test seam: prime the tunable cache as loadTunables() would (bracket access reaches the private field).
    svc["tunableCache"].set("AI_PROVIDER", "copilot-native");
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
    expect(() => assertStartupAIProviderConfig({ AI_PROVIDER: " Copilot-Native " })).toThrow(
      AIProviderRetiredError,
    );
    expect(() => assertStartupAIProviderConfig({ AI_PROVIDER: "offline-stub" })).not.toThrow();
    expect(() => assertStartupAIProviderConfig({})).not.toThrow();
  });

  it("an env AI_PROVIDER=copilot-native is never boot-tolerable — the process must exit", async () => {
    let caught: unknown;
    try {
      assertStartupAIProviderConfig({ AI_PROVIDER: "copilot-native" });
    } catch (err) {
      caught = err;
    }
    expect(isBootTolerableAIConfigError(caught)).toBe(false);
    // The effective check refuses it the same way (were the pre-I/O check skipped).
    await expect(
      assertStartupEffectiveAIProviderConfig({ AI_PROVIDER: "copilot-native" }, async () => {}),
    ).rejects.toSatisfy((err: unknown) => !isBootTolerableAIConfigError(err));
  });

  it("the pre-I/O check leaves the rename check to the effective check (it needs the overlay)", () => {
    expect(() =>
      assertStartupAIProviderConfig({
        AI_PROVIDER: "openai",
        COPILOT_PROVIDER_BASE_URL: "https://x",
      }),
    ).not.toThrow();
  });

  describe("the effective check applies the request path's rule to the request path's view (A1)", () => {
    const leftoverKey = {
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      COPILOT_PROVIDER_API_KEY: "sk-legacy",
    };
    const leftoverModel = {
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_API_KEY: "sk",
      // Not the shipped default (gpt-4.1), which is exempt as harmless to drop.
      COPILOT_MODEL: "gpt-4o",
    };

    it("boots: a leftover COPILOT_PROVIDER_API_KEY in env with OPENAI_API_KEY in the vault", async () => {
      const preload = async () => primeOverlay({ secrets: { OPENAI_API_KEY: "sk-vault" } });
      await expect(assertStartupEffectiveAIProviderConfig(leftoverKey, preload)).resolves.toBe(
        undefined,
      );
      // …and the first request agrees: same view, same answer.
      expect(loadAIConfig(leftoverKey).provider).toBe("openai");
    });

    it("boots: COPILOT_MODEL in env with AI_DEFAULT_MODEL in the runtime configuration", async () => {
      const preload = async () => primeOverlay({ tunables: { AI_DEFAULT_MODEL: "gpt-4o-mini" } });
      await expect(assertStartupEffectiveAIProviderConfig(leftoverModel, preload)).resolves.toBe(
        undefined,
      );
      expect(loadAIConfig(leftoverModel).model).toBe("gpt-4o-mini");
    });

    it("still refuses both when nothing overlays the retired name — and the refusal is fatal", async () => {
      for (const [env, rename] of [
        [leftoverKey, /COPILOT_PROVIDER_API_KEY → OPENAI_API_KEY/],
        [leftoverModel, /COPILOT_MODEL → AI_MODEL/],
      ] as const) {
        let caught: unknown;
        try {
          await assertStartupEffectiveAIProviderConfig(env, async () => {});
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(AIConfigError);
        expect((caught as Error).message).toMatch(rename);
        expect(isBootTolerableAIConfigError(caught)).toBe(false);
        // The request path refuses the same configuration identically.
        expect(() => loadAIConfig(env)).toThrow(rename);
      }
    });

    it("an un-renamed COPILOT_PROVIDER_BASE_URL is refused, naming the rename", async () => {
      await expect(
        assertStartupEffectiveAIProviderConfig(
          { AI_PROVIDER: "openai", COPILOT_PROVIDER_BASE_URL: "https://x" },
          async () => {},
        ),
      ).rejects.toThrow(/COPILOT_PROVIDER_BASE_URL → OPENAI_BASE_URL/);
    });

    it("a runtime-config row naming copilot-native is refused but boot-tolerable (fixed in Admin → Settings)", async () => {
      const preload = async () => primeOverlay({ tunables: { AI_PROVIDER: "copilot-native" } });
      let caught: unknown;
      try {
        await assertStartupEffectiveAIProviderConfig(
          { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant" },
          preload,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AIProviderRetiredError);
      expect((caught as Error).message).toMatch(
        /runtime configuration .* selects AI provider "copilot-native"/,
      );
      expect(isBootTolerableAIConfigError(caught)).toBe(true);
    });

    it("the default preload loads the vault secrets and the runtime tunables first", async () => {
      const svc = getConfigService();
      const secrets = vi.spyOn(svc, "loadSecrets").mockResolvedValue(undefined);
      const tunables = vi.spyOn(svc, "loadTunables").mockResolvedValue(undefined);
      await assertStartupEffectiveAIProviderConfig({ AI_PROVIDER: "offline-stub" });
      expect(secrets).toHaveBeenCalledTimes(1);
      expect(tunables).toHaveBeenCalledTimes(1);
    });

    it("a failing preload is not fatal on its own: the check falls back to env, like requests do", async () => {
      const svc = getConfigService();
      vi.spyOn(svc, "loadSecrets").mockRejectedValue(new Error("vault down"));
      vi.spyOn(svc, "loadTunables").mockRejectedValue(new Error("db down"));
      await expect(
        assertStartupEffectiveAIProviderConfig({ AI_PROVIDER: "offline-stub" }),
      ).resolves.toBeUndefined();
    });
  });

  it("isBootTolerableAIConfigError is false for anything that is not a runtime-config retirement", () => {
    expect(isBootTolerableAIConfigError(new AIConfigError("x"))).toBe(false);
    expect(isBootTolerableAIConfigError(new Error("x"))).toBe(false);
    expect(
      isBootTolerableAIConfigError(new AIProviderRetiredError("x", { source: "AI_PROVIDER" })),
    ).toBe(false);
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

describe("a retired provider is a 409 AI_PROVIDER_RETIRED wherever it is selected (A3)", () => {
  it("from env: the request path's error carries 409 / AI_PROVIDER_RETIRED and stays an AIConfigError", () => {
    let caught: unknown;
    try {
      loadAIConfig({ AI_PROVIDER: "copilot-native" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIProviderRetiredError);
    // Still a config error: every `instanceof AIConfigError` refusal keeps refusing.
    expect(caught).toBeInstanceOf(AIConfigError);
    expect(caught).toMatchObject({ status: 409, code: "AI_PROVIDER_RETIRED" });
  });

  it("from the runtime configuration: the same code, status and actionable message", () => {
    primeOverlay({ tunables: { AI_PROVIDER: "copilot-native" } });
    let caught: unknown;
    try {
      loadAIConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 409, code: "AI_PROVIDER_RETIRED" });
    expectNamesSupportedProviders((caught as Error).message);
    expect((caught as Error).message).toContain(COPILOT_MIGRATION_DOC);
  });

  it("a rename refusal is NOT a retirement: it stays a 500 AI_CONFIG_INVALID", () => {
    let caught: unknown;
    try {
      loadAIConfig({ AI_PROVIDER: "openai", COPILOT_PROVIDER_BASE_URL: "https://x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AIProviderRetiredError);
    expect(caught).toMatchObject({ status: 500, code: "AI_CONFIG_INVALID" });
  });
});
