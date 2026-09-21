/**
 * #1157 — the error-bar renderer.
 *
 * The assertions here are about the CLAIMS the artifact makes, not about its
 * prose. A results file that prints a ±0.07 interval while saying the corpus
 * resolves ±0.03 effects is worse than one with no interval at all, because it
 * launders the imprecision through a sentence a reader will believe. So the
 * MET / NOT MET line is tested against the measured half-width in both
 * directions, and the recommendation is tested for carrying a query count.
 */
import { describe, expect, it } from "vitest";
import {
  FLOOR_EFFECT_ZERO_FRACTION,
  formatMeanWithCi,
  renderIntervalSection,
  renderStrataSection,
  TARGET_HALF_WIDTH,
} from "./interval-report.js";
import type { StratumMetrics } from "./metrics.js";
import { bootstrapMean } from "./stats.js";

/** A sample with a KNOWN, wide spread: alternating 0/1 over `n` queries. */
const noisy = (n: number): number[] => Array.from({ length: n }, (_, i) => i % 2);

/** A sample with a known, tiny spread. */
const tight = (n: number): number[] => Array.from({ length: n }, (_, i) => 0.5 + (i % 2) * 0.001);

describe("formatMeanWithCi", () => {
  it("carries the point estimate, the interval, the half-width and n", () => {
    const line = formatMeanWithCi(bootstrapMean([0, 1, 0, 1]));
    expect(line).toMatch(/^0\.500 \(95% CI \[[\d.]+, [\d.]+\], ±[\d.]+, n=4\)$/);
  });

  it("reports n=0 rather than pretending an empty sample has a score", () => {
    expect(formatMeanWithCi(bootstrapMean([]))).toContain("n=0");
  });
});

describe("renderIntervalSection", () => {
  it("prints the point estimate, the interval and the half-width in one table row", () => {
    const md = renderIntervalSection({
      metricLabel: "hybrid nDCG@10",
      stats: bootstrapMean([0, 1, 0, 1, 0, 1]),
    });
    expect(md).toContain("| hybrid nDCG@10 | 0.500 |");
    expect(md).toMatch(/\*\*±\d\.\d{4}\*\*/);
  });

  // NOTE for anyone editing these: "NOT MET" CONTAINS "MET", so a bare
  // `toContain("MET")` passes on both verdicts and asserts nothing. Every
  // MET-side assertion below therefore also asserts `not.toContain("NOT MET")`.
  it("says NOT MET, and names a query count, when the interval is wider than the bar", () => {
    const stats = bootstrapMean(noisy(20));
    expect(stats.halfWidth).toBeGreaterThan(TARGET_HALF_WIDTH);
    const md = renderIntervalSection({ metricLabel: "m", stats });
    expect(md).toContain("bar: NOT MET");
    expect(md).toMatch(/needs about \*\*\d+ queries\*\*/);
    expect(md).toContain("the corpus has **20**");
  });

  it("says MET when the interval is inside the bar", () => {
    const stats = bootstrapMean(tight(40));
    expect(stats.halfWidth).toBeLessThanOrEqual(TARGET_HALF_WIDTH);
    const md = renderIntervalSection({ metricLabel: "m", stats });
    expect(md).toContain("bar: MET");
    expect(md).not.toContain("NOT MET");
  });

  // Falsifiable both ways: the SAME sample flips verdict on the target alone, so
  // dropping `input.targetHalfWidth ?? …` turns this red.
  it("honours an explicit target half-width", () => {
    const stats = bootstrapMean(noisy(20));
    const wide = renderIntervalSection({ metricLabel: "m", stats, targetHalfWidth: 0.9 });
    expect(wide).toContain("bar: MET");
    expect(wide).not.toContain("NOT MET");
    expect(wide).toContain("±0.900 bar");

    const strict = renderIntervalSection({ metricLabel: "m", stats, targetHalfWidth: 0.001 });
    expect(strict).toContain("bar: NOT MET");
  });

  it("says so plainly when a sample has no spread to size against", () => {
    const md = renderIntervalSection({ metricLabel: "m", stats: bootstrapMean([0.5, 0.5]) });
    expect(md).toContain("no usable spread");
  });

  // The absolute interval is the WIDER of the two. Quoting it as the smallest
  // detectable improvement would understate the corpus — the opposite failure to
  // the one #1157 exists to fix, and just as wrong.
  it("warns that a sub-issue is decided on the PAIRED interval, not this one", () => {
    const md = renderIntervalSection({ metricLabel: "m", stats: bootstrapMean(noisy(10)) });
    expect(md).toContain("PAIRED interval");
    expect(md).toContain("compareArms");
  });

  /**
   * The paired interval is the right instrument, but "it collapses because the arms
   * agree" is unsupported: the only paired spread this repo has measured is sd 0.301
   * against an absolute 0.337 — 11%, not a collapse (PR #1174 review). The artifact
   * has to carry the measured figure, or the recommendation reads as a solved
   * precision problem.
   */
  it("states the MEASURED paired narrowing rather than implying a collapse", () => {
    const md = renderIntervalSection({ metricLabel: "m", stats: bootstrapMean(noisy(10)) });
    expect(md).toContain("0.301");
    expect(md).toContain("0.337");
    expect(md).toContain("11% narrowing");
    expect(md).toMatch(/HYPOTHESIS with no support/);
  });

  /**
   * #1156's revert rule asks whether a change is WORTH its cost, which "the CI
   * excludes zero" cannot answer. The three-way classification and the sign test have
   * to travel into the artifact, not just into an issue comment.
   */
  it("gives a magnitude rule, not just a direction test", () => {
    const md = renderIntervalSection({ metricLabel: "m", stats: bootstrapMean(noisy(10)) });
    expect(md).toContain("DIRECTION test");
    expect(md).toContain("MAGNITUDE test");
    expect(md).toContain("PRE-REGISTER");
    expect(md).toContain("sign test");
    expect(md).toContain("NON-ZERO deltas");
    // Whitespace-tolerant: the renderer hard-wraps, so a verdict can straddle a line.
    for (const verdict of [
      /\bSHIP\b/,
      /DIRECTION\s+ESTABLISHED, MAGNITUDE NOT/,
      /NOT ESTABLISHED/,
    ]) {
      expect(md).toMatch(verdict);
    }
  });

  it("states the resample count so the interval is reproducible from the artifact", () => {
    const md = renderIntervalSection({
      metricLabel: "m",
      stats: bootstrapMean(noisy(10), { resamples: 1234 }),
    });
    expect(md).toContain("1234 resamples");
  });
});

