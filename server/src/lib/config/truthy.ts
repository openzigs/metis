/**
 * #1977 — the ONE truthy test for boolean settings.
 *
 * `ConfigService.getBool` and the env-only flags that cannot go through the
 * config service (`GOVERNING_DOCS_ENABLED`, `lib/governing/flag.ts`) both read
 * a value with this, so a spelling added here reaches every boolean setting.
 * The governing flag once kept a copy of the pattern, and an earlier one took
 * only `"1"` (#1962).
 *
 * A leaf module, imported by `config-service.ts` (which re-exports it), so a
 * caller can share the test without loading the config service's prisma and
 * vault imports.
 */

/** Truthy: `1`, `true`, `yes` or `on`, case-insensitive, surrounding whitespace ignored. */
export function isTruthyConfigValue(raw: string): boolean {
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
