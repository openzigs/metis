/**
 * #2189 — the BRD cost estimate checked against measured runs.
 *
 * Each run below is a real full-project business-requirements generation: its
 * plan (the modules' indexed source lines, grouped by the generator's own rules
 * from the project's symbols, and whether their Phase-1 facts were already
 * cached), the models it called, and what it cost as the usage ledger recorded
 * it (`token_usages`, agentStep `docs-gen`, summed over the run's window; the
 * id is the generated document's). The estimate's range must hold every run,
 * and the point estimate's error on each is pinned in {@link EXPECTED_ERROR_PCT}
 * — the table the PR for #2189 records.
 *
 * Every completed full-project BRD in the measurement database with a recorded
 * cost is here but one: `cmvi0k9p` ($0.627) is left out because its
 * repository's source was unavailable (three `source-unavailable` warnings), so
 * Phase 1 read no code — not the plan the estimate describes. `cmutydzt`
 * recorded no cost. The constants were fitted to these same runs, so the errors
 * are in-sample; the range is wider than the worst of them for that reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

import {
  RANGE_HIGH_FACTOR,
  RANGE_LOW_FACTOR,
  estimateFromPlan,
  pointEstimateUsd,
  type CostModels,
  type CostPlan,
} from "./cost-estimate.js";

/** #1749: three tiny fixture repositories (10 modules, 202 indexed lines). */
const FIXTURE_1749_LINES = [24, 26, 15, 29, 34, 29, 21, 10, 4, 10];

/** Miniflux v2.3.3 (#706): 102 modules, 82,415 indexed lines. */
const MINIFLUX_LINES = [
  3380, 5665, 2970, 6097, 2790, 1309, 3225, 2614, 3382, 1044, 2762, 1773, 2110, 1555, 1591, 2074,
  1479, 1480, 1317, 1167, 476, 1328, 1654, 2695, 1701, 959, 1044, 1152, 558, 1077, 1040, 878, 400,
  1116, 755, 838, 672, 395, 490, 302, 351, 560, 854, 354, 291, 360, 245, 240, 628, 352, 667, 310,
  137, 213, 173, 179, 500, 187, 165, 613, 434, 239, 177, 61, 421, 117, 95, 63, 118, 127, 94, 71,
  142, 141, 98, 56, 120, 76, 79, 51, 65, 782, 71, 68, 79, 52, 31, 373, 342, 74, 168, 50, 90, 83, 48,
  61, 58, 102, 222, 17, 94, 12,
];

/** The generator's defaults at the time of every run. */
const SETTINGS = {
  sections: 7,
  documentMaxChars: 250_000,
  factsCharCap: 150_000,
  phase1ChunkInputChars: 84_000,
};

const plan = (lines: readonly number[], cached: boolean): CostPlan => ({
  ...SETTINGS,
  modules: lines.map((n) => ({ lines: n, cached })),
});

const all = (model: string, claim = model): CostModels => {
  const m = { provider: "anthropic", model };
  return { phase1: m, phase2: m, judge: m, claim: { provider: "anthropic", model: claim } };
};

interface MeasuredRun {
  name: string;
  plan: CostPlan;
  models: CostModels;
  /** USD, as the usage ledger recorded it. */
  actualUsd: number;
}

const DEEPSEEK = all("deepseek-flash");

