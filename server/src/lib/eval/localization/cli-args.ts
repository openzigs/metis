/**
 * #1770 — the number flags of `pnpm eval:localization`, parsed strictly: a
 * value that is not what the flag means is refused, never coerced into one.
 */

/** The value after `--<name>`, or undefined when the flag is absent or bare. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
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
