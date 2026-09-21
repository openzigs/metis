/**
 * Encrypted vault-key sidecar cipher — `.mjs` sibling of the TS source of truth
 * at server/src/lib/portability/vault-key-cipher.ts.
 *
 * `.mjs` scripts (export.mjs / import.mjs) cannot import the `.ts` helper (no
 * build step on the script path), so this file MIRRORS the same self-describing,
 * versioned JSON envelope. The format-compatibility test at
 * scripts/lib/vault-key-cipher.test.mjs asserts the two implementations
 * interoperate (TS decrypts what this encrypts and vice versa).
 *
 * Keep this BYTE-FOR-BYTE format-compatible with the TS version on any change.
 *
 * Envelope:
 *   { v, alg:"aes-256-gcm", kdf:"scrypt", kdfParams:{N,r,p,keyLen},
 *     salt, iv, tag, ct }   — all binary fields base64-encoded.
 *
 * Node built-in `crypto` only.
 */
import crypto from "node:crypto";

export const VAULT_KEY_ENVELOPE_VERSION = 1;
export const MIN_PASSPHRASE_LENGTH = 12;

const ALGORITHM = "aes-256-gcm";
const KDF = "scrypt";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export class VaultKeyCipherError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "VaultKeyCipherError";
  }
}

/** @param {unknown} passphrase */
function assertStrongPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new VaultKeyCipherError("passphrase must be a non-empty string");
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultKeyCipherError(
      `passphrase too short: must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
    );
  }
}

/**
 * @param {string} plaintextKey
 * @param {string} passphrase
 * @returns {string} JSON envelope
 */
export function encryptVaultKey(plaintextKey, passphrase) {
  if (typeof plaintextKey !== "string" || plaintextKey.length === 0) {
    throw new VaultKeyCipherError("vault key plaintext must be a non-empty string");
  }
  assertStrongPassphrase(passphrase);

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const ct = Buffer.concat([cipher.update(plaintextKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: VAULT_KEY_ENVELOPE_VERSION,
    alg: ALGORITHM,
    kdf: KDF,
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keyLen: KEY_LENGTH },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  });
}

/**
 * @param {string} envelopeJson
 * @param {string} passphrase
 * @returns {string} recovered plaintext key
 */
export function decryptVaultKey(envelopeJson, passphrase) {
  assertStrongPassphrase(passphrase);

  let env;
  try {
    env = JSON.parse(envelopeJson);
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
    throw new VaultKeyCipherError(
      "vault-key decryption failed: wrong passphrase or tampered envelope",
    );
  }
}