const RUNS: MeasuredRun[] = [
  {
    name: "cmw1gqrk — #1749 fixture BRD, first run, Sonnet 5.5 (Haiku 4.5 claims)",
    plan: plan(FIXTURE_1749_LINES, false),
    models: all("claude-sonnet-5-5", "claude-haiku-4-5"),
    actualUsd: 2.26,
  },
  {
    name: "cmv8rf6i — Miniflux, first run, Haiku 5.5",
    plan: plan(MINIFLUX_LINES, false),
    models: all("claude-haiku-5-5"),
    actualUsd: 1.976,
  },
  ...(
    [
      ["cmuzu30j", 1.908],
      ["cmv0waxw", 1.833],
      ["cmv1psiy", 1.809],
      ["cmv2qq9p", 1.844],
      ["cmv6r3wa", 1.777],
      ["cmva85qt", 2.005],
      ["cmvudg4x", 1.432],
    ] as const
  ).map(([id, actualUsd]) => ({
    name: `${id} — Miniflux, first run, DeepSeek Flash`,
    plan: plan(MINIFLUX_LINES, false),
    models: DEEPSEEK,
    actualUsd,
  })),
  ...(
    [
      ["cmvbh7hv", 0.799],
      ["cmvi2tl7", 1.097],
      ["cmvit2z8", 0.9],
      ["cmvjbjld", 0.968],
      ["cmvjn3uz", 0.837],
      ["cmvkwly7", 0.953],
      ["cmvmuk5z", 0.848],
    ] as const
  ).map(([id, actualUsd]) => ({
    name: `${id} — Miniflux, re-run with facts cached, DeepSeek Flash`,
    plan: plan(MINIFLUX_LINES, true),
    models: DEEPSEEK,
    actualUsd,
  })),
];

/**
 * The point estimate's error on each run, in percent of what it cost
 * ((estimate − actual) / actual, rounded). A change to the call model that
 * moves any of these must update this table, and the PR says why.
 */
const EXPECTED_ERROR_PCT: Record<string, number> = {
  cmw1gqrk: 17,
  cmv8rf6i: -8,
  cmuzu30j: -8,
  cmv0waxw: -4,
  cmv1psiy: -3,
  cmv2qq9p: -4,
  cmv6r3wa: -1,
  cmva85qt: -12,
  cmvudg4x: 23,
  cmvbh7hv: 30,
  cmvi2tl7: -5,
  cmvit2z8: 15,
  cmvjbjld: 7,
  cmvjn3uz: 24,
  cmvkwly7: 9,
  cmvmuk5z: 23,
};

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  // The price the DeepSeek runs were recorded at (USD per 1M tokens).
  vi.stubEnv(
    "MODEL_PRICES",
    JSON.stringify({
      "deepseek-flash": { inputPerMTok: 0.3, outputPerMTok: 1.2, cacheReadPerMTok: 0.006 },
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the BRD cost estimate against measured runs (#2189)", () => {
  it("covers at least three measured runs, the #1749 fixture run among them", () => {
    expect(RUNS.length).toBeGreaterThanOrEqual(3);
    expect(RUNS.some((r) => r.name.startsWith("cmw1gqrk"))).toBe(true);
    expect(Object.keys(EXPECTED_ERROR_PCT).sort()).toEqual(
      RUNS.map((r) => r.name.split(" ")[0]).sort(),
    );
  });

  it.each(RUNS)("$name: the range holds the measured $actualUsd", (run) => {
    const estimate = estimateFromPlan(run.plan, run.models);
    expect(estimate.status).toBe("priced");
    expect(estimate.lowUsd!).toBeLessThanOrEqual(run.actualUsd);
    expect(estimate.highUsd!).toBeGreaterThanOrEqual(run.actualUsd);
  });

  it.each(RUNS)("$name: the point estimate's error is as recorded", (run) => {
    const point = pointEstimateUsd(run.plan, run.models)!;
    const errorPct = Math.round(((point - run.actualUsd) / run.actualUsd) * 100);
    expect(errorPct).toBe(EXPECTED_ERROR_PCT[run.name.split(" ")[0]]);
  });

  it("is wider than the worst recorded error in both directions", () => {
    const errors = Object.values(EXPECTED_ERROR_PCT).map((e) => e / 100);
    // low = point × LOW ≤ actual ⇔ error ≤ 1/LOW − 1; high likewise.
    expect(Math.max(...errors)).toBeLessThan(1 / RANGE_LOW_FACTOR - 1);
    expect(Math.min(...errors)).toBeGreaterThan(1 / RANGE_HIGH_FACTOR - 1);
  });
});
