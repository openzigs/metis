/**
 * #1766 — the arms of the portfolio gap-verdict eval, the order the runner works
 * through them, its resumable record file and its dollar cap. Pure: the script
 * (`server/scripts/eval-portfolio-gap.ts`) supplies the engine and the I/O.
 *
 * Arms are chosen only by `--arms`, never by an ambient `PORTFOLIO_GAP_*`
 * variable: each sets the engine's limits explicitly (the script spreads them
 * over `DEFAULT_PORTFOLIO_GAP_LIMITS`), so a report names exactly what ran.
 */
import type { GapItemOutcome } from "./scorer.js";

export interface GapArm {
  id: string;
  /** The name the issue gives it. */
  label: string;
  description: string;
  /** `PortfolioGapLimits.perRepoSearch` (#1763). */
  perRepoSearch: boolean;
}

/**
 * P0, today's engine (one shared search per product), and P0′ (#1763, each
 * project searched on its own with a per-repository quota). P1, #1764's agentic
 * pass, is added here when it lands.
 */
export const GAP_ARMS: readonly GapArm[] = [
  {
    id: "P0",
    label: "P0",
    description: "shipped engine: one shared federated search per product",
    perRepoSearch: false,
  },
  {
    id: "P0R",
    label: "P0′",
    description: "#1763 per-repo search: each project searched with a per-repo hit quota",
    perRepoSearch: true,
  },
];

/** The arms `--arms` names, in the order given; an unknown id throws before anything runs. */
export function parseGapArms(raw: string | undefined): GapArm[] {
  const ids = (raw ?? GAP_ARMS.map((a) => a.id).join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("--arms names no arm");
  const out: GapArm[] = [];
  for (const id of ids) {
    const arm = GAP_ARMS.find((a) => a.id === id);
    if (!arm) {
      throw new Error(`unknown arm ${id}: one of ${GAP_ARMS.map((a) => a.id).join(", ")}`);
    }
    if (!out.includes(arm)) out.push(arm);
  }
  return out;
}

/** A positive whole number from a flag, or the fallback when absent. */
export function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive whole number`);
  return n;
}

/** One unit of work: one item, one run, one arm. */
export interface GapWork {
  arm: string;
  run: number;
  itemId: string;
}

const workKey = (w: GapWork, model: string) =>
  `${model}\u0000${w.arm}\u0000${w.run}\u0000${w.itemId}`;

/**
 * What is left to run, run-major (every arm's run 1 before any run 2), so a cap
 * reached part-way still leaves whole first runs to compare.
 */
export function pendingWork(input: {
  itemIds: readonly string[];
  arms: readonly string[];
  runs: number;
  model: string;
  done: readonly GapItemOutcome[];
}): GapWork[] {
  const have = new Set(
    input.done.map((o) => workKey({ arm: o.arm, run: o.run, itemId: o.itemId }, o.model)),
  );
  const out: GapWork[] = [];
  for (let run = 1; run <= input.runs; run++) {
    for (const arm of input.arms) {
      for (const itemId of input.itemIds) {
        const w = { arm, run, itemId };
        if (!have.has(workKey(w, input.model))) out.push(w);
      }
    }
  }
  return out;
}

/** Parse the record file: one outcome per line; a malformed line throws, naming it. */
export function parseRecords(text: string): GapItemOutcome[] {
  const out: GapItemOutcome[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`record line ${i + 1} is not JSON`);
    }
    const o = (parsed ?? {}) as Partial<GapItemOutcome>;
    if (
      typeof o.itemId !== "string" ||
      typeof o.arm !== "string" ||
      typeof o.model !== "string" ||
      !Number.isInteger(o.run) ||
      typeof o.verdict !== "string" ||
      !Array.isArray(o.repos) ||
      typeof o.costUsd !== "number"
    ) {
      throw new Error(`record line ${i + 1} is not an outcome`);
    }
    out.push(o as GapItemOutcome);
  });
  return out;
}

/** One record line. */
export function recordLine(outcome: GapItemOutcome): string {
  return `${JSON.stringify(outcome)}\n`;
}

/**
 * Why the next item must not start, or null. The cap covers every outcome
 * already recorded for the model plus this invocation's spend: it stops once
 * the spend reaches the cap, or once the costliest item so far would carry it
 * past. An unpriced call stops the run, because with it the cap enforces nothing.
 */
export function budgetStop(input: {
  spentUsd: number;
  costliestItemUsd: number;
  budgetUsd: number;
  unpricedCalls: number;
}): string | null {
  if (input.unpricedCalls > 0) {
    return `${input.unpricedCalls} model call(s) had no ledger price: the cap cannot be enforced`;
  }
  if (input.spentUsd >= input.budgetUsd) {
    return `spent $${input.spentUsd.toFixed(4)} of the $${input.budgetUsd} cap`;
  }
  if (input.spentUsd + input.costliestItemUsd > input.budgetUsd) {
    return (
      `the costliest item so far ($${input.costliestItemUsd.toFixed(4)}) would carry ` +
      `$${input.spentUsd.toFixed(4)} past the $${input.budgetUsd} cap`
    );
  }
  return null;
}
