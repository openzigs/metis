/**
 * `ConfigService` — single seam for reading runtime configuration.
 *
 * Read precedence (#250 / Phase 1):
 *   - bootstrap tier → `process.env[key]` ONLY (vault and DB never consulted)
 *   - secret    tier → vault preload cache → `process.env[key]`
 *   - tunable   tier → `process.env[key]` (DB precedence lands in Phase 2 #255)
 *
 * The `get(key)` accessor is synchronous so call sites can use it without
 * pushing async all the way up. Vault values are decrypted ahead of time by
 * `loadSecrets()` and parked in an in-memory `secretCache`. Callers who want
 * vault values immediately can `await refreshSecret(key)` first.
 *
 * Logger meta is restricted to the **key name only** — never the value. Any
 * accidental value leak would still hit the logger redactor, but the contract
 * is "ConfigService never logs config values".
 */
import { EventEmitter } from "node:events";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { getVaultService, type SecretSummary, type VaultService } from "../vault/vault-service.js";
import { ConfigBootstrapError, ConfigUnknownKeyError, ConfigValidationError } from "./errors.js";
import { CONFIG_KEYS, type ConfigKeyDef, getKeyDef, listKeysByTier } from "./key-registry.js";
import { ConfigCache } from "./cache.js";

const log = createChildLogger("config-service");

/** Vault entries are stored under `global:<KEY>` per the existing convention. */
const VAULT_SCOPE = "global" as const;

/** Maximum bytes of an audited tunable value before truncation (1 KB per epic spec). */
const AUDIT_VALUE_MAX_BYTES = 1024;

/** Truncate a tunable value to the audit byte cap, marking truncation visibly. */
function truncateForAudit(value: string): string {
  if (value.length <= AUDIT_VALUE_MAX_BYTES) return value;
  return `${value.slice(0, AUDIT_VALUE_MAX_BYTES)}…[truncated]`;
}

/**
 * Compute the value to persist in the audit row for a given key.
 * Sensitive keys are always `[REDACTED]`. Null / undefined → `[unset]`.
 */
function redactValueForAudit(def: ConfigKeyDef, value: string | null | undefined): string {
  if (def.sensitive) return "[REDACTED]";
  if (value === null || value === undefined) return "[unset]";
  return truncateForAudit(value);
}

export interface ConfigServiceOptions {
  /** Optional vault override — tests inject a stub. Production uses the singleton. */
  vault?: VaultService;
  /** Optional env override — tests pass a curated record. */
  env?: NodeJS.ProcessEnv;
}

export interface ConfigSourceInfo {
  /** Effective source of the value: vault (secret), db (tunable), or env. */
  source: "vault" | "db" | "env" | "unset";
  /** True when the key exists in the vault (regardless of which value won). */
  hasVaultEntry: boolean;
  /** True when a `runtime_config` row exists for this key. */
  hasDbEntry: boolean;
  /** True when `process.env[key]` is non-empty. */
  hasEnvEntry: boolean;
}

/**
 * Payload emitted on `config.changed`. For Tier-2 (secret) writes the values
 * are forced to `[REDACTED]` so subscribers can never log a plaintext.
 */
export interface ConfigChangedEvent {
  key: string;
  oldValue: string | null;
  newValue: string | null;
  scope: string;
  tier: ConfigKeyDef["tier"];
}

export class ConfigService extends EventEmitter {
  private readonly vault: VaultService;
  private readonly env: NodeJS.ProcessEnv;
  /** key → vault summary, populated on `loadSecrets()`. */
  private readonly secretSummaries = new Map<string, SecretSummary>();
  /** key → decrypted plaintext, populated on `loadSecrets()` / `refreshSecret`. */
  private readonly secretCache = new Map<string, string>();
  /** Tier-3 tunable cache, populated on `loadTunables()` and on every `set`. */
  private readonly tunableCache = new ConfigCache();
  /** Tracks which tunable keys have a real `runtime_config` row backing the cache. */
  private readonly tunableDbBacked = new Set<string>();
  private secretsLoaded = false;
  private secretsLoadPromise: Promise<void> | null = null;
  private tunablesLoaded = false;
  private tunablesLoadPromise: Promise<void> | null = null;
  /**
   * #112 — per-key tail of the in-flight write chain. A store write and the
   * cache update that follows it are one unit: without this, two concurrent
   * saves can commit A-then-B but land in the cache B-then-A, leaving the cache
   * serving a value the store no longer holds until the next reload. Scope is
   * this process — the only place this cache lives.
   */
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(opts: ConfigServiceOptions = {}) {
    super();
    this.vault = opts.vault ?? getVaultService();
    this.env = opts.env ?? process.env;
    // EventEmitter default of 10 listeners is too tight once Phase 3
    // wires every subscriber (scheduler, publisher, allowlist, MCP, ...).
    this.setMaxListeners(50);
  }

