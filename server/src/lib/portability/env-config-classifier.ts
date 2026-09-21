/**
 * Portability classification for METIS config keys.
 *
 * Each key in CONFIG_KEYS is assigned one of four portability classes:
 *
 *   - `bootstrap-out-of-band`  — bootstrap-tier keys; must be provisioned
 *                                 out-of-band in the target environment (never
 *                                 exportable via this tool).
 *   - `secret`                 — secret-tier keys; encrypted in the vault.
 *                                 Importable only when VAULT_MASTER_KEY is
 *                                 present in the target environment.
 *   - `env-specific-tunable`   — tunable-tier keys whose values are tightly
 *                                 coupled to infrastructure topology (URLs,
 *                                 hostnames, k8s namespaces, docker networks,
 *                                 egress allowlists, image allowlists). These
 *                                 MUST be reviewed and overridden by an
 *                                 operator after import.
 *   - `portable-tunable`       — tunable-tier keys that are typically the
 *                                 same across environments (feature flags,
 *                                 numeric caps, timeouts). Safe to carry over
 *                                 verbatim in most cases.
 *
 * Unknown-key behaviour: `classifyConfigKey` throws a `RangeError` for any
 * key not present in CONFIG_KEYS. This is intentional — callers should verify
 * keys exist before classifying them, and a silent wrong classification would
 * be worse than a loud error.
 */

import { CONFIG_KEYS, listKeysByTier } from "../config/key-registry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PortabilityClass =
  | "bootstrap-out-of-band"
  | "secret"
  | "env-specific-tunable"
  | "portable-tunable";

// ── Env-specific tunable allowlist ────────────────────────────────────────────

/**
 * Allowlist of tunable keys whose values are environment/infrastructure-
 * specific (URLs, hostnames, k8s namespaces, docker network names, egress
 * CIDRs, container image globs). This subset is NOT mechanically derivable
 * from the registry — the registry's tier field only says "tunable", not
 * "topology-coupled" — so it is maintained here as a documented constant.
 *
 * MAINTENANCE: Every entry in this list MUST:
 *   (a) exist in CONFIG_KEYS, and
 *   (b) have tier === "tunable".
 * The module-load self-check below enforces this at startup/import time.
 * Do NOT add keys of other tiers; they are already classified by tier above.
 *
 * Verified against server/src/lib/config/key-registry.ts:
 */
export const ENV_SPECIFIC_TUNABLE_KEYS: readonly string[] = [
  // ── AI provider endpoint ──────────────────────────────────────────────────
  "LOCAL_GEMMA_BASE_URL", // base URL for local Ollama/vLLM server

  // ── Docker MCP infrastructure ────────────────────────────────────────────
  "MCP_DOCKER_NETWORK", // user-defined docker bridge network name
  "MCP_IMAGE_ALLOWLIST", // container image registry glob allowlist

  // ── Kubernetes MCP infrastructure ────────────────────────────────────────
  "MCP_K8S_NAMESPACE", // k8s namespace for MCP Deployments/Services
  "MCP_K8S_SERVICE_DOMAIN", // in-cluster DNS suffix (e.g. cluster.local)
  "MCP_K8S_EGRESS_ALLOWLIST", // per-pod NetworkPolicy egress CIDRs/hosts

  // ── Database and repository host allowlists ───────────────────────────────
  "DB_ALLOWED_HOSTS", // database hostname allowlist
  "REPO_ALLOWED_HOSTS", // repository hostname allowlist
  "PUBLISH_GITHUB_ALLOWED_HOSTS", // GitHub Enterprise publish hostname allowlist
] as const;

// ── Module-load self-check ────────────────────────────────────────────────────

// Verify at import time that every ENV_SPECIFIC_TUNABLE_KEYS entry exists in
// CONFIG_KEYS with tier "tunable". This catches registry drift (a key renamed
// or re-tiered) at startup rather than silently producing wrong classifications.
for (const key of ENV_SPECIFIC_TUNABLE_KEYS) {
  const def = CONFIG_KEYS[key];
  if (!def) {
    throw new Error(
      `[env-config-classifier] ENV_SPECIFIC_TUNABLE_KEYS references unknown key "${key}". ` +
        `Update the allowlist to match the current key-registry.`,
    );
  }
  if (def.tier !== "tunable") {
    throw new Error(
      `[env-config-classifier] ENV_SPECIFIC_TUNABLE_KEYS entry "${key}" has tier "${def.tier}", ` +
        `but only "tunable" keys belong in this allowlist. ` +
        `Keys of other tiers are classified automatically by tier.`,
    );
  }
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Returns the {@link PortabilityClass} for a known config key.
 *
 * @throws {RangeError} if `key` is not present in CONFIG_KEYS.
 */
export function classifyConfigKey(key: string): PortabilityClass {
  const def = CONFIG_KEYS[key];
  if (!def) {
    throw new RangeError(
      `classifyConfigKey: unknown config key "${key}". ` +
        `Verify the key exists in CONFIG_KEYS before classifying it.`,
    );
  }

  switch (def.tier) {
    case "bootstrap":
      return "bootstrap-out-of-band";
    case "secret":
      return "secret";
    case "tunable":
      return (ENV_SPECIFIC_TUNABLE_KEYS as readonly string[]).includes(key)
        ? "env-specific-tunable"
        : "portable-tunable";
  }
}

// ── Convenience list helpers ──────────────────────────────────────────────────

/** All secret-tier keys from the registry. */
export function listSecretKeys(): string[] {
  return listKeysByTier("secret");
}

/** All bootstrap-tier keys from the registry. */
export function listBootstrapKeys(): string[] {
  return listKeysByTier("bootstrap");
}

/**
 * ENV_SPECIFIC_TUNABLE_KEYS entries that exist in CONFIG_KEYS with tier
 * "tunable". In practice this is the full allowlist (enforced by the
 * module-load self-check above), but this function is safe to call
 * before the check completes if needed.
 */
export function listEnvSpecificTunables(): string[] {
  return ENV_SPECIFIC_TUNABLE_KEYS.filter((key) => {
    const def = CONFIG_KEYS[key];
    return def !== undefined && def.tier === "tunable";
  });
}
