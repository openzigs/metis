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

/** #1933 — what the CLI's staleness preflight checks before the provider is built. */
export interface StalenessPreflight<C extends string> {
  /** The corpora whose held-out purpose, materialization and patches are checked (a merge: none). */
  corpora: readonly C[];
  /** `--table-guard` reads a patch arm on the table corpus: its patches are checked too. */
  withGuard: boolean;
  /** A patch arm (A7S, A7SD) is reported: the patch sets are loaded. A7R and A7RD need none. */
  patches: boolean;
}

/**
 * #1834, #1925 — the staleness preflight, decided before any spend: nothing to
 * check when no staleness arm is reported, or a merge whose `--table-guard`
 * reads no patch arm; otherwise which corpora, whether the table corpus too,
 * and whether the patch sets are needed at all. A merge's `--table-guard` over
 * a patch arm without `--arms` is refused: the eval database would be unbound.
 * The arm sets are passed in so this module stays free of the arm definitions.
 */
export function stalenessPreflight<C extends string>(opts: {
  reportedArmIds: readonly string[];
  corpora: readonly C[];
  merge: boolean;
  tableGuard: boolean;
  /** `--arms` names a materialized arm (`agentArmsRequested`). */
  armsRequested: boolean;
  stalenessArmIds: ReadonlySet<string>;
  patchArmIds: ReadonlySet<string>;
}): StalenessPreflight<C> | undefined {
  const { reportedArmIds, merge } = opts;
  const patchArms = reportedArmIds.filter((id) => opts.patchArmIds.has(id));
  const withGuard = patchArms.length > 0 && opts.tableGuard;
  if (withGuard && merge && !opts.armsRequested) {
    throw new Error(
      `--table-guard reads ${patchArms.join(",")} on the materialized table corpus: pass --arms ${reportedArmIds.join(",")} (the recorded arms) so the eval database is bound`,
    );
  }
  if (!reportedArmIds.some((id) => opts.stalenessArmIds.has(id))) return undefined;
  if (merge && !withGuard) return undefined;
  return { corpora: merge ? [] : opts.corpora, withGuard, patches: patchArms.length > 0 };
}
