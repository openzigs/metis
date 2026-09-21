/**
 * Sanity tests for the static config key registry.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  getKeyDef,
  isConfigKey,
  listKeysByTier,
} from "../../../src/lib/config/key-registry.js";

describe("CONFIG_KEYS registry", () => {
  it("classifies bootstrap, secret, and tunable keys distinctly", () => {
    const bootstrap = listKeysByTier("bootstrap");
    const secret = listKeysByTier("secret");
    const tunable = listKeysByTier("tunable");
    expect(bootstrap).toContain("DATABASE_URL");
    expect(bootstrap).toContain("VAULT_MASTER_KEY");
    expect(secret).toContain("OPENAI_API_KEY");
    expect(secret).toContain("BEDROCK_GATEWAY_API_KEY");
    expect(tunable).toContain("AI_DEFAULT_MODEL");
    expect(tunable).toContain("SCHEDULER_TICK_INTERVAL_MS");
    // Disjoint sets.
    const overlap = bootstrap.filter((k) => secret.includes(k) || tunable.includes(k));
    expect(overlap).toHaveLength(0);
  });

  it("marks every secret-tier key sensitive and every csv-typed tunable non-sensitive", () => {
    for (const key of listKeysByTier("secret")) {
      expect(CONFIG_KEYS[key].sensitive).toBe(true);
    }
    for (const key of listKeysByTier("tunable")) {
      if (CONFIG_KEYS[key].valueType === "csv") {
        expect(CONFIG_KEYS[key].sensitive).toBe(false);
      }
    }
  });

  it("getKeyDef returns the entry for known keys and undefined otherwise", () => {
    expect(getKeyDef("OPENAI_API_KEY")?.tier).toBe("secret");
    expect(getKeyDef("nonexistent")).toBeUndefined();
  });

  it("isConfigKey is a tight type guard", () => {
    expect(isConfigKey("OPENAI_API_KEY")).toBe(true);
    expect(isConfigKey("MADE_UP")).toBe(false);
  });
});

// ── Per-key Zod schema coverage (#256) ───────────────────────────────────

describe("CONFIG_KEYS — per-key Zod validators", () => {
  it("every bootstrap key rejects every write attempt (z.never)", () => {
    for (const key of listKeysByTier("bootstrap")) {
      const def = CONFIG_KEYS[key];
      expect(def.schema.safeParse("any value").success).toBe(false);
      expect(def.schema.safeParse(42).success).toBe(false);
    }
  });

  it("every secret key requires a non-empty string", () => {
    for (const key of listKeysByTier("secret")) {
      const def = CONFIG_KEYS[key];
      expect(def.schema.safeParse("").success).toBe(false);
      expect(def.schema.safeParse("real-value").success).toBe(true);
    }
  });

  it("AI_PROVIDER accepts only the registered enum members", () => {
    const def = CONFIG_KEYS.AI_PROVIDER;
    expect(def.schema.safeParse("openai").success).toBe(true);
    expect(def.schema.safeParse("bedrock-gateway").success).toBe(true);
    expect(def.schema.safeParse("xxx-cloud").success).toBe(false);
  });

  it("AI_DEFAULT_MODEL rejects empty strings and absurdly long values", () => {
    const def = CONFIG_KEYS.AI_DEFAULT_MODEL;
    expect(def.schema.safeParse("gpt-4o").success).toBe(true);
    expect(def.schema.safeParse("").success).toBe(false);
    expect(def.schema.safeParse("x".repeat(500)).success).toBe(false);
  });

  it("AI_MODE accepts chat/agent/stub only", () => {
    const def = CONFIG_KEYS.AI_MODE;
    expect(def.schema.safeParse("chat").success).toBe(true);
    expect(def.schema.safeParse("agent").success).toBe(true);
    expect(def.schema.safeParse("turbo").success).toBe(false);
  });

  it("ANALYSIS_MONTHLY_TOKEN_CAP requires a positive integer", () => {
    const def = CONFIG_KEYS.ANALYSIS_MONTHLY_TOKEN_CAP;
    expect(def.schema.safeParse(1).success).toBe(true);
    expect(def.schema.safeParse("1000").success).toBe(true);
    expect(def.schema.safeParse(0).success).toBe(false);
    expect(def.schema.safeParse(-5).success).toBe(false);
    expect(def.schema.safeParse("abc").success).toBe(false);
  });

  it("ANALYSIS_AGENT_TOKEN_CAP requires a positive integer", () => {
    const def = CONFIG_KEYS.ANALYSIS_AGENT_TOKEN_CAP;
    expect(def.schema.safeParse(1000).success).toBe(true);
    expect(def.schema.safeParse(0).success).toBe(false);
  });

  it("PUBLISH_RATE_LIMIT_DELAY_MS allows zero and rejects negatives", () => {
    const def = CONFIG_KEYS.PUBLISH_RATE_LIMIT_DELAY_MS;
    expect(def.schema.safeParse(0).success).toBe(true);
    expect(def.schema.safeParse(500).success).toBe(true);
    expect(def.schema.safeParse(-1).success).toBe(false);
  });

  it("PUBLISH_MAX_RETRIES is bounded 0..10", () => {
    const def = CONFIG_KEYS.PUBLISH_MAX_RETRIES;
    expect(def.schema.safeParse(0).success).toBe(true);
    expect(def.schema.safeParse(10).success).toBe(true);
    expect(def.schema.safeParse(11).success).toBe(false);
    expect(def.schema.safeParse(-1).success).toBe(false);
  });

  it("SCHEDULER_ENABLED coerces booleans", () => {
    const def = CONFIG_KEYS.SCHEDULER_ENABLED;
    expect(def.schema.safeParse(true).success).toBe(true);
    expect(def.schema.safeParse(false).success).toBe(true);
    // z.coerce.boolean accepts almost anything; we only validate the type.
    expect(def.schema.safeParse("true").success).toBe(true);
  });

  it("SCHEDULER_TICK_INTERVAL_MS requires a positive integer", () => {
    const def = CONFIG_KEYS.SCHEDULER_TICK_INTERVAL_MS;
    expect(def.schema.safeParse(1000).success).toBe(true);
    expect(def.schema.safeParse(0).success).toBe(false);
  });

  it("MCP_HEALTH_ALLOW_PARTIAL coerces booleans", () => {
    const def = CONFIG_KEYS.MCP_HEALTH_ALLOW_PARTIAL;
    expect(def.schema.safeParse(true).success).toBe(true);
  });

  it("DB_ALLOWED_HOSTS accepts comma-separated hostnames", () => {
    const def = CONFIG_KEYS.DB_ALLOWED_HOSTS;
    expect(def.schema.safeParse("a.com,b.com").success).toBe(true);
    expect(def.schema.safeParse(["a.com", "b.com"]).success).toBe(true);
    expect(def.schema.safeParse("a.com,not a host").success).toBe(false);
    expect(def.schema.safeParse("").success).toBe(true); // empty list — caller decides what to do
  });

  it("REPO_ALLOWED_HOSTS rejects malformed hostnames", () => {
    const def = CONFIG_KEYS.REPO_ALLOWED_HOSTS;
    expect(def.schema.safeParse("github.com").success).toBe(true);
    expect(def.schema.safeParse("github..com").success).toBe(false);
  });

  it("PUBLISH_GITHUB_ALLOWED_HOSTS validates the GitHub hostname list", () => {
    const def = CONFIG_KEYS.PUBLISH_GITHUB_ALLOWED_HOSTS;
    expect(def.schema.safeParse("github.com,enterprise.example.com").success).toBe(true);
    expect(def.schema.safeParse("just bad").success).toBe(false);
  });

  it("MCP_K8S_MEMORY_LIMIT enforces ≤ 16Gi", () => {
    const def = CONFIG_KEYS.MCP_K8S_MEMORY_LIMIT;
    expect(def.schema.safeParse("512Mi").success).toBe(true);
    expect(def.schema.safeParse("16Gi").success).toBe(true);
    expect(def.schema.safeParse("32Gi").success).toBe(false);
    expect(def.schema.safeParse("20480Mi").success).toBe(false);
    expect(def.schema.safeParse("not-a-quantity").success).toBe(false);
  });

  it("MCP_K8S_CPU_LIMIT enforces ≤ 8000m / 8 cores", () => {
    const def = CONFIG_KEYS.MCP_K8S_CPU_LIMIT;
    expect(def.schema.safeParse("1000m").success).toBe(true);
    expect(def.schema.safeParse("8000m").success).toBe(true);
    expect(def.schema.safeParse("8").success).toBe(true);
    expect(def.schema.safeParse("16000m").success).toBe(false);
    expect(def.schema.safeParse("16").success).toBe(false);
  });

  it("MCP_K8S_EGRESS_ALLOWLIST rejects unprefixed entries", () => {
    const def = CONFIG_KEYS.MCP_K8S_EGRESS_ALLOWLIST;
    expect(def.schema.safeParse("cidr:10.0.0.0/8,host:api.github.com").success).toBe(true);
    expect(def.schema.safeParse("api.github.com").success).toBe(false);
    expect(def.schema.safeParse("cidr:").success).toBe(false);
  });

  // #824 (Epic #820 Phase 1) — the AFFECTED SCHEMA tunables the strict config
  // service must recognise (else `ConfigUnknownKeyError`), registered alongside
  // the #735 ANALYSIS_AFFECTED_CODE_* keys.
  it("registers the ANALYSIS_AFFECTED_SCHEMA_* tunables (#824)", () => {
    const tunable = listKeysByTier("tunable");
    for (const key of [
      "ANALYSIS_AFFECTED_SCHEMA_MAPPING",
      "ANALYSIS_AFFECTED_SCHEMA_TOKEN_BUDGET",
      "ANALYSIS_AFFECTED_SCHEMA_MAX_ROWS",
    ] as const) {
      expect(tunable).toContain(key);
      expect(isConfigKey(key)).toBe(true);
      expect(CONFIG_KEYS[key].sensitive).toBe(false);
    }
    // The master flag is a boolean; the budgets are positive ints.
    expect(CONFIG_KEYS.ANALYSIS_AFFECTED_SCHEMA_MAPPING.valueType).toBe("bool");
    expect(CONFIG_KEYS.ANALYSIS_AFFECTED_SCHEMA_MAPPING.schema.safeParse("true").success).toBe(
      true,
    );
    expect(CONFIG_KEYS.ANALYSIS_AFFECTED_SCHEMA_TOKEN_BUDGET.schema.safeParse("1200").success).toBe(
      true,
    );
    expect(CONFIG_KEYS.ANALYSIS_AFFECTED_SCHEMA_TOKEN_BUDGET.schema.safeParse("0").success).toBe(
      false,
    );
    expect(CONFIG_KEYS.ANALYSIS_AFFECTED_SCHEMA_MAX_ROWS.schema.safeParse("8").success).toBe(true);
    expect(CONFIG_KEYS.ANALYSIS_AFFECTED_SCHEMA_MAX_ROWS.schema.safeParse("-1").success).toBe(
      false,
    );
  });

  // ── #1321 — the online-eval results directory ─────────────────────────────
  it("keeps ONLINE_EVAL_RESULTS_DIR env-only: a runtime-settable path is a write primitive", () => {
    // It is the only filesystem path in the registry and the server `mkdir -p`s
    // it and writes into it. `tunable` would let any `admin.write` caller
    // retarget the write at an arbitrary directory (OWASP A01/A05).
    expect(CONFIG_KEYS.ONLINE_EVAL_RESULTS_DIR.tier).toBe("bootstrap");
    expect(listKeysByTier("tunable")).not.toContain("ONLINE_EVAL_RESULTS_DIR");
    // Bootstrap entries carry `z.never()`, so even a write that slipped past
    // the route layer fails validation.
    expect(CONFIG_KEYS.ONLINE_EVAL_RESULTS_DIR.schema.safeParse("/etc").success).toBe(false);
  });

  it("leaves the rest of the online-eval knobs runtime-tunable", () => {
    for (const key of [
      "ONLINE_EVAL_ENABLED",
      "ONLINE_EVAL_SAMPLE_RATE",
      "ONLINE_EVAL_MONTHLY_TOKEN_BUDGET",
      "ONLINE_EVAL_DRIFT_ALERTS_ENABLED",
    ] as const) {
      expect(CONFIG_KEYS[key].tier).toBe("tunable");
    }
  });

  it("has no other filesystem-path key sitting in the tunable tier", () => {
    // A guard against the next one: if this fails, either the new key belongs in
    // `bootstrap` or it needs a containment check of its own.
    const pathish = listKeysByTier("tunable").filter((k) => /(_DIR|_PATH|_HOME)$/.test(k));
    expect(pathish).toEqual([]);
  });
});
