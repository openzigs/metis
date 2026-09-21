/**
 * Issue #1016 — configuration identity, multi-run spread, and the harness default.
 *
 * The defect this guards: a number produced with the #936 table-relevance filter OFF
 * was quoted as the production baseline, because nothing in the harness said which
 * configuration it described and the default was the non-shipped one.
 */
import { describe, expect, it } from "vitest";
import {
  checkThresholds,
  DEFAULT_IMPACT_RECALL_THRESHOLDS,
  describeConfiguration,
  PRODUCTION_IMPACT_RECALL_THRESHOLDS,
  runImpactRecallEval,
  runImpactRecallEvalRepeated,
  summarizeRuns,
  parseRunCount,
  parseTableFilterEnabled,
  thresholdsFor,
  thresholdsForCorpus,
  toJsonReport,
  toMarkdownReport,
  type RunImpactRecallOptions,
} from "../src/lib/eval/impact-recall/runner.js";
import { buildSyntheticFixture } from "../src/lib/eval/impact-recall/fixture.js";

/** A deterministic stand-in for the #936 filter: keeps only the first table. */
const keepFirstTable: RunImpactRecallOptions["tableRelevanceFilter"] = async (_text, tables) => ({
  primary: tables.slice(0, 1),
  secondary: tables.slice(1),
  decisions: [],
});

describe("describeConfiguration", () => {
  it("names the PRODUCTION configuration when bm25 seeds and the filter runs", () => {
    const cfg = describeConfiguration({ tableRelevanceFilter: keepFirstTable });
    expect(cfg).toMatchObject({
      searcher: "bm25",
      tableFilter: "llm",
      isProductionConfiguration: true,
    });
    expect(cfg.label).toContain("PRODUCTION");
    expect(cfg.label).toContain("IMPACT_LLM_TABLE_FILTER=1");
  });

  it("labels a filter-OFF run as NON-PRODUCTION and says so in words", () => {
    const cfg = describeConfiguration({});
    expect(cfg.tableFilter).toBe("off");
    expect(cfg.isProductionConfiguration).toBe(false);
    expect(cfg.label).toContain("NOT the shipped baseline");
  });

  it("treats a non-default searcher as non-production even with the filter on", () => {
    const cfg = describeConfiguration({
      searcherKind: "entity-union",
      tableRelevanceFilter: keepFirstTable,
    });
    expect(cfg.isProductionConfiguration).toBe(false);
    expect(cfg.label).toContain("entity-union");
  });
});

describe("thresholdsFor — production numbers are never gated by the unfiltered floors", () => {
  it("returns the production floors only for the production configuration", () => {
    const production = describeConfiguration({ tableRelevanceFilter: keepFirstTable });
    const deterministic = describeConfiguration({});
    expect(thresholdsFor("impact-recall-01-jpetstore", production)).toBe(
      PRODUCTION_IMPACT_RECALL_THRESHOLDS,
    );
    expect(thresholdsFor("impact-recall-01-jpetstore", deterministic)).toBe(
      DEFAULT_IMPACT_RECALL_THRESHOLDS,
    );
  });

  it("records a production tablePrecision floor far above the unfiltered one", () => {
    // The recorded production baseline is ~0.78; the unfiltered diagnostic is ~0.46.
    // A single shared floor is what made a 0.40 gate look reasonable.
    expect(PRODUCTION_IMPACT_RECALL_THRESHOLDS.tablePrecision).toBeGreaterThan(
      DEFAULT_IMPACT_RECALL_THRESHOLDS.tablePrecision,
    );
    expect(PRODUCTION_IMPACT_RECALL_THRESHOLDS.tablePrecision).toBe(0.65);
  });

  it("falls back to the deterministic floors for a corpus with no measured production baseline", () => {
    const production = describeConfiguration({ tableRelevanceFilter: keepFirstTable });
    expect(thresholdsFor("impact-recall-02-shared-db", production)).toBe(
      thresholdsForCorpus("impact-recall-02-shared-db"),
    );
  });
});

