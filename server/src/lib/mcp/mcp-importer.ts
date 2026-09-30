/**
 * mcp.json importer (issue #51).
 *
 * Parses VS Code / Claude Desktop `mcp.json` blobs and registers each entry
 * as an MCPServer. Any env value whose KEY matches the secret pattern OR
 * whose VALUE matches a known secret-shape (Bearer prefix, JWT, GitHub PAT,
 * Slack token, AWS access key, etc.) is auto-routed into the vault: a Secret
 * row is created with the plaintext, then the env entry is rewritten to
 * `${vault:<label>}` so the plaintext NEVER lands in the MCPServer row.
 *
 * The same scan is applied to `headers` values (SEC-3) — `Authorization`,
 * `X-API-Key`, etc. used to be copied as-is, which leaked bearer tokens
 * through the registry view.
 *
 * Supports a dry-run mode that returns the planned changes without touching
 * either the vault or the MCP table.
 */
import { type MCPJsonImport, mcpJsonImportSchema } from "@metis/shared";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { getVaultService } from "../vault/vault-service.js";
import { freshSecretLabel } from "../vault/secret-rotation.js";
import type { SecretBindings } from "../vault/bound-secret.js";
import type { MCPRegistryService } from "./mcp-service.js";
import type { McpImportBindingCheck } from "./secret-binding.js";

const log = createChildLogger("mcp-importer");

/**
 * Env keys that conventionally carry secrets. Extended for SEC-9 to include
 * BEARER, CREDENTIALS/CRED, APIKEY (no underscore), AUTH, JWT, SESSION.
 */
export const SECRET_KEY_PATTERN =
  /(_TOKEN|_KEY|_PASSWORD|_PASSWD|_SECRET|_PAT|_BEARER|_CREDENTIALS?|_AUTH|_JWT|_SESSION|APIKEY|BEARER|CREDENTIALS?|JWT|PASSWORD)$/i;

/** Header names that always hold credentials regardless of value shape. */
const SECRET_HEADER_PATTERN =
  /^(authorization|proxy-authorization|x-api-key|x-auth-token|api-key|apikey|bearer|cookie|set-cookie|private-token|x-access-token)$/i;

/**
 * Value-shape heuristics for secrets that don't have an obvious key. Catches
 * `Authorization: Bearer …`, raw JWTs, GitHub PATs, Slack tokens, AWS keys.
 * Conservative — we'd rather over-vault than leak.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^Bearer\s+[A-Za-z0-9._\-+/=]{8,}$/, // Authorization: Bearer xxx
  /^Basic\s+[A-Za-z0-9+/=]{8,}$/, // Authorization: Basic <base64>
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/, // JWT
  /^gh[psoru]_[A-Za-z0-9]{20,}$/, // GitHub token
  /^github_pat_[A-Za-z0-9_]{22,}$/, // GitHub fine-grained PAT
  /^xox[abposr]-[A-Za-z0-9-]{10,}$/, // Slack token
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^ASIA[0-9A-Z]{16}$/, // AWS STS access key id
  /^sk-[A-Za-z0-9]{20,}$/, // OpenAI / Anthropic-style API key
  /^[A-Fa-f0-9]{40,}$/, // long hex token (SHA-1+ length)
];

export function isSecretValue(value: string): boolean {
  if (typeof value !== "string" || value.length < 8) return false;
  if (value.startsWith("${vault:")) return false;
  return SECRET_VALUE_PATTERNS.some((rx) => rx.test(value));
}

export function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER_PATTERN.test(name);
}

export interface ImportPlanEntry {
  label: string;
  transport: "stdio" | "http" | "sse";
  command: string | null;
  args: string[] | null;
  url: string | null;
  /** Headers to persist (vault refs already substituted). */
  headers: Record<string, string> | null;
  /** Final env to persist (vault refs already substituted). */
  env: Record<string, string>;
  /** Map envKey -> secret label that will be (or was) created. */
  vaultedKeys: Record<string, string>;
  /** Map headerName -> secret label that will be (or was) created. */
  vaultedHeaders: Record<string, string>;
}

export interface ImportPlan {
  entries: ImportPlanEntry[];
  totalSecrets: number;
}

export interface ImportResult {
  plan: ImportPlan;
  created: Array<{ id: string; label: string }>;
  /** `code` is the failure's error code when it has one (e.g. `VAULT_REF_UNRESOLVED`). */
  errors: Array<{ label: string; message: string; code?: string }>;
  dryRun: boolean;
}

