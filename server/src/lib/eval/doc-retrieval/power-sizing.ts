/**
 * Issue #1184 — how many queries a decisive chunk-size answer needs, and the
 * go/no-go that number bought.
 *
 * ## The question this module answers before any arm runs
 *
 * #1160 kept `DEFAULT_RAG_CHUNK_SIZE` at 2048 and recorded that "smaller retrieves
 * more precisely" was refuted. #1178 then found those arms were four chunkings of
 * corpora differing by 14 points of content, and on the repaired chunker `size-1024`
 * moved from −0.111 to +0.024. The decision did not change — nothing cleared the
 * pre-registered +0.04 floor — but the reasoning under it did, so #1184 asks whether
 * the question should be re-opened on a corpus large enough to resolve the effect.
 *
 * "Large enough" is not a matter of taste. {@link queriesNeededForHalfWidth} turns a
 * measured spread into a query count, so the corpus decision is arithmetic on numbers
 * already committed rather than an argument about how many documents feels like
 * enough. That is #1184's first acceptance criterion, and it is discharged here from
 * {@link PRIOR_RUN_SIZING} — inputs copied from the committed #1183 artefact, with the
 * required counts COMPUTED, never written.
 *
 * ## Why the sd is derived rather than stored
 *
 * `PairedComparison` carries `n`, `ciLow` and `ciHigh` but no `sd`, and the per-query
 * delta vectors are not serialised into the artefact — so the spread has to come back
 * out of the interval. Under the same normal approximation
 * {@link queriesNeededForHalfWidth} already is (`hw = z·sd/√n`), that inversion is
 * exact: `sd = hw·√n / z`, and the sizing reduces to `n_needed = n · (hw / target)²`.
 *
 * The interval it inverts is a PERCENTILE BOOTSTRAP, which is not symmetric, so
 * `hw = (ciHigh − ciLow)/2` is a summary of it rather than the interval itself. Treat
 * every count here as a sizing estimate — the same caveat `queriesNeededForHalfWidth`
 * already carries, restated because this module is where the number gets used to spend
 * effort. It is reported beside the measured half-width so the two can be compared.
 *
 * ## The ceiling is pre-registered too
 *
 * A sizing number only becomes a decision against a budget, and a budget chosen after
 * seeing the number is not a budget. {@link PRACTICAL_QUERY_CEILING} is committed with
 * the sizing inputs, before any corpus work, so the go/no-go is computed rather than
 * argued.
 */
import { MIN_IMPORTANT_DELTA } from "../embed-retrieval/rerank-sweep.js";
import { queriesNeededForHalfWidth, Z_95, type MeanWithCi } from "../embed-retrieval/stats.js";

/**
 * Half-widths the sizing is reported against.
 *
 * The first is {@link MIN_IMPORTANT_DELTA} itself — the floor `chunk-sweep.ts` re-exports
 * as `MIN_IMPORTANT_NDCG_DELTA`, imported from its own module here so this file does not
 * form an import cycle with the renderer that consumes it. A corpus that cannot resolve
 * its own decision floor cannot tell "no effect" from "an effect worth shipping", which
 * is the state the size arms are actually in. 0.03 is #1157's corpus bar and 0.02 is the
 * resolution #1184's body asks about.
 */
export const SIZING_TARGETS: readonly number[] = [MIN_IMPORTANT_DELTA, 0.03, 0.02];

/**
 * The largest hand-authored corpus this project will pay for, PRE-REGISTERED.
 *
 * Every query is a hand-checked question with a verbatim, uniquely-resolving answer
 * span, so the cost is roughly linear in the count and does not amortise. 250 is about
 * five times `docretrieval-01` and is set here, with the sizing inputs and before any
 * corpus work, so that {@link corpusGoNoGo} returns a decision instead of ratifying one.
 */
export const PRACTICAL_QUERY_CEILING = 250;

/** Queries {@link PRIOR_RUN_SIZING}'s intervals were measured on. */
export const PRIOR_RUN_QUERY_COUNT = 48;

/** One arm's committed interval, as the sizing needs it. */
export interface SizingInput {
  armId: string;
  subset: string;
  n: number;
  meanDelta: number;
  ciLow: number;
  ciHigh: number;
}

