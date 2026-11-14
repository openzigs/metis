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

import { z } from "zod";

const TRUE_RE = /^(1|true|yes|on)$/i;
const FALSE_RE = /^(0|false|no|off)$/i;

/** Truthy: `1`, `true`, `yes` or `on`, case-insensitive, surrounding whitespace ignored. */
export function isTruthyConfigValue(raw: string): boolean {
  return TRUE_RE.test(raw.trim());
}

/**
 * #2493 — the strict reading the admin API's `bool` write schema uses: `true`
 * for a truthy spelling, `false` for `0` / `false` / `no` / `off`
 * (case-insensitive, trimmed), `undefined` for anything else. Wherever this
 * returns a boolean, {@link isTruthyConfigValue} agrees with it, so a value the
 * API accepts reads back the same way an env value of that spelling does.
 */
export function parseConfigBool(raw: string): boolean | undefined {
  const v = raw.trim();
  if (TRUE_RE.test(v)) return true;
  if (FALSE_RE.test(v)) return false;
  return undefined;
}

/**
 * #2493 (and #2344's `MCP_REMOTE_ENABLED`) — the write schema for every `bool`
 * config key, and the body parser for the admin reindex `fresh` flag (#2499).
 * Coercing with `Boolean(value)` would turn any non-empty string, "false"
 * included, into true, so a client writing "false" switched the flag on. This
 * takes exactly the clear spellings the read path (`getBool` →
 * `isTruthyConfigValue`) understands, via {@link parseConfigBool}: a JSON
 * boolean, the number 0 or 1, or `true` / `false` / `1` / `0` / `yes` / `no` /
 * `on` / `off` as a string, case-insensitive and trimmed. Anything else (`""`,
 * whitespace, `null`, other strings and numbers) is refused rather than guessed
 * at. `ConfigService.set` stores the result as `"true"` / `"false"`.
 */
export const strictBoolSchema = z.union([
  z.boolean(),
  z.union([z.literal(0), z.literal(1)]).transform((n) => n === 1),
  z.string().transform((raw, ctx) => {
    const b = parseConfigBool(raw);
    if (b === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Expected true/false, 1/0, yes/no or on/off",
      });
      return z.NEVER;
    }
    return b;
  }),
]);
