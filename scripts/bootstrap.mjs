#!/usr/bin/env node
/**
 * Cross-platform METIS bootstrap (Issue #188 / Epic #183).
 *
 * Single code path for `pnpm bootstrap` / `pnpm bootstrap:up` on Windows,
 * macOS, and Linux. Replaces `scripts/bootstrap.sh` while preserving behavior:
 *   1. preflight: docker/node/pnpm present + docker daemon reachable
 *   2. .env created from .env.example (idempotent) with crypto-random secrets
 *      generated via Node (no openssl shell-out)
 *   3. metis-mcp docker network ensured
 *   4. MCP wrapper images pulled from GHCR (fallback to local build)
 *   5. graphify install (optional, skipped if uv absent)
 *   6. --up: docker compose up -d + poll /readyz until healthy
 *
 * macOS/Linux side effects are unchanged (same files, network, images). All
 * subprocesses use `execFileSync` with argument arrays — no shell, no
 * injection surface (OWASP A03). Secrets are never logged (redactSecret).
 *
 * Exit codes mirror the bash script: 0 ok · 2 prereq missing · 3 docker daemon
 * unreachable · 4 /readyz timeout · 1 generic.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import http from "node:http";

import { generateSecrets, applySecrets, redactSecret } from "./lib/bootstrap-env.mjs";
import {
  REQUIRED_BINARIES,
  WRAPPERS,
  commandExists,
  wrapperTags,
} from "./lib/bootstrap-prereqs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const NETWORK_NAME = process.env.MCP_DOCKER_NETWORK ?? "metis-mcp";
const WRAPPER_REGISTRY = process.env.REGISTRY ?? "ghcr.io/metis-mcps";
const WRAPPER_DIR = path.join(REPO_ROOT, "images", "mcp-wrappers");
const READYZ_URL = process.env.READYZ_URL ?? "http://localhost:4000/readyz";
const READYZ_TIMEOUT_SECS = Number.parseInt(process.env.READYZ_TIMEOUT_SECS ?? "120", 10);

const log = (m) => console.log(`[bootstrap] ${m}`);
const warn = (m) => console.error(`[bootstrap] WARN: ${m}`);
const die = (m, code = 1) => {
  console.error(`[bootstrap] ERROR: ${m}`);
  process.exit(code);
};

/** Run a command with an argument array; no shell. */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

/** Quietly probe a command, capturing output and swallowing failures. */
function tryQuiet(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function preflight() {
  const missing = REQUIRED_BINARIES.filter((b) => !commandExists(b));
  if (missing.length > 0) {
    die(`missing required binaries: ${missing.join(", ")}. Install them and retry.`, 2);
  }
  if (!tryQuiet("docker", ["info"])) {
    die("Docker daemon is not reachable. Start Docker Desktop / dockerd and retry.", 3);
  }
  log("preflight OK (docker, node, pnpm present; daemon reachable)");
}

function ensureEnv() {
  const envFile = path.join(REPO_ROOT, ".env");
  const exampleFile = path.join(REPO_ROOT, ".env.example");
  if (existsSync(envFile)) {
    log(".env already present — skipping (no secrets rotated)");
    return;
  }
  if (!existsSync(exampleFile)) die(`.env.example missing at ${exampleFile}`);

  log("creating .env from .env.example");
  const template = readFileSync(exampleFile, "utf8");
  const secrets = generateSecrets();
  const content = applySecrets(template, secrets);
  writeFileSync(envFile, content, { mode: 0o600 });
  // chmod is a best-effort POSIX op; on Windows it is effectively a no-op.
  try {
    chmodSync(envFile, 0o600);
  } catch {
    /* Windows: ACL-based, mode ignored */
  }
  for (const key of Object.keys(secrets)) {
    log(`wrote ${key}=${redactSecret(secrets[key])}`);
  }
}

function ensureNetwork() {
  if (tryQuiet("docker", ["network", "inspect", NETWORK_NAME])) {
    log(`docker network ${NETWORK_NAME} already exists`);
    return;
  }
  log(`creating docker network ${NETWORK_NAME}`);
  run("docker", ["network", "create", NETWORK_NAME], { stdio: "ignore" });
}

function ensureWrapperImages() {
  const versionFile = path.join(WRAPPER_DIR, "VERSION");
  if (!existsSync(versionFile)) {
    die(`${versionFile} missing — cannot determine wrapper image tag`);
  }
  const version = readFileSync(versionFile, "utf8").trim();
  const tags = wrapperTags(WRAPPER_REGISTRY, version);
  let pullFailed = false;
  for (const tag of tags) {
    log(`pulling ${tag}`);
    if (!tryQuiet("docker", ["pull", tag])) {
      warn(`pull failed for ${tag} — will fall back to local build`);
      pullFailed = true;
    }
  }
  if (pullFailed) {
    warn(`one or more wrapper image pulls failed; building ${WRAPPERS.length} wrappers locally`);
    const buildScript = path.join(WRAPPER_DIR, "build.sh");
    if (commandExists("bash") && existsSync(buildScript)) {
      try {
        run("bash", [buildScript], { env: { ...process.env, REGISTRY: WRAPPER_REGISTRY } });
      } catch {
        die("wrapper build fallback failed — see images/mcp-wrappers/build.sh output");
      }
    } else {
      warn(
        "bash not available to run the wrapper build fallback. On Windows, run " +
          "'pnpm bootstrap' from Git Bash/WSL, or pre-pull the wrapper images.",
      );
    }
  }
}

function ensureGraphify() {
  if (!commandExists("uv")) {
    warn("uv not found — skipping graphify install (https://docs.astral.sh/uv/)");
    return;
  }
  if (commandExists("graphify")) {
    log("graphify already installed");
  } else {
    log("installing graphify via uv tool install graphifyy");
    try {
      run("uv", ["tool", "install", "graphifyy"]);
    } catch {
      warn("graphify install failed — run 'uv tool install graphifyy' manually");
      return;
    }
  }
  // Deliberately NOT running `graphify claude install` (#1152). It writes a graphify
  // navigation section into CLAUDE.md and a PreToolUse hook — the two things #1143
  // measured and removed (docs/decisions/0004-graphify-agent-navigation.md). Running it
  // here silently reverted that decision on every bootstrap. CLAUDE.md is hand-maintained.
}

function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300);
    });
    req.setTimeout(4000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function composeUpAndWait() {
  log("running docker compose up -d");
  run("docker", ["compose", "-f", path.join(REPO_ROOT, "docker-compose.yml"), "up", "-d"]);
  log(`waiting up to ${READYZ_TIMEOUT_SECS}s for ${READYZ_URL}`);
  const deadline = Date.now() + READYZ_TIMEOUT_SECS * 1000;
  while (Date.now() < deadline) {
    if (await httpOk(READYZ_URL)) {
      log("/readyz: ok — stack healthy");
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  die(
    `/readyz did not return 200 within ${READYZ_TIMEOUT_SECS}s. Inspect: docker compose logs server`,
    4,
  );
}

async function main() {
  const up = process.argv.includes("--up");
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log("Usage: pnpm bootstrap [--up]   (--up brings the stack up and waits for /readyz)");
    return;
  }
  log(`METIS bootstrap — repo=${REPO_ROOT}`);
  preflight();
  ensureEnv();
  ensureNetwork();
  ensureWrapperImages();
  ensureGraphify();
  if (up) {
    await composeUpAndWait();
  } else {
    log("bootstrap complete. Next: 'pnpm bootstrap:up' or 'docker compose up'.");
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
