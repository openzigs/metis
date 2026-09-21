/**
 * Vault-ref expansion for environment variable maps.
 *
 * MCP/agent processes spawned by the platform (Phase 6) need credentials that
 * are stored in the vault. To keep configuration files declarative and
 * secret-free, callers can write `${vault:secret-id}` (or
 * `${vault:secret-label}`) anywhere in an env value; this module resolves
 * those references just-in-time before handing the env map to the child
 * process.
 *
 * Lifted from `talos/src/platform/env-manager.ts` and adapted to use the
 * METIS vault service.
 */
import { createChildLogger } from "../logger.js";
import type { VaultService } from "./vault-service.js";

const log = createChildLogger("vault-env");

const VAULT_REF_PATTERN = /\$\{vault:([^}]+)\}/g;

/**
 * Expand `${vault:...}` references in every value of `env`. Lookup order:
 * 1. Exact id match (cuids/ulids)
 * 2. `<scope>:<label>` match (e.g. `project:gh-token`)
 * 3. `global:<label>` and `project:<label>` fallback
 *
 * Throws if a reference cannot be resolved — fail-closed semantics so a
 * missing secret never silently runs a process with an empty value.
 */
export async function expandVaultRefs(
  env: Record<string, string>,
  vault: VaultService,
): Promise<Record<string, string>> {
  const expanded: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    expanded[key] = await expandValue(key, raw, vault);
  }
  return expanded;
}

async function expandValue(envKey: string, value: string, vault: VaultService): Promise<string> {
  if (!value.includes("${vault:")) return value;

  const matches = [...value.matchAll(VAULT_REF_PATTERN)];
  let result = value;
  for (const match of matches) {
    const ref = match[1].trim();
    const plaintext = await resolveRef(ref, vault);
    if (plaintext == null) {
      throw new Error(`Vault reference \${vault:${ref}} (env ${envKey}) could not be resolved`);
    }
    result = result.replace(match[0], plaintext);
  }
  return result;
}

async function resolveRef(ref: string, vault: VaultService): Promise<string | null> {
  // 1. id lookup
  try {
    const { plaintext } = await vault.read(ref);
    return plaintext;
  } catch {
    /* fall through */
  }

  // 2. label lookup across scopes
  const all = await vault.list();
  const direct = all.find((s) => s.label === ref || `${s.scope}:${s.label}` === ref);
  if (direct) {
    const { plaintext } = await vault.read(direct.id);
    return plaintext;
  }

  log.warn("Vault reference not resolved", { ref });
  return null;
}