/**
 * The `all`-subset intervals from the committed #1183 run
 * (`server/src/lib/eval/provenance/doc-retrieval-chunk-sweep-2026-07-31T20-37-55-374Z.json`,
 * moved there from `eval-results/` by #1382), which is
 * the last sweep run on a chunker that tiles.
 *
 * Copied inputs, computed outputs: nothing in this file states a required query count.
 * `all` and not a stratum — #1183 measured that the arm-sensitive subset is an
 * unadjusted subgroup rather than a power-preserving filter, so sizing against it would
 * size against the wrong denominator.
 *
 * **"Copied" is asserted against the artefact, not just claimed here.** These literals were
 * first committed hand-transcribed and every one of the eighteen was wrong at ~5e-5 — close
 * enough that the ±0.04 counts were unaffected and nothing failed, and one published ±0.02
 * cell read 759 where the artefact gives 760. The adversarial panel on #1184 found it
 * (`test-falsifiability` and `instruction-correctness`, independently), and the point is
 * that no test could have: a provenance claim discharged by a docstring is decoration.
 * `power-sizing.test.ts` now reads the committed JSON and compares field by field, so a
 * mis-transcription fails rather than merely being close.
 */
export const PRIOR_RUN_SIZING: readonly SizingInput[] = [
  {
    armId: "size-1024",
    subset: "all",
    n: 48,
    meanDelta: 0.02438682061959595,
    ciLow: -0.054139373336921315,
    ciHigh: 0.0994635894002905,
  },
  {
    armId: "size-768",
    subset: "all",
    n: 48,
    meanDelta: -0.017388842396661747,
    ciLow: -0.09924094031729443,
    ciHigh: 0.05991381345798421,
  },
  {
    armId: "size-3072",
    subset: "all",
    n: 48,
    meanDelta: 0.02127466440902646,
    ciLow: -0.029764573187889953,
    ciHigh: 0.08616404158420138,
  },
  {
    armId: "overlap-2048-0",
    subset: "all",
    n: 48,
    meanDelta: -0.00231357176191086,
    ciLow: -0.02163902089335805,
    ciHigh: 0.0194261923932358,
  },
  {
    armId: "overlap-2048-128",
    subset: "all",
    n: 48,
    meanDelta: 0.001087117638939341,
    ciLow: -0.017578957776266155,
    ciHigh: 0.022726922413888167,
  },
  {
    armId: "overlap-2048-512",
    subset: "all",
    n: 48,
    meanDelta: 0.0045520037172178335,
    ciLow: -0.025842545494570993,
    ciHigh: 0.03847967357341117,
  },
];

/** Half the width of a two-sided interval. */
export function halfWidthOf(ciLow: number, ciHigh: number): number {
  return (ciHigh - ciLow) / 2;
}

/**
 * The per-query sd implied by a measured half-width, inverting `hw = z·sd/√n`.
 *
 * Returns `null` where the inversion carries no information — fewer than two queries,
 * or a degenerate interval — rather than a zero a caller could mistake for "no spread".
 */
export function impliedSd(halfWidth: number, n: number): number | null {
  if (n < 2 || !(halfWidth > 0)) return null;
  return (halfWidth * Math.sqrt(n)) / Z_95;
}

/**
 * Present a committed interval as the {@link MeanWithCi} the shared sizing function
 * consumes.
 *
 * `zeroFraction` is 0 because the delta vector is not serialised and cannot be
 * recovered — it is unused by {@link queriesNeededForHalfWidth}, and is left at the
 * value that claims nothing. `resamples` likewise carries the artefact's default.
 */
export function asMeanWithCi(input: SizingInput): MeanWithCi {
  const halfWidth = halfWidthOf(input.ciLow, input.ciHigh);
  return {
    mean: input.meanDelta,
    ciLow: input.ciLow,
    ciHigh: input.ciHigh,
    halfWidth,
    sd: impliedSd(halfWidth, input.n) ?? 0,
    n: input.n,
    confidence: 0.95,
    resamples: 20000,
    zeroFraction: 0,
  };
}

/** One row of the sizing table: what was measured, and what each target would cost. */
export interface SizingRow extends SizingInput {
  halfWidth: number;
  sd: number | null;
  /** Queries needed per {@link SIZING_TARGETS} entry, in that order. */
  needed: (number | null)[];
}

/** Size one committed interval against every target. */
export function sizeArm(
  input: SizingInput,
  targets: readonly number[] = SIZING_TARGETS,
): SizingRow {
  const stats = asMeanWithCi(input);
  return {
    ...input,
    halfWidth: stats.halfWidth,
    sd: impliedSd(stats.halfWidth, input.n),
    needed: targets.map((t) => queriesNeededForHalfWidth(stats, t)),
  };
}

/** The go/no-go, computed from the sizing rather than asserted beside it. */
export interface CorpusDecision {
  /** The target the decision is taken at — the pre-registered floor. */
  target: number;
  /** The most demanding arm's requirement at that target. */
  queriesNeeded: number | null;
  /** The arm that set it. */
  bindingArmId: string | null;
  ceiling: number;
  go: boolean;
  /** Targets that are out of reach at the ceiling, with what they would cost. */
  outOfReach: { target: number; queriesNeeded: number }[];
}

