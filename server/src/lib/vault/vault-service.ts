/**
 * Hardened secret vault — AES-256-GCM with versioned envelopes.
 *
 * Layout of an encrypted blob (base64-encoded as a single string when stored):
 *
 *   [ keyVersion(1B) | salt(32B) | iv(16B) | tag(16B) | ciphertext... ]
 *
 * Key derivation:
 *   - Argon2id (memory-hard) when the optional `argon2` native module is
 *     installed. Production deploys SHOULD have it.
 *   - PBKDF2-SHA512 with 600_000 iterations (OWASP 2023 floor) as a portable
 *     fallback when argon2 is unavailable (e.g. CI runners without a native
 *     toolchain).
 *
 * Production safety:
 *   - When `NODE_ENV=production`, the constructor REFUSES to start with a
 *     missing or weak `VAULT_MASTER_KEY` — the process throws before serving
 *     a single request. There is no hidden random-key fallback.
 */
import crypto from "node:crypto";
import { ulid } from "ulid";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("vault");

/** Prisma's unique-index violation (`P2002`), matched on its code alone. */
function isUniqueConstraintError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";
}

const ALGORITHM = "aes-256-gcm" as const;
const KEY_VERSION = 0x01;
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 600_000;
const ARGON2_TIME_COST = 3;
const ARGON2_MEMORY_COST = 64 * 1024; // 64 MiB
const ARGON2_PARALLELISM = 1;
const MIN_MASTER_KEY_BYTES = 32;

interface Argon2Module {
  hash: (
    password: Buffer,
    options: {
      type: number;
      raw: true;
      salt: Buffer;
      hashLength: number;
      timeCost: number;
      memoryCost: number;
      parallelism: number;
    },
  ) => Promise<Buffer>;
  argon2id: number;
}

/**
 * Public scope tag — UI segregates "global" platform secrets from
 * "project"-scoped credentials.
 */
export type SecretScope = "global" | "project";

export interface SecretEnvelope {
  /** Single base64 string carrying the full versioned envelope. */
  ciphertext: string;
  /** Algorithm tag persisted alongside for forward compatibility. */
  algorithm: string;
  keyVersion: number;
}

export interface SecretSummary {
  id: string;
  label: string;
  description: string;
  scope: SecretScope;
  keyVersion: number;
  algorithm: string;
  createdAt: Date;
  updatedAt: Date;
}

export class VaultConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultConfigurationError";
  }
}

export class VaultDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultDecryptionError";
  }
}

let argon2Mod: Argon2Module | null | undefined;
async function loadArgon2(): Promise<Argon2Module | null> {
  if (argon2Mod !== undefined) return argon2Mod;
  try {
    const mod = (await import("argon2")) as unknown as Argon2Module;
    argon2Mod = mod;
    log.info("Vault key derivation: argon2id");
  } catch {
    argon2Mod = null;
    log.warn("argon2 module unavailable; vault falling back to PBKDF2-SHA512 (600k iterations)");
  }
  return argon2Mod;
}

/**
 * Hardened secret vault service.
 *
 * In production this is a singleton — `getVaultService()` returns the shared
 * instance. Tests construct disposable instances directly so each test can
 * inject its own master key.
 */
export class VaultService {
  private readonly masterKey: Buffer;
  private kdfMode: "argon2id" | "pbkdf2" = "pbkdf2";

  constructor(opts: { masterKey?: string; isProduction?: boolean } = {}) {
    const isProduction = opts.isProduction ?? process.env.NODE_ENV === "production";
    const provided = opts.masterKey ?? process.env.VAULT_MASTER_KEY;

    if (!provided) {
      if (isProduction) {
        throw new VaultConfigurationError(
          "VAULT_MASTER_KEY is required in production. Generate one with `openssl rand -base64 32`.",
        );
      }
      // Dev-only ephemeral key — secrets do not survive a restart.
      this.masterKey = crypto.randomBytes(KEY_LENGTH);
      log.warn("Vault using ephemeral master key — secrets will NOT survive restart");
      return;
    }

    let decoded: Buffer;
    try {
      decoded = Buffer.from(provided, "base64");
    } catch {
      throw new VaultConfigurationError("VAULT_MASTER_KEY is not valid base64");
    }
    if (decoded.length < MIN_MASTER_KEY_BYTES) {
      if (isProduction) {
        throw new VaultConfigurationError(
          `VAULT_MASTER_KEY must decode to at least ${MIN_MASTER_KEY_BYTES} bytes; got ${decoded.length}`,
        );
      }
      log.warn(
        `VAULT_MASTER_KEY decoded to ${decoded.length} bytes — acceptable for development only`,
      );
    }
    this.masterKey = decoded;
  }

