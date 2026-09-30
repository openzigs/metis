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
 * missing secret never silently runs a process with an empty value — and
 * (#358) if a label matches more than one live secret.
 *
 * #480 — `secretBindings` (ref body → secret id, stored when the owning
 * resource was saved) replaces the lookup above: each reference is read by its
 * bound id only, and one that is unbound, or whose bound secret is no longer
 * live, throws instead of re-resolving the label. Omitted or `null` only for a
 * resource saved before #480.
 *
 * `kind` names what the map is in error messages — an MCP server's header
 * values are expanded through here too (#504).
 */
export type VaultRefMapKind = "env" | "header";

export async function expandVaultRefs(
  env: Record<string, string>,
  vault: VaultService,
  secretBindings?: Record<string, string> | null,
  kind: VaultRefMapKind = "env",
): Promise<Record<string, string>> {
  const expanded: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    expanded[key] = await expandValue(`${kind} ${key}`, raw, vault, secretBindings ?? null);
  }
  return expanded;
}

async function expandValue(
  /** `env KEY` or `header Name`, for messages. */
  where: string,
  value: string,
  vault: VaultService,
  secretBindings: Record<string, string> | null,
): Promise<string> {
  if (!value.includes("${vault:")) return value;
  // #504 — a header goes to a remote URL: never resolve one by label.
  if (secretBindings === null && where.startsWith("header ")) {
    throw new Error(
      `${where} references the vault but this server has no secret bindings yet; save the server again`,
    );
  }

  const matches = [...value.matchAll(VAULT_REF_PATTERN)];
  let result = value;
  for (const match of matches) {
    const ref = match[1].trim();
    const plaintext = secretBindings
      ? await readBound(where, ref, secretBindings, vault)
      : await resolveRef(ref, vault);
    if (plaintext == null) {
      throw new Error(`Vault reference \${vault:${ref}} (${where}) could not be resolved`);
    }
    result = result.replace(match[0], plaintext);
  }
  return result;
}

/** #480 — a bound reference, by its stored id only; never by label. */
async function readBound(
  where: string,
  ref: string,
  secretBindings: Record<string, string>,
  vault: VaultService,
): Promise<string> {
  const secretId = Object.hasOwn(secretBindings, ref) ? secretBindings[ref] : undefined;
  if (!secretId) {
    throw new Error(
      `Vault reference \${vault:${ref}} (${where}) is not bound to a secret; save the server again`,
    );
  }
  try {
    const { plaintext } = await vault.read(secretId);
    return plaintext;
  } catch {
    log.warn("Bound vault secret not live", { ref, secretId });
    throw new Error(
      `Vault reference \${vault:${ref}} (${where}): the secret it was bound to has been deleted; select a secret again`,
    );
  }
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
  const matches = all.filter((s) => s.label === ref || `${s.scope}:${s.label}` === ref);
  // #358 — fail closed on a label that reaches more than one live secret
  // rather than taking the newest (`vault.list()` order): a colliding secret
  // created after the reference was bound must never be the one resolved.
  if (matches.length > 1) {
    throw new Error(
      `Vault reference \${vault:${ref}} is ambiguous: it matches more than one secret; ` +
        "qualify it as global:<label> or project:<label>, or use the secret id",
    );
  }
  if (matches.length === 1) {
    const { plaintext } = await vault.read(matches[0].id);
    return plaintext;
  }

  log.warn("Vault reference not resolved", { ref });
  return null;
}