interface ImportOptions {
  scope?: "global" | "project";
  projectId?: string | null;
  dryRun?: boolean;
  trustLevel?: "trusted" | "untrusted";
  /** When non-null, prepended to the synthesised secret label so multiple imports don't collide. */
  labelPrefix?: string;
  /**
   * #577 — the caller's binding check (`assertMcpImportSecretBinding`): each
   * entry's approved secret ids, keyed by entry label, and the entries it could
   * not bind. An entry is bound to exactly its ids plus the secrets it vaults;
   * a reference outside them fails the entry (`SECRET_BINDING_UNCHECKED`), it is
   * never resolved again. Without a check, only auto-vaulted refs can bind.
   */
  secretBindings?: McpImportBindingCheck;
}

export async function buildImportPlan(raw: unknown, opts: ImportOptions = {}): Promise<ImportPlan> {
  const parsed = mcpJsonImportSchema.parse(raw);
  const servers: Record<string, unknown> = {
    ...(parsed.mcpServers ?? {}),
    ...(parsed.servers ?? {}),
  };
  const entries: ImportPlanEntry[] = [];
  let totalSecrets = 0;
  for (const [label, rawEntry] of Object.entries(servers)) {
    const entry = rawEntry as MCPJsonImport["mcpServers"] extends infer R
      ? R extends Record<string, infer V>
        ? V
        : never
      : never;
    const transport = (entry?.type ?? (entry?.url ? "http" : "stdio")) as "stdio" | "http" | "sse";
    const planned: ImportPlanEntry = {
      label: opts.labelPrefix ? `${opts.labelPrefix}-${label}` : label,
      transport,
      command: entry?.command ?? null,
      args: entry?.args ? entry.args.slice() : null,
      url: entry?.url ?? null,
      headers: null,
      env: {},
      vaultedKeys: {},
      vaultedHeaders: {},
    };
    for (const [k, v] of Object.entries(entry?.env ?? {})) {
      if (typeof v !== "string") continue;
      if ((SECRET_KEY_PATTERN.test(k) || isSecretValue(v)) && !v.startsWith("${vault:")) {
        const labelKey = `mcp-${planned.label}-${k.toLowerCase()}`;
        planned.env[k] = `\${vault:${labelKey}}`;
        planned.vaultedKeys[k] = labelKey;
        totalSecrets += 1;
      } else {
        planned.env[k] = v;
      }
    }
    if (entry?.headers) {
      const out: Record<string, string> = {};
      for (const [hName, hVal] of Object.entries(entry.headers)) {
        if (typeof hVal !== "string") continue;
        if ((isSecretHeaderName(hName) || isSecretValue(hVal)) && !hVal.startsWith("${vault:")) {
          const labelKey = `mcp-${planned.label}-header-${hName.toLowerCase()}`;
          out[hName] = `\${vault:${labelKey}}`;
          planned.vaultedHeaders[hName] = labelKey;
          totalSecrets += 1;
        } else {
          out[hName] = hVal;
        }
      }
      planned.headers = out;
    }
    entries.push(planned);
  }
  return { entries, totalSecrets };
}

