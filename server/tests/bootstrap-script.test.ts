/**
 * Issue #362 (Epic #359) — integration tests for `scripts/bootstrap.sh`.
 *
 * The bash script lives outside the TypeScript coverage scope, so these tests
 * spawn it as a subprocess in dry-run mode (BOOTSTRAP_DRY_RUN=1) against a
 * scratch repo layout in `os.tmpdir()`. They verify the script's externally
 * observable contract: idempotency on `.env`, secret generation format, the
 * --up flag, and unknown-argument rejection.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "bootstrap.sh");
const ENV_EXAMPLE = path.join(REPO_ROOT, ".env.example");
const VERSION_FILE = path.join(REPO_ROOT, "images", "mcp-wrappers", "VERSION");

function makeFakeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-bootstrap-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "images", "mcp-wrappers"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "bootstrap.sh"));
  fs.chmodSync(path.join(dir, "scripts", "bootstrap.sh"), 0o755);
  fs.copyFileSync(ENV_EXAMPLE, path.join(dir, ".env.example"));
  fs.copyFileSync(VERSION_FILE, path.join(dir, "images", "mcp-wrappers", "VERSION"));
  return dir;
}

function runScript(
  cwd: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [path.join(cwd, "scripts", "bootstrap.sh"), ...args], {
    cwd,
    env: { ...process.env, BOOTSTRAP_DRY_RUN: "1", ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("scripts/bootstrap.sh — Issue #362", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = makeFakeRepo();
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("creates .env from .env.example with hex-encoded secrets on a fresh clone", () => {
    // Run with DRY_RUN off so .env is actually written. Docker / pnpm /
    // openssl are required for preflight; if any are missing the test is
    // skipped (CI containers always have them).
    const haveDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    if (!haveDocker) return; // skip on machines without Docker.

    const result = spawnSync("bash", [path.join(scratch, "scripts", "bootstrap.sh")], {
      cwd: scratch,
      // No BOOTSTRAP_DRY_RUN so the .env write actually executes. We
      // override docker via PATH-injection to avoid touching the real
      // daemon's wrapper images.
      env: {
        ...process.env,
        PATH: `${makeFakeBinDir(scratch)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);

    const envContents = fs.readFileSync(path.join(scratch, ".env"), "utf8");
    for (const key of ["JWT_SECRET", "VAULT_MASTER_KEY", "EMBEDDINGS_TOKEN"]) {
      const match = envContents.match(new RegExp(`^${key}=([0-9a-f]+)$`, "m"));
      expect(match, `${key} should be set to hex string`).not.toBeNull();
      expect(match![1]).toHaveLength(64); // 32 bytes hex-encoded
    }
  });

  it("does NOT overwrite an existing .env (idempotent)", () => {
    fs.writeFileSync(path.join(scratch, ".env"), "JWT_SECRET=preserve-me\n", { mode: 0o600 });
    const result = runScript(scratch);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\.env already present — skipping/);
    expect(fs.readFileSync(path.join(scratch, ".env"), "utf8")).toBe("JWT_SECRET=preserve-me\n");
  });

  it("logs the wrapper image pulls for all 9 runners", () => {
    const result = runScript(scratch);
    expect(result.status).toBe(0);
    const expectedRunners = [
      "uvx-runner",
      "uvx-runner-sse",
      "jbang-runner",
      "jbang-runner-sse",
      "node-runner",
      "node-runner-sse",
      "npx-runner",
      "npx-runner-sse",
      "code-graph-runner-sse",
    ];
    for (const runner of expectedRunners) {
      expect(result.stdout).toContain(`ghcr.io/metis-mcps/${runner}:`);
    }
  });

  it("prints `would compose up` when --up is passed in dry-run mode", () => {
    fs.writeFileSync(path.join(scratch, ".env"), "stub=1\n");
    fs.writeFileSync(path.join(scratch, "docker-compose.yml"), "services: {}\n");
    const result = runScript(scratch, ["--up"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/docker compose .*up -d|would poll/);
  });

  it("rejects unknown arguments with a non-zero exit", () => {
    const result = runScript(scratch, ["--bogus"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown argument: --bogus/);
  });

  it("--help prints usage from the script header", () => {
    const result = runScript(scratch, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Idempotent/i);
  });
});

/**
 * Build a directory of fake `docker` / `pnpm` shims that always succeed, then
 * return the dir path. Used so the integration test does not actually pull
 * 9 GHCR images on every CI run.
 */
function makeFakeBinDir(scratch: string): string {
  const bin = path.join(scratch, "fake-bin");
  fs.mkdirSync(bin);
  const dockerShim = `#!/usr/bin/env bash
case "$1" in
  info) exit 0 ;;
  network)
    case "$2" in
      inspect) exit 1 ;;     # pretend network is missing so we exercise create
      create) echo "created $3"; exit 0 ;;
    esac ;;
  pull) exit 0 ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(bin, "docker"), dockerShim, { mode: 0o755 });
  // Ensure openssl + pnpm are still available — they're already on PATH so we
  // just symlink them.
  for (const realBin of ["openssl", "pnpm"]) {
    const src = execFileSync("which", [realBin], { encoding: "utf8" }).trim();
    if (src) fs.symlinkSync(src, path.join(bin, realBin));
  }
  return bin;
}
