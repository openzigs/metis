/**
 * Epic #1866 (#1868) — the governing-documents feature flag.
 *
 * Off by default. `GOVERNING_DOCS_ENABLED` accepts the truthy spellings
 * `ConfigService.getBool` accepts (`lib/config/config-service.ts`): `1`,
 * `true`, `yes` or `on`, case-insensitive, surrounding whitespace ignored.
 * Anything else leaves it off. It once took only `"1"`, and `true` — the
 * natural first guess — silently 404'd every governing route (#1962).
 *
 * Every governing route, job and analysis hook gates on this one helper, and it
 * stays off until a held-out reading of the shipped behaviour passes (#1878).
 * Read at call time, so a test or an operator's restart sees a change without a
 * module reload.
 */

export const GOVERNING_DOCS_ENABLED_ENV = "GOVERNING_DOCS_ENABLED";

/** The same pattern `ConfigService.getBool` tests a trimmed value against. */
const TRUTHY = /^(1|true|yes|on)$/i;

export function isGoverningDocsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[GOVERNING_DOCS_ENABLED_ENV];
  return raw !== undefined && TRUTHY.test(raw.trim());
}