export async function executeImport(
  raw: unknown,
  registry: MCPRegistryService,
  actor: { id: string; role?: import("@metis/shared").RoleKey },
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const plan = await buildImportPlan(raw, opts);
  const result: ImportResult = {
    plan,
    created: [],
    errors: [],
    dryRun: Boolean(opts.dryRun),
  };
  if (opts.dryRun) return result;

  const vault = getVaultService();
  const vaultScope = opts.scope === "project" ? "project" : "global";
  for (const entry of plan.entries) {
    // #258 — every secret this import writes gets a label no earlier secret
    // holds, and the entry's refs are pointed at it. The planned label is fixed
    // by server label + key, so a re-import (or the same server label in another
    // project) hit `Secret.name @unique`; that failure was caught and logged as
    // success, and the server kept resolving the OLD secret. A vault failure
    // now fails the entry, and the secrets it already wrote are withdrawn.
    const written: string[] = [];
    // #577 review — an entry the check could not bind (unresolved or
    // ambiguous reference) fails alone, before it vaults anything.
    const failure = opts.secretBindings?.failures.get(entry.label);
    if (failure) {
      result.errors.push({ label: entry.label, message: failure.message, code: failure.code });
      continue;
    }
    /** #577 — the checked ids, plus each secret this entry vaults. */
    const bound: SecretBindings = Object.assign(
      Object.create(null) as SecretBindings,
      opts.secretBindings?.bindings.get(entry.label),
    );
    try {
      // 1. Create vault secrets for any auto-routed env keys.
      for (const [envKey, planned] of Object.entries(entry.vaultedKeys)) {
        // The plaintext we want to store is in the ORIGINAL env value;
        // because we've already rewritten entry.env above we recover it from
        // the raw input. Plaintext is never persisted on the plan object.
        const plaintext = getOriginalSecret(raw, entry.label, "env", envKey, opts.labelPrefix);
        if (plaintext == null) continue;
        const secretLabel = freshSecretLabel(planned);
        const summary = await vault.create(secretLabel, plaintext, vaultScope, {
          description: `Auto-vaulted from mcp.json import for ${entry.label}`,
          // #344 — the importer supplied this plaintext, so the secret is theirs.
          createdById: actor.id,
        });
        written.push(summary.id);
        bound[secretLabel] = summary.id;
        entry.vaultedKeys[envKey] = secretLabel;
        entry.env[envKey] = `\${vault:${secretLabel}}`;
        audit({
          actor: { id: actor.id },
          action: "vault.write",
          target: { type: "secret", id: summary.id },
          metadata: { label: secretLabel, source: "mcp_import", field: "env", envKey },
        });
      }
      // 1b. Same for headers.
      for (const [hName, planned] of Object.entries(entry.vaultedHeaders)) {
        const plaintext = getOriginalSecret(raw, entry.label, "headers", hName, opts.labelPrefix);
        if (plaintext == null) continue;
        const secretLabel = freshSecretLabel(planned);
        const summary = await vault.create(secretLabel, plaintext, vaultScope, {
          description: `Auto-vaulted header from mcp.json import for ${entry.label}`,
          // #344 — the importer supplied this plaintext, so the secret is theirs.
          createdById: actor.id,
        });
        written.push(summary.id);
        bound[secretLabel] = summary.id;
        entry.vaultedHeaders[hName] = secretLabel;
        if (entry.headers) entry.headers[hName] = `\${vault:${secretLabel}}`;
        audit({
          actor: { id: actor.id },
          action: "vault.write",
          target: { type: "secret", id: summary.id },
          metadata: { label: secretLabel, source: "mcp_import", field: "header", header: hName },
        });
      }
      // 2. Persist the MCPServer row with vault refs in env.
      const created = await registry.create(
        {
          scope: opts.scope ?? "global",
          projectId: opts.projectId ?? undefined,
          label: entry.label,
          transport: entry.transport,
          runtime: "native",
          command: entry.command ?? undefined,
          args: entry.args ?? undefined,
          url: entry.url ?? undefined,
          headers: entry.headers ?? undefined,
          env: entry.env,
          envSecretRefs: entry.vaultedKeys,
          trustLevel: opts.trustLevel ?? "untrusted",
          defaultToolRisk: "medium",
          healthCheckIntervalSec: 60,
          enabled: true,
        },
        actor,
        { secretBindings: bound },
      );
      result.created.push({ id: created.id, label: created.label });
    } catch (err) {
      for (const id of written) {
        await vault.delete(id).catch((cleanupErr: unknown) =>
          log.warn("Vault cleanup after failed MCP import entry failed", {
            id,
            error: (cleanupErr as Error).message,
          }),
        );
      }
      const code = (err as { code?: unknown }).code;
      result.errors.push({
        label: entry.label,
        message: (err as Error).message,
        ...(typeof code === "string" ? { code } : {}),
      });
    }
  }
  audit({
    actor: { id: actor.id },
    action: "mcp.import",
    target: { type: "mcp_server", id: "n/a" },
    metadata: {
      created: result.created.length,
      errors: result.errors.length,
      secrets: plan.totalSecrets,
      dryRun: false,
    },
  });
  return result;
}

function getOriginalSecret(
  raw: unknown,
  entryLabel: string,
  field: "env" | "headers",
  fieldKey: string,
  labelPrefix?: string,
): string | null {
  if (!raw || typeof raw !== "object") return null;
  const serversRoot = raw as Record<string, unknown>;
  const groups = ["mcpServers", "servers"] as const;
  // Recover the original key by stripping the prefix we may have prepended.
  const originalLabel = labelPrefix
    ? entryLabel.startsWith(`${labelPrefix}-`)
      ? entryLabel.slice(labelPrefix.length + 1)
      : entryLabel
    : entryLabel;
  for (const key of groups) {
    const group = serversRoot[key];
    if (!group || typeof group !== "object") continue;
    const entry = (group as Record<string, unknown>)[originalLabel];
    if (entry && typeof entry === "object") {
      const bag = (entry as Record<string, unknown>)[field];
      if (bag && typeof bag === "object") {
        const v = (bag as Record<string, unknown>)[fieldKey];
        if (typeof v === "string") return v;
      }
    }
  }
  return null;
}
