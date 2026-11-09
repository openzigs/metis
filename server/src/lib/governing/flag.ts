/**
 * Epic #1866 (#1868) — the governing-documents feature flag.
 *
 * #1878 — ON by default: the paid held-out reading of the shipped behaviour
 * (`eval-data/readings/governing-02-clinic-records/baseline-A5-sonnet.md`)
 * passed every threshold #1867's manifest fixed before any arm ran, with no
 * no-evidence → compliant error. Unset, the feature is on.
 *
 * `GOVERNING_DOCS_ENABLED` reads exactly as `ConfigService.getBool(key, true)`
 * reads a boolean setting: unset or empty (`GOVERNING_DOCS_ENABLED=`) is the
 * default, on, as `ConfigService.get` maps `""` to unset. Any other value goes
 * through the same function, `isTruthyConfigValue` (`lib/config/truthy.ts`,
 * #1977): `1`, `true`, `yes` or `on`, case-insensitive, surrounding whitespace
 * ignored, keep it on; anything else (`0`, `false`, `no`, `off`, whitespace
 * only, an unrecognised word) turns it off, so a mistyped value fails closed. It once took only
 * `"1"`, and `true` — the natural first guess — silently 404'd every governing
 * route (#1962).
 *
 * Every governing route, job and analysis hook gates on this one helper.
 * Read at call time, so a test or an operator's restart sees a change without
 * a module reload.
 */

import { isTruthyConfigValue } from "../config/truthy.js";

export const GOVERNING_DOCS_ENABLED_ENV = "GOVERNING_DOCS_ENABLED";

/** #1878 — what the feature is when the variable is unset. */
export const GOVERNING_DOCS_ENABLED_DEFAULT = true;

export function isGoverningDocsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[GOVERNING_DOCS_ENABLED_ENV];
  return raw === undefined || raw === ""
    ? GOVERNING_DOCS_ENABLED_DEFAULT
    : isTruthyConfigValue(raw);
}
