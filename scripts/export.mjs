#!/usr/bin/env node
/**
 * METIS export — full-instance portability bundle.
 *
 * Wraps scripts/backup.sh to produce a timestamped .tar.gz + .sha256 suitable
 * for transporting a METIS instance to a new host.
 *
 * Usage:
 *   node scripts/export.mjs [outDir] [--dry-run] [--include-vault-key] \
 *        [--emit-vault-key-only] [--help]
 *
 * Arguments:
 *   outDir              Optional. Output directory for the tarball.
 *                       Passed to backup.sh as its positional arg.
 *                       Defaults to ./backups (backup.sh default).
 *
 * Flags:
 *   --dry-run           Print the ordered execution plan and exit 0. Does NOT
 *                       invoke backup.sh or mutate any files.
 *   --include-vault-key Encrypt VAULT_MASTER_KEY with a passphrase and write it
 *                       to a SEPARATE sidecar file next to the tarball:
 *                       `<tarball>.vaultkey.enc`. The plaintext key is NEVER
 *                       written to disk and NEVER placed inside the tarball.
 *                       The passphrase is read from METIS_EXPORT_PASSPHRASE or
 *                       an interactive prompt — NEVER from argv (shell-history
 *                       leakage). See docs/DATA_PORTABILITY.md.
 *   --emit-vault-key-only
 *                       With --include-vault-key: write ONLY the encrypted
 *                       sidecar for the given tarball path and exit, without
 *                       invoking backup.sh. Useful for re-issuing a sidecar or
 *                       for testing. Requires the [outDir] positional to be the
 *                       target tarball path.
 *   --help, -h          Print usage and exit 0.
 *
 * Environment:
 *   DATABASE_URL            Prisma connection string (required by backup.sh)
 *   DATABASE_PROVIDER       sqlite | postgresql | postgres (default: sqlite)
 *   BACKUP_DIR              Output dir override (used by backup.sh if outDir omitted)
 *   BACKUP_RETENTION_DAYS   Prune old backups after N days (backup.sh, default 30)
 *   VAULT_MASTER_KEY        Required with --include-vault-key. The plaintext is
 *                           encrypted into the sidecar; it is NEVER bundled in
 *                           the tarball.
 *   METIS_EXPORT_PASSPHRASE Passphrase for the encrypted vault-key sidecar.
 *                           Read from env or interactive prompt; NEVER from argv.
 *
 * Security notes:
 *   - VAULT_MASTER_KEY plaintext is NEVER inside the tarball and NEVER written
 *     to a plaintext file. With --include-vault-key it travels ONLY inside the
 *     passphrase-encrypted `<tarball>.vaultkey.enc` sidecar (AES-256-GCM,
 *     scrypt-derived key, per-file random salt + IV).
 *   - The sidecar passphrase is read from METIS_EXPORT_PASSPHRASE or an
 *     interactive prompt — never from argv (which would leak into shell history
 *     and the process table).
 *   - All subprocesses use execFileSync with argument arrays (OWASP A03 — no
 *     shell string construction, no injection surface).
 *   - backup.sh hardcodes server/data/uploads and server/data/lancedb. If your
 *     deployment overrides UPLOAD_DIR or LANCEDB_PATH to paths outside those
 *     directories, those alternate paths will NOT be included in the tarball.
 *     Document the gap and run backup.sh manually with the corrected paths.
 *
 * Secret-presence heuristic (v1):
 *   The script cannot query the database without adding a Prisma/sqlite
 *   dependency — which we explicitly avoid to keep the script dependency-free.
 *   Instead, we conservatively warn that secrets MAY be present if a sqlite
 *   DB file is found, or unconditionally for postgres (we cannot inspect it
 *   without a connection). Operators must assume secrets are present and
 *   transport VAULT_MASTER_KEY accordingly. See docs/DATA_PORTABILITY.md.
 *
 * Exit codes:
 *   0  success (or --help / --dry-run)
 *   1  generic error
 *   2  usage error
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { encryptVaultKey } from "./lib/vault-key-cipher.mjs";
import { readPassphrase } from "./lib/passphrase.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const log = (m) => console.log(`[export] ${m}`);
const warn = (m) => console.error(`[export] WARN: ${m}`);
const die = (m, code = 1) => {
  console.error(`[export] ERROR: ${m}`);
  process.exit(code);
};

const BACKUP_SH = path.join(__dirname, "backup.sh");

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const includeVaultKey = args.includes("--include-vault-key");
const emitVaultKeyOnly = args.includes("--emit-vault-key-only");
// Path B (provider-agnostic logical NDJSON dump). `--logical` or `--mode logical`.
const modeIdx = args.indexOf("--mode");
const modeValue = modeIdx !== -1 ? args[modeIdx + 1] : null;
const logicalMode = args.includes("--logical") || modeValue === "logical";
const help = args.includes("--help") || args.includes("-h");
// Positional args are anything that doesn't start with '--' (and not the value
// consumed by --mode).
const positionals = args.filter(
  (a, i) => !a.startsWith("--") && a !== "-h" && !(modeIdx !== -1 && i === modeIdx + 1),
);
const outDir = positionals[0] ?? null;

// ── Help ──────────────────────────────────────────────────────────────────────

if (help) {
  console.log(`
Usage: node scripts/export.mjs [outDir] [--dry-run] [--include-vault-key] \\
       [--emit-vault-key-only] [--help]

  [outDir]              Optional output directory for the tarball.
                        Passed to backup.sh as its positional arg.
                        Defaults to ./backups.
                        With --emit-vault-key-only this is the TARBALL PATH
                        whose sidecar should be (re)written.

  --dry-run             Print the ordered execution plan and exit 0.
                        Does NOT invoke backup.sh or mutate anything.

  --include-vault-key   Encrypt VAULT_MASTER_KEY with a passphrase and write it
                        to a SEPARATE sidecar file next to the tarball:
                        <tarball>.vaultkey.enc. The plaintext key is NEVER
                        placed inside the tarball and NEVER written to a
                        plaintext file. AES-256-GCM with a scrypt-derived key
                        and a per-file random salt + IV. The passphrase is read
                        from METIS_EXPORT_PASSPHRASE or an interactive prompt —
                        NEVER from argv. Refuses weak/empty passphrases.

  --emit-vault-key-only With --include-vault-key: write ONLY the encrypted
                        sidecar for the given tarball path, then exit. Does NOT
                        invoke backup.sh. Use to re-issue a sidecar.

  --logical             PATH B: provider-agnostic LOGICAL export. Writes one
  --mode logical        <Model>.ndjson per model + logical-manifest.json to
                        [outDir] (default ./backups/logical) via
                        server/scripts/logical-export.ts. The result can be
                        reloaded across providers (SQLite <-> Postgres) with
                        \`node scripts/import.mjs <dumpDir> --logical\`. The
                        default (flag absent) is the PHYSICAL tarball backup —
                        unchanged.

  --help, -h            Print this help and exit 0.

Environment:
  DATABASE_URL            Prisma connection string (required by backup.sh)
  DATABASE_PROVIDER       sqlite | postgresql | postgres  (default: sqlite)
  BACKUP_DIR              Output directory override (backup.sh default: ./backups)
  BACKUP_RETENTION_DAYS   Days to retain old backups (backup.sh default: 30)
  VAULT_MASTER_KEY        Required with --include-vault-key (encrypted into the
                          sidecar; never bundled in the tarball).
  METIS_EXPORT_PASSPHRASE Passphrase for the encrypted vault-key sidecar.
                          Read from env or an interactive prompt; never argv.

Exit codes: 0 ok  1 generic error  2 usage error

See docs/DATA_PORTABILITY.md for the full runbook.
`);
  process.exit(0);
}

// ── Path B: provider-agnostic logical NDJSON export ────────────────────────────
//
// Delegates to `tsx server/scripts/logical-export.ts`, which connects via the
// Prisma client and writes one <Model>.ndjson per model + logical-manifest.json.
// Unlike the physical backup, a logical dump can be reloaded across providers
// (SQLite <-> Postgres). execFileSync with an argument array — no shell string
// construction (OWASP A03).
function runLogicalExport() {
  const out = outDir ?? path.join(REPO_ROOT, "backups", "logical");
  const cli = path.join(REPO_ROOT, "server", "scripts", "logical-export.ts");
  if (!existsSync(cli)) {
    die(`logical-export CLI not found at ${cli}`, 1);
  }
  if (dryRun) {
    log("DRY RUN — logical export plan:");
    log(`  1. provider : ${provider}`);
    log(`  2. outDir   : ${path.resolve(out)}`);
    log(`  3. invoke   : tsx ${cli} ${path.resolve(out)}`);
    log("DRY RUN complete — exiting without writing files");
    process.exit(0);
  }
  log(`starting LOGICAL export — outDir=${path.resolve(out)} provider=${provider}`);
  try {
    execFileSync("npx", ["tsx", cli, path.resolve(out)], {
      stdio: "inherit",
      env: process.env,
      cwd: path.join(REPO_ROOT, "server"),
    });
  } catch (err) {
    die(`logical-export failed: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
  log("");
  log("=== LOGICAL EXPORT COMPLETE ===");
  log(`  dump dir : ${path.resolve(out)}`);
  log("  NEXT     : on the target host, create the schema (prisma migrate deploy),");
  log("             then: node scripts/import.mjs <dumpDir> --logical [--remap <f.json>]");
  log("  See docs/DATA_PORTABILITY.md (Path B) for the full runbook.");
  process.exit(0);
}

// ── Encrypted vault-key sidecar helper ─────────────────────────────────────────
//
// Encrypts VAULT_MASTER_KEY with a passphrase-derived key and writes the
// `<tarball>.vaultkey.enc` sidecar. The plaintext master key is held only in
// memory and is NEVER written to disk in plaintext and NEVER placed inside the
// tarball.
async function writeVaultKeySidecar(tarballPath) {
  const masterKey = process.env.VAULT_MASTER_KEY;
  if (!masterKey || masterKey.length === 0) {
    die(
      "--include-vault-key requires VAULT_MASTER_KEY in the environment; " +
        "set it (e.g. `openssl rand -base64 32`) and retry",
      2,
    );
  }

  let passphrase;
  try {
    passphrase = await readPassphrase({ envVar: "METIS_EXPORT_PASSPHRASE" });
  } catch (err) {
    die(err instanceof Error ? err.message : String(err), 2);
  }

  let envelope;
  try {
    envelope = encryptVaultKey(masterKey, passphrase);
  } catch (err) {
    // VaultKeyCipherError (weak/empty passphrase, etc.). Never echo key/passphrase.
    die(`vault-key encryption failed: ${err instanceof Error ? err.message : String(err)}`, 2);
  }

  const sidecar = `${tarballPath}.vaultkey.enc`;
  writeFileSync(sidecar, envelope, { mode: 0o600 });
  log("");
  log(`=== ENCRYPTED VAULT-KEY SIDECAR ===`);
  log(`  wrote    : ${sidecar}`);
  log(`  contents : passphrase-encrypted VAULT_MASTER_KEY (AES-256-GCM, scrypt)`);
  log(`  NOTE     : plaintext key is NOT in the tarball and NOT on disk in plaintext`);
  return sidecar;
}

// ── Resolved paths ────────────────────────────────────────────────────────────

const resolvedOutDir = outDir ?? process.env.BACKUP_DIR ?? path.join(REPO_ROOT, "backups");
const provider = (process.env.DATABASE_PROVIDER ?? "sqlite").toLowerCase();

// ── Path B dispatch — logical mode short-circuits the physical backup path ────
if (logicalMode) {
  runLogicalExport();
}

// ── --emit-vault-key-only: write the sidecar for an existing tarball, exit ─────

if (emitVaultKeyOnly) {
  if (!includeVaultKey) {
    die("--emit-vault-key-only requires --include-vault-key", 2);
  }
  if (!outDir) {
    die("--emit-vault-key-only requires the tarball path as the positional argument", 2);
  }
  const tarballPath = path.resolve(outDir);
  await writeVaultKeySidecar(tarballPath);
  process.exit(0);
}

// ── Secret-presence warning (read-only heuristic — no DB dependency) ─────────

function warnSecretsPresent() {
  // v1 heuristic: we conservatively assume secrets may be present rather than
  // querying the DB (which would require adding a Prisma/sqlite dep). Operators
  // must transport VAULT_MASTER_KEY out-of-band regardless.
  let likelyHasSecrets = false;

  if (provider === "sqlite") {
    const dbUrl = process.env.DATABASE_URL ?? "file:./dev.db";
    let dbPath = dbUrl.replace(/^file:/, "");
    if (!path.isAbsolute(dbPath)) {
      dbPath = path.join(REPO_ROOT, "server", "prisma", dbPath);
    }
    if (existsSync(dbPath)) {
      likelyHasSecrets = true;
      log(`sqlite DB found at ${dbPath} — assuming secrets may be present`);
    }
  } else {
    // For postgres we cannot safely inspect the DB without a live connection.
    likelyHasSecrets = true;
    log(`provider=${provider} — assuming secrets may be present`);
  }

  if (likelyHasSecrets) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════════════════╗");
    console.error("║  VAULT_MASTER_KEY — OUT-OF-BAND TRANSPORT REQUIRED                  ║");
    console.error("╠══════════════════════════════════════════════════════════════════════╣");
    console.error("║  This export MAY contain encrypted connector secrets (API keys,      ║");
    console.error("║  passwords, tokens). The vault master key is NEVER bundled in the   ║");
    console.error("║  tarball — it is your responsibility to transport it securely and    ║");
    console.error("║  separately.                                                         ║");
    console.error("║                                                                      ║");
    console.error("║  If VAULT_MASTER_KEY is missing on the target host, every           ║");
    console.error("║  encrypted secret in the import will be permanently undecryptable.  ║");
    console.error("║                                                                      ║");
    console.error("║  Transport options (choose one):                                     ║");
    console.error("║    • Password manager / secrets vault (recommended)                  ║");
    console.error("║    • SSH-encrypted channel                                           ║");
    console.error("║    • 1Password / Bitwarden secure share                              ║");
    console.error("║                                                                      ║");
    console.error("║  See docs/DATA_PORTABILITY.md for the full runbook.                 ║");
    console.error("╚══════════════════════════════════════════════════════════════════════╝");
    console.error("");
  }
}

// ── Dry-run: print plan and exit ──────────────────────────────────────────────

if (dryRun) {
  log("DRY RUN — no files will be created or modified");
  log("");
  log("=== EXECUTION PLAN ===");
  log(`  1. resolved outDir    : ${resolvedOutDir}`);
  log(`  2. backup script      : ${BACKUP_SH}`);
  log(`  3. provider           : ${provider}`);
  log(`  4. invoke backup.sh   : bash ${BACKUP_SH}${outDir ? " " + resolvedOutDir : ""}`);
  log(`  5. emit tarball path  : parse backup.sh stdout for produced tarball`);
  log(`  6. emit sha256 path   : <tarball>.sha256`);
  if (includeVaultKey) {
    log(`  7. emit vaultkey      : <tarball>.vaultkey.enc (passphrase-encrypted master key)`);
    log(
      `  8. print NEXT STEPS   : carry tarball + sha256 + sidecar, transport PASSPHRASE separately`,
    );
  } else {
    log(`  7. print NEXT STEPS   : carry tarball + sha256, transport VAULT_MASTER_KEY out-of-band`);
  }
  log("");
  warnSecretsPresent();
  log("=== NEXT STEPS (after real export) ===");
  log("  1. Carry the .tar.gz and .tar.gz.sha256 files to the target host.");
  log("  2. Transport VAULT_MASTER_KEY out-of-band (password manager, SSH, etc.).");
  log("  3. On the target host: node scripts/import.mjs <tarball>");
  log("");
  log("DRY RUN complete — exiting without invoking backup.sh");
  process.exit(0);
}

// ── Preflight ─────────────────────────────────────────────────────────────────

if (!existsSync(BACKUP_SH)) {
  die(`backup.sh not found at ${BACKUP_SH}`, 1);
}

// ── Invoke backup.sh ──────────────────────────────────────────────────────────

log(`starting export — outDir=${resolvedOutDir} provider=${provider}`);
warnSecretsPresent();
log(`invoking backup.sh`);

const backupArgs = outDir ? [BACKUP_SH, outDir] : [BACKUP_SH];
let backupStdout = "";

try {
  // Capture stdout so we can parse the tarball path from backup.sh output.
  // stderr is passed through to the terminal (inherit) so the operator sees
  // backup.sh progress in real time.
  backupStdout = execFileSync("bash", backupArgs, {
    stdio: ["inherit", "pipe", "inherit"],
    env: process.env,
    encoding: "utf8",
  });
  // Echo backup.sh stdout so the operator sees it too.
  process.stdout.write(backupStdout);
} catch (err) {
  die(`backup.sh failed: ${err instanceof Error ? err.message : String(err)}`, 1);
}

// ── Parse produced tarball from backup.sh output ─────────────────────────────

// backup.sh emits: [backup] wrote /path/to/metis-backup-TIMESTAMP.tar.gz
const wroteMatch = backupStdout.match(/\[backup\] wrote (.+\.tar\.gz)/);
let tarball = null;
let sha256File = null;

if (wroteMatch) {
  tarball = wroteMatch[1].trim();
  sha256File = tarball + ".sha256";
} else {
  // Fallback: find the newest *.tar.gz in outDir
  warn("could not parse tarball path from backup.sh output; scanning outDir for newest tarball");
  if (existsSync(resolvedOutDir)) {
    const files = readdirSync(resolvedOutDir)
      .filter((f) => f.startsWith("metis-backup-") && f.endsWith(".tar.gz"))
      .map((f) => {
        const full = path.join(resolvedOutDir, f);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) {
      tarball = files[0].full;
      sha256File = tarball + ".sha256";
    }
  }
}

// ── Encrypted vault-key sidecar (after tarball is known) ──────────────────────

let vaultKeySidecar = null;
if (includeVaultKey) {
  if (!tarball) {
    die("--include-vault-key: cannot write sidecar — tarball path could not be determined", 1);
  }
  vaultKeySidecar = await writeVaultKeySidecar(tarball);
}

// ── Final summary ─────────────────────────────────────────────────────────────

if (tarball) {
  log("");
  log(`=== EXPORT COMPLETE ===`);
  log(`  tarball  : ${tarball}`);
  log(`  sha256   : ${sha256File}`);
  if (vaultKeySidecar) {
    log(`  vaultkey : ${vaultKeySidecar} (passphrase-encrypted)`);
  }
} else {
  warn("could not determine tarball path — check the output above");
}

console.log("");
console.log("=== NEXT STEPS ===");
console.log("  1. Carry the files to the target host:");
if (tarball) {
  console.log(`       ${tarball}`);
  console.log(`       ${sha256File}`);
  if (vaultKeySidecar) {
    console.log(`       ${vaultKeySidecar}   (encrypted vault key)`);
  }
} else {
  console.log(`       <tarball>   (see output above)`);
  console.log(`       <tarball>.sha256`);
}
if (vaultKeySidecar) {
  console.log("  2. Transport the SIDECAR PASSPHRASE out-of-band (NOT alongside the files).");
  console.log("     import.mjs auto-detects <tarball>.vaultkey.enc and decrypts it with the");
  console.log("     passphrase from METIS_EXPORT_PASSPHRASE (or an interactive prompt).");
  console.log("  3. On the target host, run:");
  console.log(`       METIS_EXPORT_PASSPHRASE=<pass> node scripts/import.mjs <tarball>`);
} else {
  console.log("  2. Transport VAULT_MASTER_KEY OUT-OF-BAND (password manager, SSH, etc.).");
  console.log("     Without it, every encrypted secret will be permanently undecryptable.");
  console.log("  3. On the target host, run:");
  console.log(`       VAULT_MASTER_KEY=<key> node scripts/import.mjs <tarball>`);
}
console.log("  4. See docs/DATA_PORTABILITY.md for the full runbook.");
console.log("");

async function main() {
  // main() is here to match bootstrap.mjs convention; all logic is top-level
  // since the script is synchronous. Kept for future async needs.
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
