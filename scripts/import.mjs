#!/usr/bin/env node
/**
 * METIS import — full-instance portability restore.
 *
 * Wraps scripts/restore.sh to restore a METIS backup tarball produced by
 * scripts/export.mjs (or directly by scripts/backup.sh).
 *
 * Usage:
 *   node scripts/import.mjs <tarball> [--dry-run] [--no-vault-key] \
 *        [--vault-key-file <path>] [--help]
 *
 * Arguments:
 *   <tarball>           Required. Path to the .tar.gz produced by export.mjs.
 *
 * Flags:
 *   --dry-run           Print the full ordered import plan + preflight result +
 *                       fix-up checklist and exit without mutating anything
 *                       (exit 0, or exit 2 if the vault preflight would block —
 *                       still no mutation). Does NOT invoke restore.sh.
 *   --no-vault-key      Explicit operator acknowledgement that VAULT_MASTER_KEY
 *                       is not set (either there are no secrets in this export,
 *                       or the operator accepts that secrets will be
 *                       undecryptable). Without this flag the script will fail
 *                       loudly if no vault key is available. See "Vault key
 *                       preflight" below.
 *   --vault-key-file <path>
 *                       Path to the encrypted vault-key sidecar produced by
 *                       `export.mjs --include-vault-key`. If omitted, the script
 *                       auto-detects `<tarball>.vaultkey.enc` next to the
 *                       tarball. When present, it is decrypted (passphrase from
 *                       METIS_EXPORT_PASSPHRASE or interactive prompt) and the
 *                       recovered key is placed in the in-memory process env as
 *                       VAULT_MASTER_KEY for the restore step. The decrypted key
 *                       is NEVER written to a plaintext file on disk.
 *   --help, -h          Print usage and exit 0.
 *
 * Environment:
 *   DATABASE_URL            Prisma connection string (required by restore.sh)
 *   DATABASE_PROVIDER       sqlite | postgresql | postgres (default: sqlite)
 *   VAULT_MASTER_KEY        Used directly if set. Otherwise the encrypted
 *                           sidecar (if present) is decrypted to supply it.
 *   METIS_EXPORT_PASSPHRASE Passphrase to decrypt the vault-key sidecar.
 *                           Read from env or interactive prompt; never argv.
 *
 * Vault key preflight (default-deny):
 *   After restore, METIS decrypts connector secrets using VAULT_MASTER_KEY. If
 *   the export contains any encrypted secrets and the target host has no
 *   VAULT_MASTER_KEY, those secrets will be permanently undecryptable and the
 *   imported installation will be non-functional.
 *
 *   Because this script cannot inspect the exported DB without adding a
 *   Prisma/sqlite dependency (which we explicitly avoid), we apply a
 *   default-deny policy: if VAULT_MASTER_KEY is absent, the script dies with
 *   exit 2 UNLESS --no-vault-key is passed.
 *
 *   Pass --no-vault-key only when:
 *     (a) you know the export contains no vault-encrypted secrets, OR
 *     (b) you intentionally accept that secrets will be undecryptable.
 *
 * Migration ordering:
 *   For SQLITE  — restore.sh replaces the DB file wholesale. If the export's
 *                 schemaVersion matches the target's METIS version, no separate
 *                 migration is needed after restore. If versions differ, run
 *                 migrations AFTER restore:
 *                   pnpm --filter @metis/server prisma migrate deploy
 *
 *   For POSTGRES — restore.sh runs pg_restore into the target database. The
 *                  target DB must exist and be accessible. If the export's
 *                  schemaVersion differs from the target version, run migrations
 *                  AFTER restore to forward-migrate the schema.
 *
 * WARNING: restore.sh OVERWRITES the live database. Stop the server before
 * running this script.
 *
 * Security notes:
 *   - All subprocesses use execFileSync with argument arrays (OWASP A03 — no
 *     shell string construction, no injection surface).
 *   - The tarball path passed to restore.sh is validated to exist as a file
 *     before passing it through.
 *
 * Exit codes:
 *   0  success (or --help / --dry-run)
 *   1  generic error
 *   2  usage error / preflight failure
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { decryptVaultKey } from "./lib/vault-key-cipher.mjs";
import { readPassphrase } from "./lib/passphrase.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const log = (m) => console.log(`[import] ${m}`);
const warn = (m) => console.error(`[import] WARN: ${m}`);
const die = (m, code = 1) => {
  console.error(`[import] ERROR: ${m}`);
  process.exit(code);
};

const RESTORE_SH = path.join(__dirname, "restore.sh");

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noVaultKey = args.includes("--no-vault-key");
const help = args.includes("--help") || args.includes("-h");

// Path B (provider-agnostic logical reload). `--logical` or `--mode logical`.
const modeIdx = args.indexOf("--mode");
const modeValue = modeIdx !== -1 ? args[modeIdx + 1] : null;
const logicalMode = args.includes("--logical") || modeValue === "logical";

// --remap <file.json> — optional connector/env-config remap for logical import.
let remapFileArg = null;
const remapIdx = args.indexOf("--remap");
if (remapIdx !== -1) {
  remapFileArg = args[remapIdx + 1] ?? null;
  if (!remapFileArg || remapFileArg.startsWith("--")) {
    die("--remap requires a file path argument", 2);
  }
}

// --vault-key-file <path> — explicit encrypted sidecar path. The value is the
// token immediately following the flag (it starts with a path, not '--').
let vaultKeyFileArg = null;
const vkfIdx = args.indexOf("--vault-key-file");
if (vkfIdx !== -1) {
  vaultKeyFileArg = args[vkfIdx + 1] ?? null;
  if (!vaultKeyFileArg || vaultKeyFileArg.startsWith("--")) {
    die("--vault-key-file requires a path argument", 2);
  }
}

// Positional args: anything not starting with '--', not '-h', and not a value
// consumed by --vault-key-file / --mode / --remap.
const consumedValueIdx = new Set();
if (vkfIdx !== -1) consumedValueIdx.add(vkfIdx + 1);
if (modeIdx !== -1) consumedValueIdx.add(modeIdx + 1);
if (remapIdx !== -1) consumedValueIdx.add(remapIdx + 1);
const positionals = args.filter(
  (a, i) => !a.startsWith("--") && a !== "-h" && !consumedValueIdx.has(i),
);
const tarball = positionals[0] ?? null;

// ── Help ──────────────────────────────────────────────────────────────────────

if (help) {
  console.log(`
Usage: node scripts/import.mjs <tarball> [--dry-run] [--no-vault-key] [--help]

  <tarball>             Required. Path to the .tar.gz produced by export.mjs.

  --dry-run             Print the ordered import plan, preflight result, and
                        fix-up checklist. Exit without mutating anything
                        (exit 0, or exit 2 if the vault preflight would block
                        — still no mutation).

  --no-vault-key        Bypass the vault-key preflight check.
                        Pass ONLY if you know the export contains no encrypted
                        secrets, OR you accept that secrets will be
                        undecryptable on this host.

  --vault-key-file <path>
                        Encrypted vault-key sidecar produced by
                        export.mjs --include-vault-key. If omitted, the script
                        auto-detects <tarball>.vaultkey.enc next to the tarball.
                        Decrypted in-memory (passphrase via
                        METIS_EXPORT_PASSPHRASE or interactive prompt) and used
                        as VAULT_MASTER_KEY for restore — never written to a
                        plaintext file.

  --logical             PATH B: provider-agnostic LOGICAL import. The positional
  --mode logical        argument is the DUMP DIRECTORY (not a tarball) produced
                        by \`export.mjs --logical\`. Loads NDJSON into a FRESH
                        target DB in FK-safe order (referenced rows first; cyclic
                        FKs nulled then UPDATEd in a 2nd pass) via
                        server/scripts/logical-import.ts. PRECONDITION: create the
                        schema first (prisma migrate deploy) and ensure tables are
                        empty. Verifies per-model row counts and fails loud on
                        mismatch. The default (flag absent) is the PHYSICAL
                        restore — unchanged.

  --remap <file.json>   With --logical: apply env-specific connector/config
                        rewrites (RepoConnection apiBaseUrl/localPath/uploadPath,
                        DatabaseConnection host/port/databaseName, MCPServer url,
                        env-specific RuntimeConfig tunables) after load, inside a
                        transaction. Zod-validated; rejects unknown shapes and
                        non-tunable RuntimeConfig keys. Without --remap the
                        post-import fix-up checklist is printed instead.

  --help, -h            Print this help and exit 0.

Environment:
  DATABASE_URL            Prisma connection string (required by restore.sh)
  DATABASE_PROVIDER       sqlite | postgresql | postgres  (default: sqlite)
  VAULT_MASTER_KEY        Used directly if set; otherwise supplied by decrypting
                          the sidecar.
  METIS_EXPORT_PASSPHRASE Passphrase to decrypt the vault-key sidecar.

WARNING: this script OVERWRITES the live database.
Stop the METIS server before running import.

Vault key policy (default-deny):
  If no vault key is available (neither VAULT_MASTER_KEY in env nor a
  decryptable sidecar), import fails loudly unless --no-vault-key is passed.
  This prevents silently importing an installation where all connector secrets
  are permanently undecryptable.

Exit codes: 0 ok  1 generic error  2 usage/preflight error

See docs/DATA_PORTABILITY.md for the full runbook.
`);
  process.exit(0);
}

// ── Path B: provider-agnostic logical NDJSON import ────────────────────────────
//
// In logical mode the positional is the DUMP DIRECTORY (not a tarball). The
// target schema must already exist (run `prisma migrate deploy` first) and the
// target tables must be empty. Delegates to server/scripts/logical-import.ts via
// execFileSync with an argument array (no shell string — OWASP A03).
function runLogicalImport() {
  const dumpDir = tarball; // positional[0] is the dump dir in logical mode
  if (!dumpDir) {
    die(
      "missing required argument: <dumpDir>\n" +
        "Usage: node scripts/import.mjs <dumpDir> --logical [--remap <file.json>]",
      2,
    );
  }
  const cli = path.join(REPO_ROOT, "server", "scripts", "logical-import.ts");
  if (!existsSync(cli)) {
    die(`logical-import CLI not found at ${cli}`, 1);
  }
  const resolvedDump = path.resolve(dumpDir);
  const cliArgs = ["tsx", cli, resolvedDump];
  if (remapFileArg) cliArgs.push("--remap", path.resolve(remapFileArg));

  if (dryRun) {
    log("DRY RUN — logical import plan:");
    log(`  1. dump dir : ${resolvedDump}`);
    log(`  2. remap    : ${remapFileArg ? path.resolve(remapFileArg) : "(none)"}`);
    log("  3. PRECONDITION: target schema created (prisma migrate deploy) + empty tables");
    log(`  4. invoke   : npx ${cliArgs.join(" ")}`);
    log("DRY RUN complete — exiting without mutating the database");
    process.exit(0);
  }

  log("=== LOGICAL IMPORT (Path B) ===");
  log("PRECONDITION: target schema must already exist (prisma migrate deploy) and");
  log("target tables must be empty. The import verifies row counts and FAILS LOUD on");
  log("mismatch.");
  try {
    execFileSync("npx", cliArgs, {
      stdio: "inherit",
      env: process.env,
      cwd: path.join(REPO_ROOT, "server"),
    });
  } catch (err) {
    die(`logical-import failed: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
  log("logical import complete");
  if (!remapFileArg) {
    log("No --remap supplied: review env-specific connector/config rows for this host.");
  }
  log("See docs/DATA_PORTABILITY.md (Path B) for the full runbook.");
  process.exit(0);
}

if (logicalMode) {
  runLogicalImport();
}

// ── Usage guard ───────────────────────────────────────────────────────────────

if (!tarball) {
  die(
    "missing required argument: <tarball>\n" +
      "Usage: node scripts/import.mjs <tarball> [--dry-run] [--no-vault-key] [--help]",
    2,
  );
}

// ── Vault key preflight (default-deny) ───────────────────────────────────────
//
// We cannot cheaply inspect the export tarball for secrets without adding a
// Prisma/sqlite dependency. Instead we apply default-deny: if VAULT_MASTER_KEY
// is absent, we refuse to proceed unless the operator explicitly passes
// --no-vault-key. This prevents silent data loss (permanently undecryptable
// secrets) for the common case where the export DOES contain secrets.

// `vaultKeyPresent` may become true after we decrypt the sidecar below, so it
// is computed lazily rather than frozen at module load.
let vaultKeyPresent = Boolean(process.env.VAULT_MASTER_KEY);
let vaultKeySource = vaultKeyPresent ? "env" : "none";

/**
 * Resolve an encrypted vault-key sidecar (explicit --vault-key-file or
 * auto-detected <tarball>.vaultkey.enc), decrypt it in-memory, and inject the
 * recovered key into process.env.VAULT_MASTER_KEY for the restore step.
 *
 * The decrypted key is NEVER written to a plaintext file. If VAULT_MASTER_KEY
 * is already set in the env, the sidecar is left untouched (env wins).
 */
