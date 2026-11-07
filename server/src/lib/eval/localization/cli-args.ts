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

/**
 * #1806 — `--reference A12,A13`: arms each other arm is ALSO paired with, beside
 * A0, so a pairing such as A13C against A12 comes from the runner's own
 * statistics rather than a one-off script. A0 is refused: every report already
 * pairs every arm with it. Whether each id is one of the run's arms is checked
 * by the runner, which knows the arms.
 */
export function referenceArmIds(argv: readonly string[]): string[] {
  const raw = flagValue(argv, "reference");
  if (raw === undefined) return [];
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) throw new Error("--reference needs an arm id, e.g. --reference A12");
  if (ids.includes("A0")) {
    throw new Error("--reference A0: every arm is already compared with A0");
  }
  return ids;
}

/**
 * #1819 — the `--reference` ids checked against the arms the run reports,
 * BEFORE the provider is built and the table guard runs: the runner checks them
 * too, but only after a corpus's arms have spent. Same refusals as the runner's.
 */
export function assertReferenceArms(
  references: readonly string[],
  armIds: readonly string[],
): void {
  for (const ref of references) {
    if (ref === "A0") throw new Error("--reference A0: every arm is already compared with A0");
    if (!armIds.includes(ref)) {
      throw new Error(`--reference ${ref} is not one of this run's arms (${armIds.join(", ")})`);
    }
  }
}
