/**
 * Epic #1156 / Issue #1157 — the error bars, rendered.
 *
 * ## Why this module exists at all
 *
 * Every committed `eval-results/embed-retrieval-*.md` before #1157 reported a bare
 * point estimate for the headline metric. The epic that consumes those files
 * expects its four remaining sub-issues to move nDCG@10 by ±0.02–0.06 — so a
 * reader has to be able to tell a 0.03 move from the corpus breathing, and a bare
 * mean cannot tell them. This renders the interval next to the estimate, in the
 * artifact itself, so the question is settled where the number is quoted rather
 * than in a review comment three PRs later.
 *
 * ## Two intervals, deliberately both
 *
 * `renderIntervalSection` prints the ABSOLUTE interval (how precisely this corpus
 * pins one arm's score) and, right beside it, the query count that would be needed
 * to hit a target half-width at the spread just measured. The second number is the
 * one that makes "still too noisy" actionable instead of merely true.
 *
 * It also states, in the artifact, that a sub-issue's verdict rests on the PAIRED
 * interval from `stats.ts` rather than on this one — because the absolute interval
 * is the wider of the two and quoting it as the resolving power for a delta would
 * understate the corpus, which is the opposite failure to the one #1157 exists to
 * fix but is just as wrong.
 */
import type { StratumMetrics } from "./metrics.js";
import { queriesNeededForHalfWidth, type MeanWithCi } from "./stats.js";

/** Half-width #1157 pre-registered as "the corpus can resolve the epic's effects". */
export const TARGET_HALF_WIDTH = 0.03;

/**
 * Share of per-query values that must be exactly zero before a MET verdict is
 * treated as a FLOOR EFFECT rather than as precision.
 *
 * An arm that scores 0.000 on most of the corpus has almost no spread, so its
 * interval is narrow for a reason that has nothing to do with how well the corpus
 * resolves anything — the BM25-only channel on `embedretrieval-02` scores zero on
 * 88 of 127 queries and reports ±0.027, inside the ±0.03 bar, while the same
 * corpus scored with real vectors carries roughly twice that spread. Letting that
 * print an unqualified "MET" would be the mirror image of the defect #1157 exists
 * to fix: a comfortable number that a reader would reasonably believe.
 *
 * Two thirds is a judgement call and deliberately generous — the point is to catch
 * the case where the mean sits on the floor, not to litigate a boundary.
 */
export const FLOOR_EFFECT_ZERO_FRACTION = 2 / 3;

const f3 = (n: number): string => n.toFixed(3);
const f4 = (n: number): string => n.toFixed(4);

/**
 * One line summarising a mean and its interval, e.g.
 * `0.474 (95% CI [0.402, 0.546], ±0.072, n=90)`. Used in logs and table cells.
 */
export function formatMeanWithCi(stats: MeanWithCi): string {
  return (
    `${f3(stats.mean)} (${(stats.confidence * 100).toFixed(0)}% CI ` +
    `[${f3(stats.ciLow)}, ${f3(stats.ciHigh)}], ±${f4(stats.halfWidth)}, n=${stats.n})`
  );
}

export interface IntervalSectionInput {
  /** What the interval is around, e.g. "hybrid channel nDCG@10". */
  metricLabel: string;
  stats: MeanWithCi;
  /** Target half-width to size against; defaults to #1157's 0.03. */
  targetHalfWidth?: number;
}

/**
 * The bootstrap-CI section of a results file.
 *
 * The verdict line is computed from the measured half-width rather than written by
 * hand, so an artifact cannot claim the corpus is precise enough while printing an
 * interval that says otherwise.
 */