async function resolveVaultKeySidecar(resolvedTarball) {
  if (vaultKeyPresent) return; // env-provided key takes precedence.

  const sidecarPath = vaultKeyFileArg
    ? path.resolve(vaultKeyFileArg)
    : `${resolvedTarball}.vaultkey.enc`;

  if (!existsSync(sidecarPath)) {
    if (vaultKeyFileArg) {
      die(`--vault-key-file not found: ${sidecarPath}`, 2);
    }
    return; // no sidecar; preflight default-deny applies.
  }

  log(`vault-key sidecar detected: ${sidecarPath}`);

  let passphrase;
  try {
    passphrase = await readPassphrase({ envVar: "METIS_EXPORT_PASSPHRASE" });
  } catch (err) {
    die(err instanceof Error ? err.message : String(err), 2);
  }

  let envelope;
  try {
    envelope = readFileSync(sidecarPath, "utf8");
  } catch (err) {
    die(`could not read vault-key sidecar: ${err instanceof Error ? err.message : String(err)}`, 1);
  }

  let recovered;
  try {
    recovered = decryptVaultKey(envelope, passphrase);
  } catch (err) {
    // Never echo the passphrase or any decrypted material.
    die(
      `vault-key sidecar decryption failed: ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }

  // Inject into the in-memory env only — restore.sh inherits process.env.
  process.env.VAULT_MASTER_KEY = recovered;
  vaultKeyPresent = true;
  vaultKeySource = "sidecar";
  log("vault-key sidecar decrypted — VAULT_MASTER_KEY set in-memory for restore");
}

function vaultPreflight() {
  if (!vaultKeyPresent && !noVaultKey) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════════════════╗");
    console.error("║  IMPORT BLOCKED — VAULT_MASTER_KEY not set                          ║");
    console.error("╠══════════════════════════════════════════════════════════════════════╣");
    console.error("║  This export may contain encrypted connector secrets (API keys,      ║");
    console.error("║  passwords, tokens). Without VAULT_MASTER_KEY on this host,         ║");
    console.error("║  every encrypted secret will be permanently undecryptable and the   ║");
    console.error("║  imported installation will be non-functional.                       ║");
    console.error("║                                                                      ║");
    console.error("║  To proceed, choose one of:                                          ║");
    console.error("║    (a) Set VAULT_MASTER_KEY in the environment:                      ║");
    console.error("║          VAULT_MASTER_KEY=<key> node scripts/import.mjs <tarball>   ║");
    console.error("║    (b) If you know there are no secrets, acknowledge explicitly:     ║");
    console.error("║          node scripts/import.mjs <tarball> --no-vault-key            ║");
    console.error("║                                                                      ║");
    console.error("║  See docs/DATA_PORTABILITY.md for the full runbook.                 ║");
    console.error("╚══════════════════════════════════════════════════════════════════════╝");
    console.error("");
    process.exit(2);
  }

  if (!vaultKeyPresent && noVaultKey) {
    console.error("");
    warn("--no-vault-key passed: proceeding WITHOUT VAULT_MASTER_KEY.");
    warn("Any encrypted secrets in this export will be permanently undecryptable.");
    warn("If this export contains secrets, the imported installation WILL be broken.");
    console.error("");
  }
}

// ── Tarball / sha256 sidecar check ───────────────────────────────────────────

function checkTarball() {
  const resolvedTarball = path.resolve(tarball);
  if (!existsSync(resolvedTarball)) {
    if (dryRun) {
      warn(`tarball not found at ${resolvedTarball} (dry-run — continuing)`);
    } else {
      die(`tarball not found: ${resolvedTarball}`, 2);
    }
  }

  const sha256File = resolvedTarball + ".sha256";
  if (!existsSync(sha256File)) {
    // restore.sh skips sha256 verification if the sidecar is absent (not an
    // error in restore.sh), but we warn loudly so the operator is aware.
    warn(
      `sha256 sidecar not found at ${sha256File} — integrity check will be SKIPPED by restore.sh. ` +
        "Ensure you received the correct tarball from a trusted source.",
    );
  } else {
    log(`sha256 sidecar present: ${sha256File}`);
  }

  return resolvedTarball;
}

// ── Post-import fix-up checklist ──────────────────────────────────────────────
//
// These keys mirror server/src/lib/portability/env-config-classifier.ts
// (ENV_SPECIFIC_TUNABLE_KEYS) and the connector model fields documented in
// docs/DATA_PORTABILITY.md. We duplicate the short list here rather than
// importing the TS module (which would require a build step). The TS helpers
// remain the authoritative source; keep this list in sync on changes.

const ENV_SPECIFIC_TUNABLE_KEYS = [
  "LOCAL_GEMMA_BASE_URL",
  "MCP_DOCKER_NETWORK",
  "MCP_IMAGE_ALLOWLIST",
  "MCP_K8S_NAMESPACE",
  "MCP_K8S_SERVICE_DOMAIN",
  "MCP_K8S_EGRESS_ALLOWLIST",
  "DB_ALLOWED_HOSTS",
  "REPO_ALLOWED_HOSTS",
  "PUBLISH_GITHUB_ALLOWED_HOSTS",
];

function printFixupChecklist() {
  console.log("");
  console.log("=== POST-IMPORT FIX-UP CHECKLIST ===");
  console.log("");
  console.log("1. ENVIRONMENT-SPECIFIC CONFIG KEYS (review and override for this host):");
  for (const k of ENV_SPECIFIC_TUNABLE_KEYS) {
    console.log(`     [ ] ${k}`);
  }
  console.log("");
  console.log("2. CONNECTOR MODEL FIELDS (update per-connector in the METIS UI or DB):");
  console.log("     RepoConnection:       localPath, uploadPath, apiBaseUrl");
  console.log("     DatabaseConnection:   host, port, databaseName");
  console.log("     MCPServer:            url, command, runtime");
  console.log("     JiraConnection:       baseUrl, proxyUrl");
  console.log("     RuntimeConfig:        URL/host rows (any topology-coupled rows)");
  console.log("");
  console.log("3. RE-INDEX VECTOR STORE (if lancedb was NOT carried over in the tarball,");
  console.log("   or if content differs from the source host):");
  console.log("     POST /api/admin/embeddings/projects/:projectId/reindex");
  console.log("   Run this for each project to rebuild the vector index on the new host.");
  console.log("");
  console.log("4. See docs/DATA_PORTABILITY.md for the full runbook.");
  console.log("");
}

// ── Migration ordering guidance ───────────────────────────────────────────────

function printMigrationGuidance(provider) {
  console.log("=== MIGRATION ORDERING ===");
  if (provider === "sqlite") {
    console.log("  SQLITE: restore.sh replaces the DB file wholesale.");
    console.log("  - If the export schemaVersion matches the target METIS version,");
    console.log("    no migration is needed after restore.");
    console.log("  - If versions differ, run AFTER restore.sh completes:");
    console.log("      pnpm --filter @metis/server prisma migrate deploy");
  } else {
    console.log("  POSTGRES: restore.sh runs pg_restore into the target database.");
    console.log("  - The target DB must already exist and be accessible via DATABASE_URL.");
    console.log("  - If the export schemaVersion differs from the target METIS version,");
    console.log("    run migrations AFTER restore.sh completes:");
    console.log("      pnpm --filter @metis/server prisma migrate deploy");
  }
  console.log("");
}

// ── Dry-run: print plan and exit ──────────────────────────────────────────────

const provider = (process.env.DATABASE_PROVIDER ?? "sqlite").toLowerCase();
const resolvedTarball = path.resolve(tarball);

if (dryRun) {
  // Resolve + decrypt the sidecar first so the plan reports the true status.
  await resolveVaultKeySidecar(resolvedTarball);
  log("DRY RUN — no files will be created or modified");
  log("");
  log("=== IMPORT PLAN ===");
  log(`  1. tarball              : ${resolvedTarball}`);
  log(`  2. sha256 sidecar       : ${resolvedTarball}.sha256`);
  log(`  3. restore script       : ${RESTORE_SH}`);
  log(`  4. provider             : ${provider}`);
  log(`  5. VAULT_MASTER_KEY     : ${vaultKeyPresent ? `present (${vaultKeySource})` : "ABSENT"}`);
  log(`  6. --no-vault-key       : ${noVaultKey ? "yes (preflight bypassed)" : "no"}`);
  log(`  7. vault preflight      : ${vaultKeyPresent || noVaultKey ? "PASS" : "FAIL (exit 2)"}`);
  log(`  8. invoke restore.sh    : bash ${RESTORE_SH} ${resolvedTarball}`);
  log(`  9. print fix-up checklist`);
  log("");
  vaultPreflight(); // dry-run still runs preflight so operator sees the status
  checkTarball();
  printMigrationGuidance(provider);
  printFixupChecklist();
  log("DRY RUN complete — exiting without invoking restore.sh");
  process.exit(0);
}

// ── Real import ───────────────────────────────────────────────────────────────

// Step 0: resolve + decrypt the vault-key sidecar (sets VAULT_MASTER_KEY in
// the in-memory env if a decryptable sidecar is present). The decrypted key is
// never written to a plaintext file.
await resolveVaultKeySidecar(resolvedTarball);

// Step 1: vault preflight (may exit 2)
vaultPreflight();

// Step 2: tarball + sidecar check
const checkedTarball = checkTarball();

// Step 3: preflight restore.sh existence
if (!existsSync(RESTORE_SH)) {
  die(`restore.sh not found at ${RESTORE_SH}`, 1);
}

// Step 4: migration guidance (before restore so operator can see it)
log("=== PRE-RESTORE CHECKLIST ===");
log("STOP THE METIS SERVER before this step if you have not already.");
log("restore.sh will OVERWRITE the live database.");
log("");
printMigrationGuidance(provider);

// Step 5: invoke restore.sh
log(`invoking restore.sh with tarball: ${checkedTarball}`);

try {
  execFileSync("bash", [RESTORE_SH, checkedTarball], {
    stdio: "inherit",
    env: process.env,
  });
} catch (err) {
  die(`restore.sh failed: ${err instanceof Error ? err.message : String(err)}`, 1);
}

// Step 6: post-restore fix-up checklist
log("restore.sh completed successfully");
printFixupChecklist();
log("import complete — restart the METIS server after completing the fix-up checklist");

async function main() {
  // main() is here to match bootstrap.mjs convention; logic is top-level for
  // synchronous flow. Kept for future async needs.
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
