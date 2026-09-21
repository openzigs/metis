/**
 * Encrypted vault-key sidecar cipher.
 *
 * This is the testable SOURCE OF TRUTH for the envelope format that
 * `scripts/export.mjs --include-vault-key` writes to `<tarball>.vaultkey.enc`
 * and `scripts/import.mjs` reads back. Because `.mjs` scripts cannot import
 * `.ts` directly (no build step on the script path), a hand-mirrored sibling
 * lives at `scripts/lib/vault-key-cipher.mjs`. The two MUST stay
 * format-compatible — the cross-boundary round-trip test
 * (`scripts/lib/vault-key-cipher.test.mjs`) asserts that TS can decrypt what
 * the `.mjs` encrypts and vice versa.
 *
 * Envelope (self-describing, versioned JSON — base64 fields):
 *   {
 *     "v": 1,
 *     "alg": "aes-256-gcm",
 *     "kdf": "scrypt",
 *     "kdfParams": { "N": 16384, "r": 8, "p": 1, "keyLen": 32 },
 *     "salt": "<base64 random 16B+>",
 *     "iv":   "<base64 random 12B>",
 *     "tag":  "<base64 16B GCM auth tag>",
 *     "ct":   "<base64 ciphertext>"
 *   }
 *
 * Security properties:
 *   - Passphrase-derived key via scrypt (memory-hard) with a per-file RANDOM
 *     salt. The VAULT_MASTER_KEY plaintext NEVER appears in the envelope.
 *   - AES-256-GCM with a random IV and a 16-byte auth tag → tampering of the
 *     ciphertext or tag fails closed (VaultKeyCipherError, no plaintext leak).
 *   - Weak/empty passphrases are refused (>= 12 chars) on BOTH encrypt and
 *     decrypt as defense in depth.
 *   - Node built-in `crypto` only; no third-party dependency.
 */
import crypto from "node:crypto";

export const VAULT_KEY_ENVELOPE_VERSION = 1 as const;

/** Minimum passphrase length. Refuse anything shorter — short passphrases are
 * brute-forceable even through scrypt. */
export const MIN_PASSPHRASE_LENGTH = 12;

const ALGORITHM = "aes-256-gcm";
const KDF = "scrypt";
const KEY_LENGTH = 32; // 256-bit AES key
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // GCM standard nonce
const TAG_LENGTH = 16;

// scrypt cost parameters. N must be a power of two. These defaults derive a key
// in well under a second on commodity hardware while remaining memory-hard.
// `maxmem` must be raised above the libuv default to allow N=16384.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MiB

export interface VaultKeyEnvelope {
  v: number;
  alg: string;
  kdf: string;
  kdfParams: { N: number; r: number; p: number; keyLen: number };
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export class VaultKeyCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyCipherError";
  }
}

function assertStrongPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new VaultKeyCipherError("passphrase must be a non-empty string");
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultKeyCipherError(
      `passphrase too short: must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
    );
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Encrypt a vault master key under a passphrase. Returns a JSON envelope
 * string ready to be written to the `<tarball>.vaultkey.enc` sidecar.
 */
export function encryptVaultKey(plaintextKey: string, passphrase: string): string {
  if (typeof plaintextKey !== "string" || plaintextKey.length === 0) {
    throw new VaultKeyCipherError("vault key plaintext must be a non-empty string");
  }
  assertStrongPassphrase(passphrase);

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const ct = Buffer.concat([cipher.update(plaintextKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: VaultKeyEnvelope = {
    v: VAULT_KEY_ENVELOPE_VERSION,
    alg: ALGORITHM,
    kdf: KDF,
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keyLen: KEY_LENGTH },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt a vault-key envelope produced by {@link encryptVaultKey} (or by the
 * `.mjs` sibling). Throws {@link VaultKeyCipherError} on any validation,
 * version, or authentication failure. The error message NEVER contains the
 * decrypted plaintext.
 */
export function decryptVaultKey(envelopeJson: string, passphrase: string): string {
  assertStrongPassphrase(passphrase);

  let env: Partial<VaultKeyEnvelope>;
  try {
    env = JSON.parse(envelopeJson) as Partial<VaultKeyEnvelope>;
  } catch {
    throw new VaultKeyCipherError("vault-key envelope is not valid JSON");
  }
  if (!env || typeof env !== "object") {
    throw new VaultKeyCipherError("vault-key envelope is malformed");
  }
  if (env.v !== VAULT_KEY_ENVELOPE_VERSION) {
    throw new VaultKeyCipherError(`unsupported vault-key envelope version: ${String(env.v)}`);
  }
  if (env.alg !== ALGORITHM) {
    throw new VaultKeyCipherError(`unsupported algorithm: ${String(env.alg)}`);
  }
  if (env.kdf !== KDF) {
    throw new VaultKeyCipherError(`unsupported kdf: ${String(env.kdf)}`);
  }
  if (
    typeof env.salt !== "string" ||
    typeof env.iv !== "string" ||
    typeof env.tag !== "string" ||
    typeof env.ct !== "string"
  ) {
    throw new VaultKeyCipherError("vault-key envelope is missing required fields");
  }

  const params = env.kdfParams ?? { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keyLen: KEY_LENGTH };
  const salt = Buffer.from(env.salt, "base64");
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const ct = Buffer.from(env.ct, "base64");

  const key = crypto.scryptSync(passphrase, salt, params.keyLen ?? KEY_LENGTH, {
    N: params.N ?? SCRYPT_N,
    r: params.r ?? SCRYPT_R,
    p: params.p ?? SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // Do NOT include the plaintext or key material in the error.
    throw new VaultKeyCipherError(
      "vault-key decryption failed: wrong passphrase or tampered envelope",
    );
  }
}
