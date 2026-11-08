/**
 * Epic #1866 (#1868) — the governing-documents feature flag.
 *
 * Off by default. `GOVERNING_DOCS_ENABLED` accepts the truthy spellings
 * `ConfigService.getBool` accepts — the same function, `isTruthyConfigValue`
 * (`lib/config/truthy.ts`, #1977): `1`, `true`, `yes` or `on`,
 * case-insensitive, surrounding whitespace ignored.
 * Anything else leaves it off. It once took only `"1"`, and `true` — the
 * natural first guess — silently 404'd every governing route (#1962).
 *
 * Every governing route, job and analysis hook gates on this one helper, and it
 * stays off until a held-out reading of the shipped behaviour passes (#1878).
 * Read at call time, so a test or an operator's restart sees a change without a
 * module reload.
 */

import { isTruthyConfigValue } from "../config/truthy.js";

export const GOVERNING_DOCS_ENABLED_ENV = "GOVERNING_DOCS_ENABLED";

export function isGoverningDocsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[GOVERNING_DOCS_ENABLED_ENV];
  return raw !== undefined && isTruthyConfigValue(raw);
}