  // ── Read path ───────────────────────────────────────────────────────────

  /**
   * Synchronous read. Returns `undefined` when the key is registered but
   * unset. **Throws `ConfigUnknownKeyError` when the key isn't registered**
   * — callers should never read keys the registry doesn't know about.
   */
  get(key: string): string | undefined {
    const def = getKeyDef(key);
    if (!def) throw new ConfigUnknownKeyError(key);

    if (def.tier === "secret") {
      const cached = this.secretCache.get(key);
      if (cached !== undefined) return cached;
    } else if (def.tier === "tunable") {
      // Tunable read order (#255):
      //   1. tunable cache (populated from runtime_config on `loadTunables()`
      //      and on every successful `set`)
      //   2. process.env fallback
      const cached = this.tunableCache.getValue(key);
      if (cached !== undefined) return cached;
    }
    // Bootstrap (and tunable cache miss) fall back to env.
    const envValue = this.env[key];
    return envValue === undefined || envValue === "" ? undefined : envValue;
  }

  /** Same as `get` but throws when missing. Useful for required values. */
  getRequired(key: string): string {
    const v = this.get(key);
    if (v === undefined) {
      throw new Error(`Required config key ${key} is not set`);
    }
    return v;
  }

  /**
   * Coerce-to-int helper. Returns `defaultValue` when unset or unparseable.
   * Throws when the key isn't registered (same as `get`).
   */
  getNumber(key: string, defaultValue?: number): number {
    const raw = this.get(key);
    if (raw === undefined) {
      if (defaultValue === undefined) {
        throw new Error(`Required numeric config key ${key} is not set`);
      }
      return defaultValue;
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Config key ${key} is not a valid integer: ${raw}`);
    }
    return n;
  }

  /**
   * Coerce-to-bool helper. Truthy values: `1`, `true`, `yes`, `on` (case-insensitive).
   * Anything else is falsy. Returns `defaultValue` when unset.
   */
  getBool(key: string, defaultValue = false): boolean {
    const raw = this.get(key);
    if (raw === undefined) return defaultValue;
    return /^(1|true|yes|on)$/i.test(raw.trim());
  }

  /** Returns whether a key is registered. */
  isKnownKey(key: string): boolean {
    return getKeyDef(key) !== undefined;
  }

  /** Returns the registry entry for the given key (`undefined` if unknown). */
  getKeyDef(key: string): ConfigKeyDef | undefined {
    return getKeyDef(key);
  }

  /** Returns the source description for a key — useful for the admin UI. */
  describeSource(key: string): ConfigSourceInfo {
    const def = getKeyDef(key);
    if (!def) throw new ConfigUnknownKeyError(key);
    const hasEnv = this.env[key] !== undefined && this.env[key] !== "";
    const hasVault = def.tier === "secret" && this.secretSummaries.has(key);
    const hasDb = def.tier === "tunable" && this.tunableDbBacked.has(key);
    let source: ConfigSourceInfo["source"];
    if (def.tier === "secret" && hasVault) source = "vault";
    else if (def.tier === "tunable" && hasDb) source = "db";
    else if (hasEnv) source = "env";
    else source = "unset";
    return { source, hasVaultEntry: hasVault, hasDbEntry: hasDb, hasEnvEntry: hasEnv };
  }

  // ── Vault preload ───────────────────────────────────────────────────────

  /**
   * Eagerly load every Tier-2 secret from the vault into the in-memory cache.
   * Idempotent — concurrent callers share a single in-flight promise.
   */
  async loadSecrets(): Promise<void> {
    if (this.secretsLoaded) return;
    if (this.secretsLoadPromise) return this.secretsLoadPromise;
    this.secretsLoadPromise = this.doLoadSecrets()
      .then(() => {
        this.secretsLoaded = true;
      })
      .finally(() => {
        this.secretsLoadPromise = null;
      });
    return this.secretsLoadPromise;
  }

  private async doLoadSecrets(): Promise<void> {
    const summaries = await this.vault.list(VAULT_SCOPE);
    const secretKeys = new Set(listKeysByTier("secret"));
    for (const summary of summaries) {
      if (!secretKeys.has(summary.label)) continue; // ignore vault entries we don't own
      this.secretSummaries.set(summary.label, summary);
      try {
        const { plaintext } = await this.vault.read(summary.id);
        this.secretCache.set(summary.label, plaintext);
      } catch (err) {
        // Failing to decrypt one secret must not break the rest of the boot.
        log.error("Failed to preload secret from vault", {
          key: summary.label,
          err: (err as Error).message,
        });
      }
    }
    log.info("Vault secrets preloaded", {
      loaded: this.secretCache.size,
      registered: secretKeys.size,
    });
  }

  /**
   * Refresh a single secret from the vault without rebuilding the whole cache.
   * Useful immediately after a write so subsequent `get()` calls see the new value.
   */
  async refreshSecret(key: string): Promise<void> {
    const def = getKeyDef(key);
    if (!def) throw new ConfigUnknownKeyError(key);
    if (def.tier !== "secret") return;
    const summaries = await this.vault.list(VAULT_SCOPE);
    const match = summaries.find((s) => s.label === key);
    if (!match) {
      this.secretSummaries.delete(key);
      this.secretCache.delete(key);
      return;
    }
    this.secretSummaries.set(key, match);
    const { plaintext } = await this.vault.read(match.id);
    this.secretCache.set(key, plaintext);
  }

  // ── Write path (secrets only in Phase 1) ────────────────────────────────

  /**
   * #112 — run `write` after every earlier write of `key` has settled, so
   * store-commit order and cache-update order are the same order. A failed
   * write releases the chain; it does not block the next one.
   */
  private serializeWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(key) ?? Promise.resolve();
    const run = prev.then(write);
    const tail = run.catch(() => undefined);
    this.writeChains.set(key, tail);
    void tail.then(() => {
      if (this.writeChains.get(key) === tail) this.writeChains.delete(key);
    });
    return run;
  }

  /**
   * Persist a Tier-2 secret. Creates a new vault entry if absent, otherwise
   * rotates the existing one (reviving a cleared one) in a single upsert on
   * the vault's unique name (#93). Returns the resulting `SecretSummary`.
   *
   * Bootstrap-tier writes throw `ConfigBootstrapError`; tunable-tier writes
   * land in Phase 2 (#255) — for now they throw the same error so the route
   * layer fails fast.
   *
   * The audit hook (#253) wraps this method via `setSecretWithAudit`.
   */
  async setSecret(
    key: string,
    plaintext: string,
    opts: { actorId?: string | null } = {},
  ): Promise<SecretSummary> {
    const def = getKeyDef(key);
    if (!def) throw new ConfigUnknownKeyError(key);
    if (def.tier === "bootstrap") throw new ConfigBootstrapError(key);
    if (def.tier !== "secret") {
      throw new Error(`setSecret only supports secret-tier keys (key=${key} tier=${def.tier})`);
    }
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw new Error(`setSecret requires a non-empty string value for ${key}`);
    }

    // #93 — one idempotent write keyed on the unique name. Choosing between
    // create and rotate from `vault.list()` missed soft-deleted rows (and any
    // concurrent writer), so re-setting a cleared secret 500'd on the index.
    const summary = await this.serializeWrite(key, async () => {
      const written = await this.vault.upsert(key, plaintext, VAULT_SCOPE, {
        description: def.description,
        createdById: opts.actorId ?? null,
      });
      this.secretSummaries.set(key, written);
      this.secretCache.set(key, plaintext);
      return written;
    });
    log.info("Secret updated via ConfigService", { key });
    this.emitChange({
      key,
      oldValue: "[REDACTED]",
      newValue: "[REDACTED]",
      scope: VAULT_SCOPE,
      tier: "secret",
    });
    return summary;
  }

  /**
   * Soft-delete a Tier-2 secret. After this returns, `get(key)` falls back
   * to `process.env[key]` (or `undefined` if env is also unset).
   */
  async clearSecret(key: string): Promise<void> {
    const def = getKeyDef(key);
    if (!def) throw new ConfigUnknownKeyError(key);
    if (def.tier === "bootstrap") throw new ConfigBootstrapError(key);
    if (def.tier !== "secret") {
      throw new Error(`clearSecret only supports secret-tier keys (key=${key} tier=${def.tier})`);
    }
    await this.serializeWrite(key, async () => {
      const summaries = await this.vault.list(VAULT_SCOPE);
      const existing = summaries.find((s) => s.label === key);
      if (existing) {
        await this.vault.delete(existing.id);
      }
      this.secretSummaries.delete(key);
      this.secretCache.delete(key);
    });
    log.info("Secret cleared via ConfigService", { key });
    this.emitChange({
      key,
      oldValue: "[REDACTED]",
      newValue: null,
      scope: VAULT_SCOPE,
      tier: "secret",
    });
  }

  // ── Tunable load + write path (#255) ────────────────────────────────────

  /**
   * Eagerly load every Tier-3 tunable from `runtime_config` into the cache.
   * Idempotent — concurrent callers share a single in-flight promise.
   * Server bootstrap (`createServer()`) calls this alongside `loadSecrets()`
   * so the first request never hits a cold cache.
   */
  async loadTunables(): Promise<void> {
    if (this.tunablesLoaded) return;
    if (this.tunablesLoadPromise) return this.tunablesLoadPromise;
    this.tunablesLoadPromise = this.doLoadTunables()
      .then(() => {
        this.tunablesLoaded = true;
      })
      .finally(() => {
        this.tunablesLoadPromise = null;
      });
    return this.tunablesLoadPromise;
  }

  private async doLoadTunables(): Promise<void> {
    const rows = await prisma.runtimeConfig.findMany();
    const tunableKeys = new Set(listKeysByTier("tunable"));
    for (const row of rows) {
      if (!tunableKeys.has(row.key)) continue;
      this.tunableCache.set(row.key, row.value);
      this.tunableDbBacked.add(row.key);
    }
    log.info("Runtime tunables preloaded", {
      loaded: this.tunableCache.size(),
      registered: tunableKeys.size,
    });
  }

  /**
   * Persist a Tier-3 tunable. Validates against the registered Zod schema,
   * upserts the `runtime_config` row, refreshes the cache, and emits
   * `config.changed` so subscribers can rebuild their state.
   *
   * Bootstrap and secret writes go through `setSecret` / are rejected here.
   */
  async set(
    key: string,
    rawValue: unknown,
    opts: { actorId: string; scope?: string },
  ): Promise<{ value: string }> {
    const def = getKeyDef(key);
    if (!def) throw new ConfigUnknownKeyError(key);
    if (def.tier === "bootstrap") throw new ConfigBootstrapError(key);
    if (def.tier === "secret") {
      throw new Error(`Use setSecret() for secret-tier keys (key=${key})`);
    }

    // Validate via the per-key Zod schema (#256). The schema returns the
    // canonical typed value; we serialize that back to a string for storage
    // so the read path can `valueType`-coerce uniformly.
    const parsed = def.schema.safeParse(rawValue);
    if (!parsed.success) {
      throw new ConfigValidationError(key, parsed.error.flatten());
    }
    const stored = serializeForStorage(def.valueType, parsed.data);

    const scope = opts.scope ?? "global";

    const oldValue = await this.serializeWrite(key, async () => {
      const previous = this.tunableCache.getValue(key) ?? null;
      await prisma.runtimeConfig.upsert({
        where: { key },
        create: {
          key,
          value: stored,
          valueType: def.valueType,
          scope,
          updatedById: opts.actorId,
        },
        update: {
          value: stored,
          valueType: def.valueType,
          scope,
          updatedById: opts.actorId,
        },
      });
      this.tunableCache.set(key, stored);
      this.tunableDbBacked.add(key);
      return previous;
    });

    log.info("Tunable updated via ConfigService", { key });
    this.emitChange({
      key,
      oldValue: oldValue,
      newValue: stored,
      scope,
      tier: "tunable",
    });

    return { value: stored };
  }

  /**
   * Clear a Tier-3 tunable's database override. After this resolves the
   * effective value falls through to `process.env[key]` (or `undefined`).
   */
  async clearTunable(key: string, opts: { actorId: string; scope?: string }): Promise<void> {
    const def = getKeyDef(key);
    if (!def) throw new ConfigUnknownKeyError(key);
    if (def.tier !== "tunable") {
      throw new Error(`clearTunable only supports tunable-tier keys (key=${key})`);
    }
    const oldValue = await this.serializeWrite(key, async () => {
      const previous = this.tunableCache.getValue(key) ?? null;
      await prisma.runtimeConfig.deleteMany({ where: { key } });
      this.tunableCache.invalidate(key);
      this.tunableDbBacked.delete(key);
      return previous;
    });
    const scope = opts.scope ?? "global";
    log.info("Tunable cleared via ConfigService", { key });
    this.emitChange({ key, oldValue, newValue: null, scope, tier: "tunable" });
  }

  /**
   * Emit `config.changed`. Sensitive values are redacted in the payload so
   * subscribers can never log a plaintext.
   */
  private emitChange(evt: ConfigChangedEvent): void {
    const def = getKeyDef(evt.key);
    const payload: ConfigChangedEvent = def?.sensitive
      ? { ...evt, oldValue: "[REDACTED]", newValue: "[REDACTED]" }
      : evt;
    this.emit("config.changed", payload);
  }

  // ── Audit log (#253) ────────────────────────────────────────────────────

  /**
   * Insert a `config_audit` row for a config write.
   *
   * Sensitive (Tier 2 secret) keys NEVER store the raw value — both
   * `oldValueRedacted` and `newValueRedacted` are forced to `[REDACTED]`.
   * Non-sensitive (Tier 3 tunable) keys store the actual value, truncated
   * to {@link AUDIT_VALUE_MAX_BYTES} bytes so a pathological JSON or CSV
   * payload cannot blow up the audit table.
   *
   * Bootstrap-tier writes throw upstream and never reach this method.
   */
  async recordAudit(args: {
    key: string;
    oldValue: string | null | undefined;
    newValue: string | null | undefined;
    actorId: string;
    scope?: string;
  }): Promise<void> {
    const def = getKeyDef(args.key);
    if (!def) throw new ConfigUnknownKeyError(args.key);
    if (def.tier === "bootstrap") {
      // Defensive — should already be rejected by the route layer.
      throw new ConfigBootstrapError(args.key);
    }
    const oldValueRedacted = redactValueForAudit(def, args.oldValue);
    const newValueRedacted = redactValueForAudit(def, args.newValue);
    await prisma.configAudit.create({
      data: {
        key: args.key,
        oldValueRedacted,
        newValueRedacted,
        actorId: args.actorId,
        scope: args.scope ?? "global",
      },
    });
    log.info("Config audit recorded", {
      key: args.key,
      actorId: args.actorId,
      scope: args.scope ?? "global",
    });
  }

  /**
   * Paginated read of `config_audit`. Returns rows ordered by `ts` desc.
   * `cursor` is an opaque audit-row id from the previous page.
   */
  async listAudit(opts: { limit?: number; cursor?: string } = {}): Promise<{
    items: Array<{
      id: string;
      key: string;
      oldValueRedacted: string;
      newValueRedacted: string;
      actorId: string;
      scope: string;
      ts: Date;
    }>;
    nextCursor: string | null;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await prisma.configAudit.findMany({
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      orderBy: { ts: "desc" },
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  // ── Test seam ───────────────────────────────────────────────────────────

  /** Reset internal caches — exposed for tests only. */
  __resetForTests(): void {
    this.secretSummaries.clear();
    this.secretCache.clear();
    this.tunableCache.invalidateAll();
    this.tunableDbBacked.clear();
    this.secretsLoaded = false;
    this.secretsLoadPromise = null;
    this.tunablesLoaded = false;
    this.tunablesLoadPromise = null;
    this.removeAllListeners();
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let singleton: ConfigService | null = null;

/** Process-wide ConfigService instance. */
export function getConfigService(): ConfigService {
  if (!singleton) singleton = new ConfigService();
  return singleton;
}

/** Test helper — clears the singleton between specs. */
export function __resetConfigSingleton(): void {
  singleton = null;
}

// Re-export the registry so callers can `import { ConfigService, CONFIG_KEYS }`.
export { CONFIG_KEYS };

/**
 * Convert a typed Zod-parsed value into the canonical string form persisted
 * in `runtime_config.value`. The reverse coercion lives in the registry's
 * `valueType` semantics and the application code that calls
 * `getNumber` / `getBool` / `JSON.parse(get(...))`.
 */
function serializeForStorage(valueType: ConfigKeyDef["valueType"], value: unknown): string {
  switch (valueType) {
    case "string":
      return String(value);
    case "int":
      return String(Math.trunc(Number(value)));
    case "bool":
      return value ? "true" : "false";
    case "csv":
      // Zod parser may return string or string[] depending on the schema; we
      // normalize to a comma-separated string so the env-fallback shape is
      // identical regardless of where the value came from.
      if (Array.isArray(value)) return value.join(",");
      return String(value);
    case "json":
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    default:
      return String(value);
  }
}
