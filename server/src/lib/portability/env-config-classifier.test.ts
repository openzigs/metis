import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, listKeysByTier } from "../config/key-registry.js";
import {
  ENV_SPECIFIC_TUNABLE_KEYS,
  classifyConfigKey,
  listBootstrapKeys,
  listEnvSpecificTunables,
  listSecretKeys,
  type PortabilityClass,
} from "./env-config-classifier.js";

// ── ENV_SPECIFIC_TUNABLE_KEYS integrity ───────────────────────────────────────

describe("ENV_SPECIFIC_TUNABLE_KEYS", () => {
  it("every entry exists in CONFIG_KEYS", () => {
    for (const key of ENV_SPECIFIC_TUNABLE_KEYS) {
      expect(CONFIG_KEYS[key], `key "${key}" missing from CONFIG_KEYS`).toBeDefined();
    }
  });

  it("every entry has tier 'tunable'", () => {
    for (const key of ENV_SPECIFIC_TUNABLE_KEYS) {
      expect(CONFIG_KEYS[key]?.tier, `key "${key}" has wrong tier`).toBe("tunable");
    }
  });

  it("is non-empty", () => {
    expect(ENV_SPECIFIC_TUNABLE_KEYS.length).toBeGreaterThan(0);
  });
});

// ── classifyConfigKey ─────────────────────────────────────────────────────────

describe("classifyConfigKey", () => {
  // One representative key per class — all verified to exist in CONFIG_KEYS.

  it("classifies a bootstrap key as 'bootstrap-out-of-band'", () => {
    // DATABASE_URL is tier "bootstrap"
    const result: PortabilityClass = classifyConfigKey("DATABASE_URL");
    expect(result).toBe("bootstrap-out-of-band");
  });

  it("classifies a secret key as 'secret'", () => {
    // OPENAI_API_KEY is tier "secret"
    const result: PortabilityClass = classifyConfigKey("OPENAI_API_KEY");
    expect(result).toBe("secret");
  });

  it("classifies an env-specific tunable as 'env-specific-tunable'", () => {
    // LOCAL_GEMMA_BASE_URL is tier "tunable" and in ENV_SPECIFIC_TUNABLE_KEYS
    const result: PortabilityClass = classifyConfigKey("LOCAL_GEMMA_BASE_URL");
    expect(result).toBe("env-specific-tunable");
  });

  it("classifies a portable tunable as 'portable-tunable'", () => {
    // AI_PROVIDER is tier "tunable" and NOT in ENV_SPECIFIC_TUNABLE_KEYS
    const result: PortabilityClass = classifyConfigKey("AI_PROVIDER");
    expect(result).toBe("portable-tunable");
  });

  it("classifies all bootstrap keys correctly", () => {
    for (const key of listKeysByTier("bootstrap")) {
      expect(classifyConfigKey(key), key).toBe("bootstrap-out-of-band");
    }
  });

  it("classifies all secret keys correctly", () => {
    for (const key of listKeysByTier("secret")) {
      expect(classifyConfigKey(key), key).toBe("secret");
    }
  });

  it("classifies all ENV_SPECIFIC_TUNABLE_KEYS as 'env-specific-tunable'", () => {
    for (const key of ENV_SPECIFIC_TUNABLE_KEYS) {
      expect(classifyConfigKey(key), key).toBe("env-specific-tunable");
    }
  });

  it("classifies tunable keys NOT in the allowlist as 'portable-tunable'", () => {
    const portableTunables = listKeysByTier("tunable").filter(
      (k) => !(ENV_SPECIFIC_TUNABLE_KEYS as readonly string[]).includes(k),
    );
    expect(portableTunables.length).toBeGreaterThan(0);
    for (const key of portableTunables) {
      expect(classifyConfigKey(key), key).toBe("portable-tunable");
    }
  });

  // ── Unknown-key behaviour ──────────────────────────────────────────────────
  // classifyConfigKey throws RangeError for unknown keys (documented in module).

  it("throws RangeError for an unknown key", () => {
    expect(() => classifyConfigKey("TOTALLY_UNKNOWN_KEY_XYZ")).toThrow(RangeError);
  });

  it("error message identifies the unknown key", () => {
    expect(() => classifyConfigKey("NONEXISTENT_KEY")).toThrow(/NONEXISTENT_KEY/);
  });

  it("throws RangeError for an empty string key", () => {
    expect(() => classifyConfigKey("")).toThrow(RangeError);
  });
});

// ── listSecretKeys ────────────────────────────────────────────────────────────

describe("listSecretKeys", () => {
  it("matches listKeysByTier('secret')", () => {
    expect(listSecretKeys().sort()).toEqual(listKeysByTier("secret").sort());
  });

  it("contains known secret keys", () => {
    const secrets = listSecretKeys();
    expect(secrets).toContain("OPENAI_API_KEY");
    expect(secrets).toContain("GITHUB_TOKEN");
    expect(secrets).toContain("ANTHROPIC_API_KEY");
  });

  it("contains no bootstrap or tunable keys", () => {
    const secrets = new Set(listSecretKeys());
    for (const key of listKeysByTier("bootstrap")) {
      expect(secrets.has(key), `bootstrap key "${key}" in secret list`).toBe(false);
    }
    for (const key of listKeysByTier("tunable")) {
      expect(secrets.has(key), `tunable key "${key}" in secret list`).toBe(false);
    }
  });
});

// ── listBootstrapKeys ─────────────────────────────────────────────────────────

describe("listBootstrapKeys", () => {
  it("matches listKeysByTier('bootstrap')", () => {
    expect(listBootstrapKeys().sort()).toEqual(listKeysByTier("bootstrap").sort());
  });

  it("contains known bootstrap keys", () => {
    const bootstrap = listBootstrapKeys();
    expect(bootstrap).toContain("DATABASE_URL");
    expect(bootstrap).toContain("JWT_SECRET");
    expect(bootstrap).toContain("NODE_ENV");
  });

  it("contains no secret or tunable keys", () => {
    const bootstrap = new Set(listBootstrapKeys());
    for (const key of listKeysByTier("secret")) {
      expect(bootstrap.has(key), `secret key "${key}" in bootstrap list`).toBe(false);
    }
    for (const key of listKeysByTier("tunable")) {
      expect(bootstrap.has(key), `tunable key "${key}" in bootstrap list`).toBe(false);
    }
  });
});

// ── listEnvSpecificTunables ───────────────────────────────────────────────────

describe("listEnvSpecificTunables", () => {
  it("returns all ENV_SPECIFIC_TUNABLE_KEYS entries", () => {
    expect(listEnvSpecificTunables().sort()).toEqual([...ENV_SPECIFIC_TUNABLE_KEYS].sort());
  });

  it("every returned key has tier 'tunable' in CONFIG_KEYS", () => {
    for (const key of listEnvSpecificTunables()) {
      expect(CONFIG_KEYS[key]?.tier, key).toBe("tunable");
    }
  });
});