describe("multi-run measurement", () => {
  it("summarizes repeated runs into a mean aggregate plus per-metric spread", async () => {
    const fx = buildSyntheticFixture();
    const summary = await runImpactRecallEvalRepeated(fx, {}, 3);

    expect(summary.runCount).toBe(3);
    expect(summary.runs).toHaveLength(3);
    // The deterministic path repeats exactly, so the spread collapses to a point.
    const tp = summary.spreads.tablePrecision!;
    expect(tp.values).toHaveLength(3);
    expect(tp.min).toBe(tp.max);
    expect(tp.mean).toBeCloseTo(summary.meanAggregate.tables.macroPrecision, 10);
    expect(summary.spreads.codeRecall).toBeDefined();
  });

  it("averages a genuinely varying metric rather than taking one sample", () => {
    const fx = buildSyntheticFixture();
    const base = {
      fixtureId: fx.manifest.id,
      searcherKind: "bm25" as const,
      configuration: describeConfiguration({}),
      scores: [],
      matchQualities: {},
    };
    const mk = (precision: number, recall: number) => ({
      ...base,
      aggregate: {
        requirementCount: 1,
        tables: {
          labeledCount: 1,
          macroRecall: recall,
          macroPrecision: precision,
          microRecall: recall,
          microPrecision: precision,
          hitRate: 1,
        },
        code: null,
      },
      scores: [
        {
          id: "R1",
          text: "t",
          tables: {
            expected: ["a"],
            found: ["a", "b"],
            hit: ["a"],
            wrong: ["b"],
            miss: [],
            recall,
            precision,
          },
          code: null,
          consumers: null,
        },
      ],
    });
    const summary = summarizeRuns([mk(0.6, 1), mk(0.8, 1), mk(1.0, 1)]);
    expect(summary.meanAggregate.tables.macroPrecision).toBeCloseTo(0.8, 10);
    expect(summary.spreads.tablePrecision!.min).toBe(0.6);
    expect(summary.spreads.tablePrecision!.max).toBe(1);
    // ABSOLUTE surfaced-table counts are reported per run alongside the ratio.
    expect(summary.surfacedTableCounts.R1).toEqual([2, 2, 2]);
  });

  it("rejects an empty run list rather than inventing a mean", () => {
    expect(() => summarizeRuns([])).toThrow(/at least one run/);
  });

  it("clamps a nonsense run count to a single run", async () => {
    const summary = await runImpactRecallEvalRepeated(buildSyntheticFixture(), {}, 0);
    expect(summary.runCount).toBe(1);
  });
});

describe("reports name the configuration", () => {
  it("puts the configuration and run count in the JSON report", async () => {
    const fx = buildSyntheticFixture();
    const summary = await runImpactRecallEvalRepeated(fx, {}, 2);
    const json = toJsonReport(summary.runs[0], DEFAULT_IMPACT_RECALL_THRESHOLDS, summary) as {
      configuration: { isProductionConfiguration: boolean };
      runCount: number;
      spreads: Record<string, unknown>;
      surfacedTableCounts: Record<string, number[]>;
      perRunAggregates: unknown[];
    };
    expect(json.configuration.isProductionConfiguration).toBe(false);
    expect(json.runCount).toBe(2);
    expect(json.spreads.tablePrecision).toBeDefined();
    expect(json.surfacedTableCounts.S1).toHaveLength(2);
    expect(json.perRunAggregates).toHaveLength(2);
  });

  it("gates on the MEAN of repeated runs, not the first sample", async () => {
    const fx = buildSyntheticFixture();
    const summary = await runImpactRecallEvalRepeated(fx, {}, 2);
    const gated = checkThresholds(summary.meanAggregate, DEFAULT_IMPACT_RECALL_THRESHOLDS);
    const json = toJsonReport(summary.runs[0], DEFAULT_IMPACT_RECALL_THRESHOLDS, summary) as {
      passed: boolean;
    };
    expect(json.passed).toBe(gated.passed);
  });

  it("warns loudly in Markdown when the run is NOT the shipped configuration", async () => {
    const fx = buildSyntheticFixture();
    const summary = await runImpactRecallEvalRepeated(fx, {}, 2);
    const md = toMarkdownReport(summary.runs[0], DEFAULT_IMPACT_RECALL_THRESHOLDS, summary);
    expect(md).toContain("## Configuration — NON-PRODUCTION");
    expect(md).toContain("do NOT describe the shipped configuration");
    expect(md).toContain("## Spread across runs");
    expect(md).toContain("Tbl found (n)");
  });

  it("omits the warning when the configuration IS production", async () => {
    const fx = buildSyntheticFixture();
    const summary = await runImpactRecallEvalRepeated(
      fx,
      { tableRelevanceFilter: keepFirstTable },
      1,
    );
    const md = toMarkdownReport(summary.runs[0], PRODUCTION_IMPACT_RECALL_THRESHOLDS, summary);
    expect(md).toContain("## Configuration — PRODUCTION");
    expect(md).not.toContain("do NOT describe the shipped configuration");
    // A single run reports no spread table (nothing to spread).
    expect(md).not.toContain("## Spread across runs");
  });

  it("carries the configuration on a plain single run too", async () => {
    const result = await runImpactRecallEval(buildSyntheticFixture(), {});
    expect(result.configuration.isProductionConfiguration).toBe(false);
    const json = toJsonReport(result) as { runCount: number; configuration: unknown };
    expect(json.runCount).toBe(1);
    expect(json.configuration).toBeDefined();
  });
});

describe("CLI flag defaults — the production configuration is what you get", () => {
  it("enables the #936 table filter unless --no-filter is passed", () => {
    expect(parseTableFilterEnabled([])).toBe(true);
    expect(parseTableFilterEnabled(["--md"])).toBe(true);
    expect(parseTableFilterEnabled(["--no-filter"])).toBe(false);
  });

  it("defaults to 3 runs when the (non-deterministic) filter is on, 1 when it is off", () => {
    expect(parseRunCount([], true)).toBe(3);
    expect(parseRunCount([], false)).toBe(1);
  });

  it("honours an explicit --runs and ignores a nonsense one", () => {
    expect(parseRunCount(["--runs", "5"], true)).toBe(5);
    expect(parseRunCount(["--runs", "0"], true)).toBe(3);
    expect(parseRunCount(["--runs", "abc"], false)).toBe(1);
    expect(parseRunCount(["--runs"], false)).toBe(1);
  });
});