export function renderIntervalSection(input: IntervalSectionInput): string {
  const { metricLabel, stats } = input;
  const target = input.targetHalfWidth ?? TARGET_HALF_WIDTH;
  const needed = queriesNeededForHalfWidth(stats, target);
  const meets = stats.halfWidth <= target;
  const floored = stats.zeroFraction >= FLOOR_EFFECT_ZERO_FRACTION;

  const sizing =
    needed === null
      ? "The sample has no usable spread, so no query count can be estimated from it."
      : meets
        ? `At this spread, ${needed} queries would be needed for a ±${f3(target)} half-width — ` +
          `the corpus has ${stats.n}, so the bar is met.`
        : `At this spread (sd ${f3(stats.sd)}), a ±${f3(target)} half-width needs about ` +
          `**${needed} queries**; the corpus has **${stats.n}**. Raise the target before ` +
          `any sub-issue is judged on an absolute delta of that size.`;

  // A narrow interval on a floored sample is compression, not precision. Say so
  // where the number is quoted, or it will be quoted without this.
  const floorWarning =
    floored && meets
      ? `\n\n> **Read the MET above as a FLOOR EFFECT, not as precision.** ` +
        `${(stats.zeroFraction * 100).toFixed(0)}% of the per-query values are exactly 0.000, so ` +
        `the sample has almost no spread and the interval is compressed for a reason that has ` +
        `nothing to do with how well this corpus resolves a change. An arm that actually scores ` +
        `across the range will carry a materially wider interval on the SAME queries. Do not ` +
        `cite this row as evidence that the ±${f3(target)} bar is met for the corpus.`
      : floored
        ? `\n\n> Note: ${(stats.zeroFraction * 100).toFixed(0)}% of the per-query values are ` +
          `exactly 0.000, so the spread above is a floor-compressed one and the query count is ` +
          `an UNDER-estimate.`
        : "";

  return `## Bootstrap 95% CI on ${metricLabel} (#1157)

Percentile bootstrap over the ${stats.n} PER-QUERY values, ${stats.resamples} resamples with a
fixed seed, so the interval in a committed artifact is reproducible byte-for-byte.

| Metric | Point estimate | 95% CI | Half-width | sd (per-query) | n |
|---|---|---|---|---|---|
| ${metricLabel} | ${f3(stats.mean)} | [${f3(stats.ciLow)}, ${f3(stats.ciHigh)}] | **±${f4(
    stats.halfWidth,
  )}** | ${f3(stats.sd)} | ${stats.n} |

**Half-width vs the ±${f3(target)} bar: ${meets ? "MET" : "NOT MET"}.** ${sizing}${floorWarning}

This is the interval around ONE ABSOLUTE SCORE. A sub-issue that changes retrieval is
decided on the PAIRED interval (\`compareArms\` in \`stats.ts\`), computed over per-query
DELTAS. Do not quote the number above as the smallest detectable improvement; it is the
precision of the level, not of the change.

**Do not over-claim the paired interval either.** The only paired spread this repo has
measured is \`eval-results/embed-retrieval-2026-07-13T07-41-49-054Z.json\`: sd **0.301**
on the A-vs-B per-query deltas against an absolute sd of **0.337** — an **11% narrowing**
(±0.052 rather than ±0.059 at n=127), not a collapse. Across all ten arm pairs in that
file the paired sd runs 0.271–0.340, so "a surgical change leaves most queries at delta
zero, therefore the interval collapses" is a HYPOTHESIS with no support in the only data
this repo has. Measure the paired sd for the comparison at hand before relying on it.

**"Excludes zero" is a DIRECTION test; #1156's revert rule needs a MAGNITUDE test.** At
±0.052 a measured +0.03 gives roughly [−0.02, +0.08] (undecided) and +0.06 gives
[+0.01, +0.11] — direction real, magnitude anywhere from "not worth the cost" to "large
win". So across most of the ±0.02–0.06 band the epic expects, "does the CI exclude zero?"
returns UNDECIDED. Decide a sub-issue this way instead:

1. PRE-REGISTER a minimum practically-important delta, before measuring.
2. Report the paired CI **and** the exact sign test **and** the count of NON-ZERO deltas.
   When a change leaves most queries at exactly zero the bootstrap resamples a very
   sparse vector and its tail coverage degrades — in the file above only 15–21 of 30
   deltas are non-zero. \`stats.ts\`'s own header says to believe the SIGN TEST when the
   two disagree.
3. Classify explicitly: CI excludes zero AND its lower bound clears the pre-registered
   floor → **SHIP**. CI excludes zero but the lower bound is below it → **DIRECTION
   ESTABLISHED, MAGNITUDE NOT**. CI straddles zero → **NOT ESTABLISHED** at this n.`;
}

/**
 * The per-stratum table.
 *
 * `queryCount` is a column, not a footnote. A stratum reported without its
 * denominator is how a four-query slice gets quoted as a finding, and the strata
 * here exist precisely so a change concentrated in one of them (snake_case lexical
 * matching, #1159) is visible instead of being diluted into the aggregate.
 */
export function renderStrataSection(strata: readonly StratumMetrics[]): string {
  if (strata.length === 0) {
    return `## Per-stratum results

The corpus declares no strata, so there is nothing to slice. (\`${"embedretrieval-01"}\`
predates them; see \`corpus.ts\`.)`;
  }

  const rows = strata
    .map(
      (s) =>
        `| \`${s.key}\` | \`${s.value}\` | ${s.queryCount} | ${f3(s.ndcgAt10)} | ${f3(s.mrr)} |`,
    )
    .join("\n");

  return `## Per-stratum results (#1157)

| Stratum | Value | Queries | nDCG@10 | MRR |
|---|---|---|---|---|
${rows}

A stratum's number is worth exactly what its \`Queries\` column says it is. These rows are
the reason the epic's later sub-issues are measurable at all: \`naming: snake\` is where
#1159's lexical change lands, and \`keywordFree: true\` is the slice BM25 cannot answer at
any depth, so it is where a cross-encoder (#1158) has to earn its latency.`;
}
