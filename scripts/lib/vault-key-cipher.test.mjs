/**
 * Round-trip + format-compatibility test for the encrypted vault-key sidecar.
 *
 * This is the "e2e" for the --include-vault-key CLI/ops feature (NOT Playwright):
 *
 *   (1) .mjs encrypt -> .mjs decrypt round-trip recovers the exact key.
 *   (2) Cross-boundary: a fixed envelope produced by the TS source-of-truth
 *       (server/src/lib/portability/vault-key-cipher.ts) is decrypted by the
 *       .mjs sibling — proving the two implementations are format-compatible.
 *   (3) The actual scripts/export.mjs --include-vault-key and
 *       scripts/import.mjs are exercised end-to-end via a temp dir, reading the
 *       passphrase from env (NEVER argv) and confirming the sidecar decrypts.
 *
 * Runs under `pnpm test` via the @metis/scripts vitest config
 * (include: ["lib/**\/*.test.mjs"]).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encryptVaultKey,
  decryptVaultKey,
  VAULT_KEY_ENVELOPE_VERSION,
  VaultKeyCipherError,
} from "./vault-key-cipher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXPORT_MJS = path.join(REPO_ROOT, "scripts", "export.mjs");
const IMPORT_MJS = path.join(REPO_ROOT, "scripts", "import.mjs");

const GOOD_PASSPHRASE = "compat-passphrase-xyz"; // >= 12 chars

// A fixed envelope produced by the TS implementation
// (server/src/lib/portability/vault-key-cipher.ts). If the .mjs format ever
// drifts from the TS format, decrypting this vector will fail and this test
// will catch it.
const TS_PRODUCED_ENVELOPE =
  '{"v":1,"alg":"aes-256-gcm","kdf":"scrypt","kdfParams":{"N":16384,"r":8,"p":1,"keyLen":32},"salt":"sCwUXWLAlZuSox8Ni0AiwA==","iv":"cKd1YJ8YRFvGYZIn","tag":"GXDV6u8sU3bZ8DBW9J/Smg==","ct":"VH/URLXXU4kuHR8HGWkVZDbnz6AQVt7mfU5i"}';
const TS_PRODUCED_KEY = "VECTOR-KEY-from-TS-impl-123";
const TS_PRODUCED_PASSPHRASE = "compat-passphrase-xyz";

describe("vault-key-cipher (.mjs) round-trip", () => {
  it("(1) .mjs encrypt -> .mjs decrypt recovers the exact key", () => {
    const masterKey = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==";
    const envelope = encryptVaultKey(masterKey, GOOD_PASSPHRASE);
    expect(decryptVaultKey(envelope, GOOD_PASSPHRASE)).toBe(masterKey);
  });

  it("(2) decrypts an envelope produced by the TS source-of-truth (format compat)", () => {
    const env = JSON.parse(TS_PRODUCED_ENVELOPE);
    expect(env.v).toBe(VAULT_KEY_ENVELOPE_VERSION);
    const recovered = decryptVaultKey(TS_PRODUCED_ENVELOPE, TS_PRODUCED_PASSPHRASE);
    expect(recovered).toBe(TS_PRODUCED_KEY);
  });

  it("rejects wrong passphrase and weak passphrase", () => {
    const envelope = encryptVaultKey("some-key-value", GOOD_PASSPHRASE);
    expect(() => decryptVaultKey(envelope, "another-wrong-pass")).toThrow(VaultKeyCipherError);
    expect(() => encryptVaultKey("k", "short")).toThrow(VaultKeyCipherError);
  });
});

describe("export.mjs --include-vault-key -> import.mjs (CLI e2e)", () => {
  it("writes an encrypted sidecar on export and decrypts it on import (passphrase via env, never argv)", () => {
    const work = mkdtempSync(path.join(tmpdir(), "metis-vaultkey-e2e-"));
    try {
      // Fabricate a fake tarball + sha256 so import.mjs --dry-run preflight is
      // satisfied without touching the real DB or running restore.sh.
      const tarball = path.join(work, "metis-backup-TEST.tar.gz");
      writeFileSync(tarball, "not-a-real-tarball");

      const MASTER_KEY = "dGhpcy1pcy1hLWZha2UtbWFzdGVyLWtleS1iYXNlNjQ=";
      const PASSPHRASE = "export-import-e2e-passphrase";

      // --- EXPORT side: emit the encrypted sidecar only (--emit-vault-key-only)
      // so we don't invoke backup.sh / mutate the real instance. Passphrase and
      // master key come from env — NEVER argv.
      const sidecar = `${tarball}.vaultkey.enc`;
      execFileSync("node", [EXPORT_MJS, "--include-vault-key", "--emit-vault-key-only", tarball], {
        env: {
          ...process.env,
          VAULT_MASTER_KEY: MASTER_KEY,
          METIS_EXPORT_PASSPHRASE: PASSPHRASE,
        },
        stdio: "pipe",
      });

      expect(existsSync(sidecar)).toBe(true);
      const enc = readFileSync(sidecar, "utf8");
      // The sidecar must NOT contain the plaintext master key.
      expect(enc).not.toContain(MASTER_KEY);
      const parsed = JSON.parse(enc);
      expect(parsed.v).toBe(VAULT_KEY_ENVELOPE_VERSION);

      // --- IMPORT side: decrypt-only mode resolves the sidecar and prints the
      // recovered key length (never the key itself). We verify via the helper
      // that the recovered key matches.
      expect(decryptVaultKey(enc, PASSPHRASE)).toBe(MASTER_KEY);

      // Exercise import.mjs auto-detect of the sidecar in dry-run; it must
      // report the sidecar was found and the preflight passes via the decrypted
      // key (no VAULT_MASTER_KEY in env).
      const out = execFileSync("node", [IMPORT_MJS, tarball, "--dry-run"], {
        env: {
          ...process.env,
          VAULT_MASTER_KEY: "",
          METIS_EXPORT_PASSPHRASE: PASSPHRASE,
        },
        stdio: "pipe",
        encoding: "utf8",
      });
      expect(out).toContain("vault-key sidecar");
      expect(out).toMatch(/preflight\s+:\s+PASS/i);
      // The decrypted key must never be printed.
      expect(out).not.toContain(MASTER_KEY);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
