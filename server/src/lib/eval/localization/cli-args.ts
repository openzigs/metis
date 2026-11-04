/**
 * #1770 — the number flags of `pnpm eval:localization`, parsed strictly: a
 * value that is not what the flag means is refused, never coerced into one.
 */

/**
 * The value after `--<name>`, or undefined when the flag is absent. A bare flag
 * (`--runs` last, or followed by another flag) is refused rather than read as
 * absent: it would silently fall back to the default (#1779).
 */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
  return v;
}

/** A dollar amount: any finite number ≥ 0. */
export function nonNegativeNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative number, not ${JSON.stringify(raw)}`);
  }
  return n;
}

/** A count: an integer ≥ 1. `--runs 0` is refused rather than run once. */
export function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 1) {
    throw new Error(`--${name} must be a whole number of at least 1, not ${JSON.stringify(raw)}`);
  }
  return n;
}
