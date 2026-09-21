/**
 * Cross-platform prerequisite detection + bootstrap planning (Issue #188).
 *
 * Pure-by-default helpers used by both `bootstrap.mjs` and the
 * `bootstrap:check` diagnostic. Binary presence is detected with
 * `commandExists`, which probes via `execFileSync` and an argument array (no
 * shell), so it is OWASP command-injection safe and works on Windows
 * (where `which` does not exist — `where` does, but we avoid relying on it).
 */
import { execFileSync } from "node:child_process";

/**
 * The binaries bootstrap needs. `openssl` is intentionally ABSENT — the Node
 * port generates secrets with `crypto.randomBytes` instead, so Windows boxes
 * without openssl can still bootstrap.
 *
 * @type {readonly string[]}
 */
export const REQUIRED_BINARIES = Object.freeze(["docker", "node", "pnpm"]);

/** Optional binaries — their absence is a warning, not a failure. */
export const OPTIONAL_BINARIES = Object.freeze(["uv", "graphify"]);

/**
 * MCP wrapper images pulled during bootstrap, identical to the bash `WRAPPERS`
 * array.
 *
 * @type {readonly string[]}
 */
export const WRAPPERS = Object.freeze([
  "uvx-runner",
  "uvx-runner-sse",
  "jbang-runner",
  "jbang-runner-sse",
  "node-runner",
  "node-runner-sse",
  "npx-runner",
  "npx-runner-sse",
  "code-graph-runner-sse",
]);

/**
 * Determine whether a command is resolvable on PATH, cross-platform.
 *
 * @param {string} bin - command name (no args).
 * @param {object} [deps]
 * @param {(cmd: string, args: string[]) => void} [deps.run] - probe runner.
 * @returns {boolean}
 */
export function commandExists(bin, deps = {}) {
  const run =
    deps.run ??
    /* c8 ignore next 3 — real execFileSync probe; tests inject run */
    ((cmd, args) => {
      execFileSync(cmd, args, { stdio: "ignore" });
    });
  // `<bin> --version` is supported by docker, node, pnpm, uv, graphify and is
  // safe (no shell). A non-zero exit / ENOENT throws → command absent.
  try {
    run(bin, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the fully-qualified wrapper image tags for a given registry + version.
 *
 * @param {string} registry - e.g. `ghcr.io/metis-mcps`.
 * @param {string} version - wrapper VERSION file contents (trimmed).
 * @returns {string[]}
 */
export function wrapperTags(registry, version) {
  const trimmedVersion = String(version).trim();
  return WRAPPERS.map((w) => `${registry}/${w}:${trimmedVersion}`);
}

/**
 * Compute the prerequisite report: which required binaries are missing and
 * which optional ones are absent. Pure given an injected `exists` predicate.
 *
 * @param {object} [deps]
 * @param {(bin: string) => boolean} [deps.exists] - presence predicate.
 * @returns {{ ok: boolean, missingRequired: string[], missingOptional: string[] }}
 */
export function checkPrereqs(deps = {}) {
  /* c8 ignore next — default presence predicate; tests inject exists */
  const exists = deps.exists ?? ((bin) => commandExists(bin));
  const missingRequired = REQUIRED_BINARIES.filter((b) => !exists(b));
  const missingOptional = OPTIONAL_BINARIES.filter((b) => !exists(b));
  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
  };
}
