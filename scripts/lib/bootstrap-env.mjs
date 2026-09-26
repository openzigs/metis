/**
 * Bootstrap env + secret helpers (Issue #188 / Epic #183).
 *
 * Cross-platform replacement for the `.env` / secret-generation portion of
 * `scripts/bootstrap.sh`. All functions here are PURE (no filesystem) except
 * `generateHexSecret`, which uses Node's `crypto.randomBytes` — a
 * cross-platform CSPRNG, so we no longer shell out to `openssl` (Windows has
 * no `openssl` by default).
 *
 * Secrets are hex-encoded (no `=`/`+`/`/`) so they survive shell quoting in
 * downstream tooling, matching the original script's choice.
 */
import { randomBytes } from "node:crypto";

/**
 * The three secret slots populated on first `.env` creation, identical to the
 * awk replacement set in `bootstrap.sh`. (#150 — `COPILOT_NATIVE_TOKEN`, the
 * shared secret of the removed Copilot sidecar, is no longer generated.)
 *
 * @type {readonly string[]}
 */
export const SECRET_KEYS = Object.freeze(["JWT_SECRET", "VAULT_MASTER_KEY", "EMBEDDINGS_TOKEN"]);

/**
 * Generate a hex-encoded random secret.
 *
 * @param {number} [bytes=32] - entropy in bytes (default 32 → 64 hex chars).
 * @param {() => Buffer} [rng] - injectable RNG (defaults to crypto.randomBytes).
 * @returns {string}
 */
export function generateHexSecret(bytes = 32, rng) {
  /* c8 ignore next — default CSPRNG; the no-arg path is covered by a real-RNG test */
  const gen = rng ?? (() => randomBytes(bytes));
  return gen().toString("hex");
}

/**
 * Produce a fresh secret for every key in {@link SECRET_KEYS}.
 *
 * @param {() => string} [make] - injectable secret factory (tests use a stub).
 * @returns {Record<string, string>}
 */
export function generateSecrets(make) {
  const factory = make ?? (() => generateHexSecret());
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of SECRET_KEYS) out[key] = factory();
  return out;
}

/**
 * Apply secret values to the lines of a `.env` file, line-oriented so the rest
 * of the template (comments, ordering) is preserved byte-for-byte aside from
 * the replaced values. Only the FIRST occurrence of each `KEY=` is replaced.
 *
 * Mirrors the awk rule `/^KEY=/ {print "KEY=" value; next}`.
 *
 * @param {string} content - the full `.env` template text.
 * @param {Record<string, string>} secrets - key → value to inject.
 * @returns {string} the templated content (same trailing-newline behavior as input).
 */
export function applySecrets(content, secrets) {
  const replaced = new Set();
  // Preserve the input's line separators conservatively by splitting on \n and
  // operating per line; the .gitattributes rule keeps .env LF so this is safe.
  const lines = content.split("\n");
  const out = lines.map((line) => {
    for (const key of Object.keys(secrets)) {
      if (replaced.has(key)) continue;
      if (line.startsWith(`${key}=`)) {
        replaced.add(key);
        return `${key}=${secrets[key]}`;
      }
    }
    return line;
  });
  return out.join("\n");
}

/**
 * Redact a secret for safe logging — never print the value itself.
 *
 * @param {string} value
 * @returns {string} e.g. `****… (64 chars)`
 */
export function redactSecret(value) {
  const len = value?.length ?? 0;
  return `****… (${len} chars)`;
}
