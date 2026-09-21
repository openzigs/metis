#!/usr/bin/env node
/**
 * Cross-platform METIS bootstrap diagnostics (Issue #188 / Epic #183).
 *
 * Non-mutating pass/fail matrix replacing `scripts/bootstrap-check.sh`. Works
 * on Windows without `lsof` (uses the Node bind-based port probe) and without
 * `curl` (uses Node http). Output and exit-code semantics match the bash
 * version: human-readable matrix by default, `--json` for CI, exit code = #
 * failed checks (capped at 125).
 *
 * Read-only: never creates networks, writes .env, or pulls images. All
 * subprocesses use argument arrays (no shell).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import http from "node:http";

import { commandExists, wrapperTags } from "./lib/bootstrap-prereqs.mjs";
import { EXPECTED_PORTS, probePort } from "./lib/bootstrap-ports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const NETWORK_NAME = process.env.MCP_DOCKER_NETWORK ?? "metis-mcp";
const WRAPPER_REGISTRY = process.env.REGISTRY ?? "ghcr.io/metis-mcps";
const WRAPPER_DIR = path.join(REPO_ROOT, "images", "mcp-wrappers");
const EMBEDDINGS_HEALTHZ = process.env.EMBEDDINGS_HEALTHZ ?? "http://localhost:5050/healthz";

/** @type {Array<{ name: string, status: "pass" | "fail", hint?: string }>} */
const results = [];
const record = (name, status, hint) => results.push({ name, status, ...(hint ? { hint } : {}) });

const dockerQuiet = (args) => {
  try {
    execFileSync("docker", args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

function httpOk(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function runChecks() {
  // docker binary + daemon
  if (commandExists("docker")) record("docker binary present", "pass");
  else record("docker binary present", "fail", "install Docker Desktop / Rancher Desktop");

  if (!commandExists("docker")) record("docker daemon reachable", "fail", "docker not installed");
  else if (dockerQuiet(["info"])) record("docker daemon reachable", "pass");
  else record("docker daemon reachable", "fail", "start the Docker daemon and retry");

  // metis-mcp network
  if (!commandExists("docker")) record("metis-mcp network present", "fail", "docker not installed");
  else if (dockerQuiet(["network", "inspect", NETWORK_NAME]))
    record("metis-mcp network present", "pass");
  else
    record(
      "metis-mcp network present",
      "fail",
      `run 'docker compose up' or 'docker network create ${NETWORK_NAME}'`,
    );

  // wrapper images cached
  if (!commandExists("docker")) {
    record("wrapper images cached", "fail", "docker not installed");
  } else if (!existsSync(path.join(WRAPPER_DIR, "VERSION"))) {
    record("wrapper images cached", "fail", `${WRAPPER_DIR}/VERSION missing`);
  } else {
    const version = readFileSync(path.join(WRAPPER_DIR, "VERSION"), "utf8").trim();
    const tags = wrapperTags(WRAPPER_REGISTRY, version);
    const cached = tags.filter((t) => dockerQuiet(["image", "inspect", t])).length;
    if (cached === tags.length) record(`wrapper images cached: ${cached}/${tags.length}`, "pass");
    else
      record(
        `wrapper images cached: ${cached}/${tags.length}`,
        "fail",
        `run 'pnpm bootstrap' to pull from ${WRAPPER_REGISTRY}`,
      );
  }

  // .env present
  if (existsSync(path.join(REPO_ROOT, ".env"))) record(".env present", "pass");
  else record(".env present", "fail", "run 'pnpm bootstrap' to create it from .env.example");

  // ports — cross-platform bind probe (no lsof)
  for (const port of EXPECTED_PORTS) {
    const r = await probePort(port);
    if (r.free) {
      record(`port ${port} free`, "pass");
    } else if (
      commandExists("docker") &&
      dockerQuiet(["ps", "--filter", `publish=${port}`, "--filter", "name=metis"])
    ) {
      // Best-effort: a metis container may legitimately own the port.
      record(`port ${port} owned by metis (or in use)`, "pass");
    } else {
      record(`port ${port} free`, "fail", `another process is listening on :${port} (${r.reason})`);
    }
  }

  // embeddings sidecar
  if (await httpOk(EMBEDDINGS_HEALTHZ)) record("embeddings /healthz reachable", "pass");
  else
    record(
      "embeddings /healthz reachable",
      "fail",
      "embeddings sidecar not running — 'pnpm bootstrap:up' or 'docker compose up'",
    );

  // graphify
  if (commandExists("graphify")) record("graphify CLI present", "pass");
  else if (commandExists("uv"))
    record("graphify CLI present", "fail", "run 'pnpm bootstrap' (auto-installs via uv)");
  else record("graphify CLI present", "fail", "install uv first, then run 'pnpm bootstrap'");
}

function emit(json) {
  const total = results.length;
  const failed = results.filter((r) => r.status === "fail").length;
  const passed = total - failed;

  if (json) {
    console.log(
      JSON.stringify(
        { summary: { total, passed, failed }, checks: results.map((r) => ({ hint: "", ...r })) },
        null,
        2,
      ),
    );
  } else {
    console.log("metis bootstrap:check");
    console.log("─────────────────────────────────");
    for (const r of results) {
      if (r.status === "pass") console.log(`✔ ${r.name}`);
      else {
        console.log(`✘ ${r.name}`);
        if (r.hint) console.log(`   → fix: ${r.hint}`);
      }
    }
    console.log("─────────────────────────────────");
    console.log(`${failed} failed, ${passed} passed`);
  }
  return failed > 125 ? 125 : failed;
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log("Usage: pnpm bootstrap:check [--json]");
    return 0;
  }
  await runChecks();
  return emit(process.argv.includes("--json"));
}

main().then((code) => process.exit(code));