/**
 * Decide whether the corpus is worth expanding, at the DECISION floor.
 *
 * The binding constraint is the WORST arm, not the mean of the arms: a corpus sized for
 * the average arm still cannot resolve the widest one, and the widest one is as likely
 * to be the arm that matters. An arm whose interval yields no sizing (`null`) cannot
 * bind, and is skipped rather than treated as free.
 */
export function corpusGoNoGo(
  rows: readonly SizingRow[],
  opts: { target?: number; ceiling?: number; targets?: readonly number[] } = {},
): CorpusDecision {
  const target = opts.target ?? MIN_IMPORTANT_DELTA;
  const ceiling = opts.ceiling ?? PRACTICAL_QUERY_CEILING;
  const targets = opts.targets ?? SIZING_TARGETS;
  const idx = targets.indexOf(target);

  let queriesNeeded: number | null = null;
  let bindingArmId: string | null = null;
  for (const row of rows) {
    const needed = idx === -1 ? null : (row.needed[idx] ?? null);
    if (needed === null) continue;
    if (queriesNeeded === null || needed > queriesNeeded) {
      queriesNeeded = needed;
      bindingArmId = row.armId;
    }
  }

  const outOfReach: { target: number; queriesNeeded: number }[] = [];
  targets.forEach((t, i) => {
    let worst: number | null = null;
    for (const row of rows) {
      const needed = row.needed[i] ?? null;
      if (needed !== null && (worst === null || needed > worst)) worst = needed;
    }
    if (worst !== null && worst > ceiling) outOfReach.push({ target: t, queriesNeeded: worst });
  });

  return {
    target,
    queriesNeeded,
    bindingArmId,
    ceiling,
    go: queriesNeeded !== null && queriesNeeded <= ceiling,
    outOfReach,
  };
}

const f3 = (n: number): string => n.toFixed(3);
const f4 = (n: number): string => n.toFixed(4);

/**
 * Render the sizing table and the decision it produced.
 *
 * `currentQueryCount` is the corpus the intervals were measured on, so a reader can see
 * the multiplier being asked for rather than only the absolute count.
 */
export function renderCorpusSizing(
  inputs: readonly SizingInput[],
  opts: {
    heading: string;
    preamble: string;
    currentQueryCount: number;
    targets?: readonly number[];
    ceiling?: number;
  },
): string {
  const targets = opts.targets ?? SIZING_TARGETS;
  const rows = inputs.map((i) => sizeArm(i, targets));
  const decision = corpusGoNoGo(rows, { ceiling: opts.ceiling, targets });

  const lines: string[] = [];
  lines.push(`## ${opts.heading}`);
  lines.push("");
  lines.push(opts.preamble);
  lines.push("");
  lines.push(
    `| arm | subset | n | Δ mean | measured ±hw | implied sd | ${targets
      .map((t) => `n for ±${f3(t)}`)
      .join(" | ")} |`,
  );
  lines.push(`|---|---|---:|---:|---:|---:|${targets.map(() => "---:").join("|")}|`);
  for (const row of rows) {
    lines.push(
      `| \`${row.armId}\` | ${row.subset} | ${row.n} | ` +
        `${row.meanDelta >= 0 ? "+" : ""}${f3(row.meanDelta)} | ±${f4(row.halfWidth)} | ` +
        `${row.sd === null ? "—" : f3(row.sd)} | ` +
        `${row.needed.map((n) => (n === null ? "—" : String(n))).join(" | ")} |`,
    );
  }
  lines.push("");
  lines.push(
    decision.queriesNeeded === null
      ? "> No arm carries a usable spread, so no query count can be estimated from this run."
      : `> **At the pre-registered floor (±${f3(decision.target)}) the binding arm is ` +
          `\`${decision.bindingArmId}\` at about ${decision.queriesNeeded} queries**, against ` +
          `${opts.currentQueryCount} measured here ` +
          `(${(decision.queriesNeeded / opts.currentQueryCount).toFixed(1)}×). The ` +
          `pre-registered practical ceiling is ${decision.ceiling} hand-authored queries, so ` +
          `this is a **${decision.go ? "GO" : "NO-GO"}**.` +
          (decision.outOfReach.length > 0
            ? ` Out of reach at that ceiling: ${decision.outOfReach
                .map((o) => `±${f3(o.target)} (needs ~${o.queriesNeeded})`)
                .join(", ")} — a result inside those bands stays **unproven below the floor**, ` +
              `which is not the same claim as "no effect".`
            : ""),
  );
  lines.push("");
  return lines.join("\n");
}