  private async deriveKey(salt: Buffer): Promise<Buffer> {
    const argon2 = await loadArgon2();
    if (argon2) {
      this.kdfMode = "argon2id";
      return argon2.hash(this.masterKey, {
        type: argon2.argon2id,
        raw: true,
        salt,
        hashLength: KEY_LENGTH,
        timeCost: ARGON2_TIME_COST,
        memoryCost: ARGON2_MEMORY_COST,
        parallelism: ARGON2_PARALLELISM,
      });
    }
    this.kdfMode = "pbkdf2";
    return crypto.pbkdf2Sync(this.masterKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
  }

  /** Returns "argon2id" or "pbkdf2" — useful for diagnostics + tests. */
  get keyDerivation(): "argon2id" | "pbkdf2" {
    return this.kdfMode;
  }

  /**
   * Encrypt plaintext into a versioned base64 envelope.
   */
  async encrypt(plaintext: string): Promise<SecretEnvelope> {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = await this.deriveKey(salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const versionByte = Buffer.from([KEY_VERSION]);
    const blob = Buffer.concat([versionByte, salt, iv, tag, ct]);

    return {
      ciphertext: blob.toString("base64"),
      algorithm: ALGORITHM,
      keyVersion: KEY_VERSION,
    };
  }

  /**
   * Decrypt a versioned envelope. Throws `VaultDecryptionError` when the auth
   * tag verification fails (tampering or wrong key).
   */
  async decrypt(envelope: SecretEnvelope | string): Promise<string> {
    const blob = Buffer.from(
      typeof envelope === "string" ? envelope : envelope.ciphertext,
      "base64",
    );
    if (blob.length < 1 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1) {
      throw new VaultDecryptionError("Envelope too short");
    }
    const version = blob[0];
    if (version !== KEY_VERSION) {
      throw new VaultDecryptionError(`Unsupported key version ${version}`);
    }

    let cursor = 1;
    const salt = blob.subarray(cursor, cursor + SALT_LENGTH);
    cursor += SALT_LENGTH;
    const iv = blob.subarray(cursor, cursor + IV_LENGTH);
    cursor += IV_LENGTH;
    const tag = blob.subarray(cursor, cursor + TAG_LENGTH);
    cursor += TAG_LENGTH;
    const ct = blob.subarray(cursor);

    const key = await this.deriveKey(salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);

    try {
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString("utf8");
    } catch (err) {
      throw new VaultDecryptionError(
        `Decryption failed: ${(err as Error).message ?? "auth tag mismatch"}`,
      );
    }
  }

  // ── Persistence layer ────────────────────────────────────────────────────

  /**
   * Persist a new secret. Returns the stored row metadata (no plaintext).
   */
  async create(
    label: string,
    plaintext: string,
    scope: SecretScope = "global",
    opts: { description?: string; createdById?: string | null } = {},
  ): Promise<SecretSummary> {
    if (!label || label.trim().length === 0) {
      throw new Error("label is required");
    }
    const envelope = await this.encrypt(plaintext);
    const row = await prisma.secret.create({
      data: {
        name: this.scopedName(scope, label),
        description: opts.description ?? "",
        // Persist whole versioned envelope under `ciphertext`. The other
        // columns remain populated for forward-compat with rotation tooling.
        ciphertext: envelope.ciphertext,
        iv: "",
        tag: "",
        salt: "",
        keyVersion: envelope.keyVersion,
        algorithm: envelope.algorithm,
        createdById: opts.createdById ?? null,
      },
    });
    log.info("Secret created", { id: row.id, scope, label });
    return this.toSummary(row, scope);
  }

  /**
   * #93 — create-or-rotate by label, decided by the database's unique `name`
   * index rather than by a prior read. A soft-deleted row under the same name
   * is brought back live (the index still holds its name, so a fresh create
   * could never succeed). Prisma may run an upsert as read-then-create, so two
   * concurrent first writers can still collide on the index; the loser's
   * retry finds the winner's row and takes the update branch.
   */
  async upsert(
    label: string,
    plaintext: string,
    scope: SecretScope = "global",
    opts: { description?: string; createdById?: string | null } = {},
  ): Promise<SecretSummary> {
    if (!label || label.trim().length === 0) {
      throw new Error("label is required");
    }
    const envelope = await this.encrypt(plaintext);
    const name = this.scopedName(scope, label);
    const write = () =>
      prisma.secret.upsert({
        where: { name },
        create: {
          name,
          description: opts.description ?? "",
          ciphertext: envelope.ciphertext,
          iv: "",
          tag: "",
          salt: "",
          keyVersion: envelope.keyVersion,
          algorithm: envelope.algorithm,
          createdById: opts.createdById ?? null,
        },
        update: {
          ciphertext: envelope.ciphertext,
          keyVersion: envelope.keyVersion,
          algorithm: envelope.algorithm,
          deletedAt: null,
          // #112 — a revived row takes the caller's current description, not
          // the one it was cleared under. Omitted, the stored one stands.
          ...(opts.description !== undefined ? { description: opts.description } : {}),
        },
      });
    let row;
    try {
      row = await write();
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      row = await write();
    }
    log.info("Secret upserted", { id: row.id, scope, label });
    return this.toSummary(row, scope);
  }

  /**
   * Read and decrypt a single secret. Returns the plaintext.
   */
  async read(id: string): Promise<{ summary: SecretSummary; plaintext: string }> {
    const row = await prisma.secret.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new Error(`Secret ${id} not found`);
    const plaintext = await this.decrypt({
      ciphertext: row.ciphertext,
      algorithm: row.algorithm,
      keyVersion: row.keyVersion,
    });
    return { summary: this.toSummary(row, this.scopeOf(row.name)), plaintext };
  }

  /**
   * List secrets in a scope. PLAINTEXT IS NEVER RETURNED HERE — the UI uses
   * this to render labels only.
   */
  async list(scope?: SecretScope): Promise<SecretSummary[]> {
    const rows = await prisma.secret.findMany({
      where: {
        deletedAt: null,
        ...(scope ? { name: { startsWith: `${scope}:` } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toSummary(r, this.scopeOf(r.name)));
  }

  /**
   * Soft-delete a secret. Plaintext is irrecoverable once the row is purged.
   */
  async delete(id: string): Promise<void> {
    await prisma.secret.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    log.info("Secret soft-deleted", { id });
  }

  /**
   * Rotate the plaintext under an existing label, preserving id and scope.
   */
  async rotate(id: string, newPlaintext: string): Promise<SecretSummary> {
    const envelope = await this.encrypt(newPlaintext);
    const row = await prisma.secret.update({
      where: { id },
      data: {
        ciphertext: envelope.ciphertext,
        keyVersion: envelope.keyVersion,
        algorithm: envelope.algorithm,
      },
    });
    log.info("Secret rotated", { id });
    return this.toSummary(row, this.scopeOf(row.name));
  }

  /** Generate a fresh master key (base64 encoded) — for ops use. */
  static generateMasterKey(): string {
    return crypto.randomBytes(KEY_LENGTH).toString("base64");
  }

  /** Generate a stable id for callers that want one before persistence. */
  static generateId(): string {
    return ulid();
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private scopedName(scope: SecretScope, label: string): string {
    return `${scope}:${label}`;
  }

  private scopeOf(name: string): SecretScope {
    if (name.startsWith("project:")) return "project";
    return "global";
  }

  private toSummary(
    row: {
      id: string;
      name: string;
      description: string;
      keyVersion: number;
      algorithm: string;
      createdAt: Date;
      updatedAt: Date;
    },
    scope: SecretScope,
  ): SecretSummary {
    const label = row.name.includes(":") ? row.name.slice(row.name.indexOf(":") + 1) : row.name;
    return {
      id: row.id,
      label,
      description: row.description,
      scope,
      keyVersion: row.keyVersion,
      algorithm: row.algorithm,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

let singleton: VaultService | null = null;
export function getVaultService(): VaultService {
  if (!singleton) singleton = new VaultService();
  return singleton;
}

/** Test helper — clears the singleton so a new master key can be installed. */
export function __resetVaultSingleton(): void {
  singleton = null;
}
