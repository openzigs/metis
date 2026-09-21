/**
 * Tests for the encrypted vault-key sidecar cipher.
 *
 * This is the testable source of truth for the envelope format used by
 * scripts/export.mjs --include-vault-key and scripts/import.mjs. The .mjs
 * sibling (scripts/lib/vault-key-cipher.mjs) MUST stay format-compatible; the
 * cross-boundary round-trip test in scripts/lib/vault-key-cipher.test.mjs
 * asserts that the two implementations interoperate.
 */
import { describe, it, expect } from "vitest";
import {
  encryptVaultKey,
  decryptVaultKey,
  VAULT_KEY_ENVELOPE_VERSION,
  MIN_PASSPHRASE_LENGTH,
  VaultKeyCipherError,
} from "./vault-key-cipher.js";

const SAMPLE_KEY = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo="; // base64-ish master key
const GOOD_PASSPHRASE = "correct horse battery staple"; // >= 12 chars

describe("vault-key-cipher", () => {
  it("(a) round-trips encrypt -> decrypt and recovers the exact key", () => {
    const envelope = encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE);
    const recovered = decryptVaultKey(envelope, GOOD_PASSPHRASE);
    expect(recovered).toBe(SAMPLE_KEY);
  });

  it("produces a self-describing, versioned envelope", () => {
    const envelope = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    expect(envelope.v).toBe(VAULT_KEY_ENVELOPE_VERSION);
    expect(envelope.alg).toBe("aes-256-gcm");
    expect(envelope.kdf).toBe("scrypt");
    expect(typeof envelope.salt).toBe("string");
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.tag).toBe("string");
    expect(typeof envelope.ct).toBe("string");
    expect(envelope.kdfParams).toMatchObject({ N: expect.any(Number) });
  });

  it("(b) wrong passphrase throws and never leaks the plaintext key", () => {
    const envelope = encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE);
    try {
      decryptVaultKey(envelope, "wrong passphrase here");
      throw new Error("expected decrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VaultKeyCipherError);
      expect((err as Error).message).not.toContain(SAMPLE_KEY);
    }
  });

  it("(c) rejects tampered ciphertext", () => {
    const envelope = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    // Flip a byte in the ciphertext.
    const ctBuf = Buffer.from(envelope.ct, "base64");
    ctBuf[0] ^= 0xff;
    envelope.ct = ctBuf.toString("base64");
    expect(() => decryptVaultKey(JSON.stringify(envelope), GOOD_PASSPHRASE)).toThrow(
      VaultKeyCipherError,
    );
  });

  it("(c) rejects a tampered auth tag", () => {
    const envelope = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    const tagBuf = Buffer.from(envelope.tag, "base64");
    tagBuf[0] ^= 0xff;
    envelope.tag = tagBuf.toString("base64");
    expect(() => decryptVaultKey(JSON.stringify(envelope), GOOD_PASSPHRASE)).toThrow(
      VaultKeyCipherError,
    );
  });

  it("(d) refuses an empty passphrase on encrypt", () => {
    expect(() => encryptVaultKey(SAMPLE_KEY, "")).toThrow(VaultKeyCipherError);
  });

  it("(d) refuses a too-short passphrase on encrypt", () => {
    expect(() => encryptVaultKey(SAMPLE_KEY, "short")).toThrow(VaultKeyCipherError);
    // Boundary: one char below the minimum is rejected.
    const justUnder = "x".repeat(MIN_PASSPHRASE_LENGTH - 1);
    expect(() => encryptVaultKey(SAMPLE_KEY, justUnder)).toThrow(VaultKeyCipherError);
  });

  it("(d) refuses to encrypt an empty key", () => {
    expect(() => encryptVaultKey("", GOOD_PASSPHRASE)).toThrow(VaultKeyCipherError);
  });

  it("(e) rejects an unsupported envelope version", () => {
    const envelope = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    envelope.v = 999;
    expect(() => decryptVaultKey(JSON.stringify(envelope), GOOD_PASSPHRASE)).toThrow(
      VaultKeyCipherError,
    );
  });

  it("(e) rejects malformed / non-JSON envelopes", () => {
    expect(() => decryptVaultKey("not json", GOOD_PASSPHRASE)).toThrow(VaultKeyCipherError);
    expect(() => decryptVaultKey("{}", GOOD_PASSPHRASE)).toThrow(VaultKeyCipherError);
    expect(() => decryptVaultKey(JSON.stringify({ v: 1 }), GOOD_PASSPHRASE)).toThrow(
      VaultKeyCipherError,
    );
  });

  it("(e) rejects JSON that parses to a non-object (null / number)", () => {
    expect(() => decryptVaultKey("null", GOOD_PASSPHRASE)).toThrow(VaultKeyCipherError);
    expect(() => decryptVaultKey("42", GOOD_PASSPHRASE)).toThrow(VaultKeyCipherError);
  });

  it("(e) rejects an envelope with a missing non-salt field", () => {
    const envelope = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    // salt/iv/ct present but tag dropped → triggers the missing-fields guard.
    delete envelope.tag;
    expect(() => decryptVaultKey(JSON.stringify(envelope), GOOD_PASSPHRASE)).toThrow(
      VaultKeyCipherError,
    );
  });

  it("decrypts when kdfParams is omitted (defaults are applied)", () => {
    const envelope = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    delete envelope.kdfParams; // exercise the params/scrypt default fallbacks
    expect(decryptVaultKey(JSON.stringify(envelope), GOOD_PASSPHRASE)).toBe(SAMPLE_KEY);
  });

  it("(e) rejects an unsupported algorithm or kdf", () => {
    const env1 = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    env1.alg = "des";
    expect(() => decryptVaultKey(JSON.stringify(env1), GOOD_PASSPHRASE)).toThrow(
      VaultKeyCipherError,
    );
    const env2 = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    env2.kdf = "pbkdf2";
    expect(() => decryptVaultKey(JSON.stringify(env2), GOOD_PASSPHRASE)).toThrow(
      VaultKeyCipherError,
    );
  });

  it("(d) refuses a weak passphrase on decrypt too (defense in depth)", () => {
    const envelope = encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE);
    expect(() => decryptVaultKey(envelope, "short")).toThrow(VaultKeyCipherError);
  });

  it("(f) salt and IV differ across two encryptions of the same input", () => {
    const e1 = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    const e2 = JSON.parse(encryptVaultKey(SAMPLE_KEY, GOOD_PASSPHRASE));
    expect(e1.salt).not.toBe(e2.salt);
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.ct).not.toBe(e2.ct);
  });

  it("round-trips keys containing arbitrary bytes / unicode", () => {
    const tricky = "key-with-üñîçödé-and-\n-newlines-😀";
    const envelope = encryptVaultKey(tricky, GOOD_PASSPHRASE);
    expect(decryptVaultKey(envelope, GOOD_PASSPHRASE)).toBe(tricky);
  });
});