describe("renderStrataSection", () => {
  const row = (key: string, value: string, queryCount: number): StratumMetrics => ({
    key,
    value,
    queryCount,
    ndcgAt10: 0.5,
    mrr: 0.4,
    perQueryNdcgAt10: [],
  });

  it("gives every stratum its own row WITH its denominator", () => {
    const md = renderStrataSection([row("naming", "snake", 23), row("naming", "camel", 104)]);
    expect(md).toContain("| `naming` | `snake` | 23 | 0.500 | 0.400 |");
    expect(md).toContain("| `naming` | `camel` | 104 | 0.500 | 0.400 |");
  });

  it("names the sub-issues each stratum exists to make measurable", () => {
    const md = renderStrataSection([row("naming", "snake", 23)]);
    expect(md).toContain("#1159");
    expect(md).toContain("#1158");
  });

  it("says the corpus declares none rather than rendering an empty table", () => {
    const md = renderStrataSection([]);
    expect(md).toContain("declares no strata");
    expect(md).not.toContain("| Stratum |");
  });
});

describe("renderIntervalSection — floor effect", () => {
  /** 80% exact zeros: a narrow interval that is compression, not precision. */
  const floored = (n: number): number[] =>
    Array.from({ length: n }, (_, i) => (i % 5 === 0 ? 0.4 : 0));

  it("qualifies a MET verdict as a FLOOR EFFECT when most values are exactly zero", () => {
    const stats = bootstrapMean(floored(120));
    expect(stats.zeroFraction).toBeGreaterThanOrEqual(FLOOR_EFFECT_ZERO_FRACTION);
    expect(stats.halfWidth).toBeLessThanOrEqual(TARGET_HALF_WIDTH);

    const md = renderIntervalSection({ metricLabel: "m", stats });
    expect(md).toContain("bar: MET");
    expect(md).not.toContain("NOT MET");
    expect(md).toContain("FLOOR EFFECT, not as precision");
    expect(md).toContain("80% of the per-query values are exactly 0.000");
    expect(md).toContain("Do not cite this row as evidence");
  });

  it("calls the query count an UNDER-estimate on a floored sample that misses the bar", () => {
    const stats = bootstrapMean(floored(12));
    expect(stats.halfWidth).toBeGreaterThan(TARGET_HALF_WIDTH);
    const md = renderIntervalSection({ metricLabel: "m", stats });
    expect(md).toContain("bar: NOT MET");
    expect(md).toContain("UNDER-estimate");
    expect(md).not.toContain("FLOOR EFFECT, not as precision");
  });

  it("adds no floor warning when the values are spread across the range", () => {
    const spread = Array.from({ length: 120 }, (_, i) => (i % 5) / 4);
    const stats = bootstrapMean(spread);
    expect(stats.zeroFraction).toBeLessThan(FLOOR_EFFECT_ZERO_FRACTION);
    const md = renderIntervalSection({ metricLabel: "m", stats });
    expect(md).not.toContain("FLOOR EFFECT");
    expect(md).not.toContain("UNDER-estimate");
  });
});

describe("bootstrapMean zeroFraction", () => {
  it("counts only EXACT zeros", () => {
    expect(bootstrapMean([0, 0, 0.0001, 1]).zeroFraction).toBeCloseTo(0.5, 12);
    expect(bootstrapMean([0.1, 0.2]).zeroFraction).toBe(0);
    expect(bootstrapMean([]).zeroFraction).toBe(0);
  });
});
