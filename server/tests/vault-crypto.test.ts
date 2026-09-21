/**
 * Vault crypto round-trip + tamper-detection tests.
 */
import { describe, expect, it } from "vitest";
import {
  VaultConfigurationError,
  VaultDecryptionError,
  VaultService,
} from "../src/lib/vault/vault-service.js";

const MASTER = Buffer.alloc(32, 7).toString("base64");

describe("VaultService crypto", () => {
  it("round-trips plaintext through encrypt/decrypt", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const env = await v.encrypt("super-secret-value");
    expect(env.ciphertext).toBeTypeOf("string");
    expect(env.algorithm).toBe("aes-256-gcm");
    expect(env.keyVersion).toBe(1);
    const pt = await v.decrypt(env);
    expect(pt).toBe("super-secret-value");
  });

  it("starts the envelope with the key-version byte 0x01", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const env = await v.encrypt("hello");
    const buf = Buffer.from(env.ciphertext, "base64");
    expect(buf[0]).toBe(1);
    // 1 (version) + 32 (salt) + 16 (iv) + 16 (tag) + ciphertext (>=1)
    expect(buf.length).toBeGreaterThan(1 + 32 + 16 + 16);
  });

  it("rejects a tampered ciphertext via auth-tag verification", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const env = await v.encrypt("payload");
    const buf = Buffer.from(env.ciphertext, "base64");
    // Flip a byte in the ciphertext segment.
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
    await expect(v.decrypt(buf.toString("base64"))).rejects.toBeInstanceOf(VaultDecryptionError);
  });

  it("rejects a wrong master key", async () => {
    const v1 = new VaultService({ masterKey: MASTER, isProduction: false });
    const v2 = new VaultService({
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      isProduction: false,
    });
    const env = await v1.encrypt("payload");
    await expect(v2.decrypt(env)).rejects.toBeInstanceOf(VaultDecryptionError);
  });

  it("rejects unsupported key versions", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const env = await v.encrypt("payload");
    const buf = Buffer.from(env.ciphertext, "base64");
    buf[0] = 0x99;
    await expect(v.decrypt(buf.toString("base64"))).rejects.toBeInstanceOf(VaultDecryptionError);
  });

  it("rejects truncated envelopes", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    await expect(v.decrypt("AAAA")).rejects.toBeInstanceOf(VaultDecryptionError);
  });

  it("FAILS FAST when NODE_ENV=production and VAULT_MASTER_KEY is missing", () => {
    const original = process.env.VAULT_MASTER_KEY;
    delete process.env.VAULT_MASTER_KEY;
    try {
      expect(() => new VaultService({ masterKey: undefined, isProduction: true })).toThrow(
        VaultConfigurationError,
      );
    } finally {
      if (original !== undefined) process.env.VAULT_MASTER_KEY = original;
    }
  });

  it("FAILS FAST when production master key is too short", () => {
    expect(
      () =>
        new VaultService({
          masterKey: Buffer.alloc(8, 1).toString("base64"),
          isProduction: true,
        }),
    ).toThrow(VaultConfigurationError);
  });

  it("allows a short master key in development with a warning", () => {
    const v = new VaultService({
      masterKey: Buffer.alloc(8, 1).toString("base64"),
      isProduction: false,
    });
    expect(v).toBeInstanceOf(VaultService);
  });

  it("generates a fresh 32-byte master key", () => {
    const k = VaultService.generateMasterKey();
    expect(Buffer.from(k, "base64").length).toBe(32);
    const id = VaultService.generateId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
  });

  it("reports the active key derivation mode after first use", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    await v.encrypt("payload");
    expect(["argon2id", "pbkdf2"]).toContain(v.keyDerivation);
  });
});
