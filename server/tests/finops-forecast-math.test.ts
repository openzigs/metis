/**
 * Unit tests for the FinOps forecast math (Epic #47 / Issue #48).
 *
 * Covers the OLS regression, EWMA, blended run-rate, month-end projection,
 * and — most importantly — a walk-forward backtest proving MAPE ≤ 15% on
 * realistic synthetic usage (linear growth + bounded noise).
 */
import { describe, expect, it } from "vitest";
import {
  ewma,
  forecastDailyRunRate,
  linearRegression,
  mape,
  predictAt,
  projectMonthEnd,
  type DailyCostPoint,
} from "../src/lib/finops/forecast-math.js";

describe("linearRegression", () => {
  it("recovers a perfect linear trend", () => {
    // y = 10 + 5x
    const values = Array.from({ length: 10 }, (_, i) => 10 + 5 * i);
    const { intercept, slope } = linearRegression(values);
    expect(slope).toBeCloseTo(5, 6);
    expect(intercept).toBeCloseTo(10, 6);
  });

  it("returns the value as a flat line for a single point", () => {
    expect(linearRegression([42])).toEqual({ intercept: 42, slope: 0 });
  });

  it("returns zeros for an empty series", () => {
    expect(linearRegression([])).toEqual({ intercept: 0, slope: 0 });
  });

  it("predictAt extrapolates the line", () => {
    const ols = linearRegression([0, 2, 4, 6]);
    expect(predictAt(ols, 4)).toBeCloseTo(8, 6);
  });
});

describe("ewma", () => {
  it("equals the value for a constant series", () => {
    expect(ewma([100, 100, 100, 100], 0.3)).toBeCloseTo(100, 6);
  });

  it("weights recent observations more heavily", () => {
    // After a step up, EWMA trends toward the new level.
    const level = ewma([10, 10, 10, 100], 0.5);
    expect(level).toBeGreaterThan(10);
    expect(level).toBeLessThan(100);
  });

  it("returns 0 for an empty series", () => {
    expect(ewma([], 0.3)).toBe(0);
  });

  it("clamps a non-finite alpha to a sane default", () => {
    expect(ewma([5, 5, 5], Number.NaN)).toBeCloseTo(5, 6);
  });
});

describe("forecastDailyRunRate", () => {
  it("forecasts the run-rate of a flat series at its level", () => {
    const points: DailyCostPoint[] = Array.from({ length: 30 }, (_, i) => ({
      day: `2026-06-${String(i + 1).padStart(2, "0")}`,
      costCents: 500,
    }));
    const r = forecastDailyRunRate({ points });
    expect(r.dailyRunRateCents).toBeCloseTo(500, 0);
    expect(r.sampleDays).toBe(30);
  });

  it("never returns a negative run-rate on a steep decline", () => {
    const points: DailyCostPoint[] = Array.from({ length: 10 }, (_, i) => ({
      day: `2026-06-${String(i + 1).padStart(2, "0")}`,
      costCents: Math.max(0, 1000 - i * 200),
    }));
    const r = forecastDailyRunRate({ points });
    expect(r.dailyRunRateCents).toBeGreaterThanOrEqual(0);
  });

  it("returns zeros for an empty window", () => {
    expect(forecastDailyRunRate({ points: [] })).toEqual({
      dailyRunRateCents: 0,
      slopeCentsPerDay: 0,
      ewmaCents: 0,
      sampleDays: 0,
    });
  });
});

describe("projectMonthEnd", () => {
  it("adds run-rate * remaining days to MTD", () => {
    const points: DailyCostPoint[] = Array.from({ length: 10 }, () => ({
      day: "2026-06-10",
      costCents: 100,
    }));
    const p = projectMonthEnd({
      points,
      monthToDateCents: 1000,
      dayOfMonth: 10,
      daysInMonth: 30,
    });
    // run-rate ~100, 20 remaining days => 1000 + ~2000
    expect(p.remainingDays).toBe(20);
    expect(p.projectedMonthEndCents).toBeGreaterThan(2800);
    expect(p.projectedMonthEndCents).toBeLessThan(3200);
  });

  it("equals MTD on the last day of the month", () => {
    const points: DailyCostPoint[] = [{ day: "2026-06-30", costCents: 100 }];
    const p = projectMonthEnd({
      points,
      monthToDateCents: 5000,
      dayOfMonth: 30,
      daysInMonth: 30,
    });
    expect(p.remainingDays).toBe(0);
    expect(p.projectedMonthEndCents).toBe(5000);
  });
});

describe("mape", () => {
  it("is zero for a perfect prediction", () => {
    expect(mape([10, 20, 30], [10, 20, 30])).toBe(0);
  });

  it("computes the mean absolute percentage error", () => {
    // actual 100, predicted 110 => 10% error
    expect(mape([100], [110])).toBeCloseTo(0.1, 6);
  });

  it("skips zero-actual points", () => {
    expect(mape([0, 100], [50, 110])).toBeCloseTo(0.1, 6);
  });
});

describe("MAPE backtest — AC: month-end projection within ±15% of actual", () => {
  /**
   * Synthetic generator: base daily cost with a gentle linear growth and
   * bounded pseudo-random noise. Deterministic (seeded) so the backtest is
   * stable in CI.
   */
  function makeSeries(
    days: number,
    base: number,
    growthPerDay: number,
    noisePct: number,
  ): number[] {
    // Simple deterministic LCG for repeatable "noise".
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff; // [0,1)
    };
    return Array.from({ length: days }, (_, i) => {
      const trend = base + growthPerDay * i;
      const noise = (rand() * 2 - 1) * noisePct * trend;
      return Math.max(0, Math.round(trend + noise));
    });
  }

  it("projects 30-day month-end within 15% on a growing series", () => {
    const daily = makeSeries(30, 1000, 30, 0.12);
    const actualMonthEnd = daily.reduce((a, b) => a + b, 0);

    // Simulate "today is day 15": use first 15 days as the observation window
    // and project the full month from there.
    const observed = daily.slice(0, 15);
    const mtd = observed.reduce((a, b) => a + b, 0);
    const points: DailyCostPoint[] = observed.map((c, i) => ({
      day: `2026-06-${String(i + 1).padStart(2, "0")}`,
      costCents: c,
    }));
    const projection = projectMonthEnd({
      points,
      monthToDateCents: mtd,
      dayOfMonth: 15,
      daysInMonth: 30,
    });

    const err = Math.abs(projection.projectedMonthEndCents - actualMonthEnd) / actualMonthEnd;
    expect(err).toBeLessThanOrEqual(0.15);
  });

  it("walk-forward daily run-rate MAPE over a 30-day window is ≤ 15%", () => {
    const daily = makeSeries(30, 800, 20, 0.1);
    const predicted: number[] = [];
    const actual: number[] = [];
    // From day 7 onward, predict each day's cost from the preceding window.
    for (let t = 7; t < daily.length; t++) {
      const window = daily.slice(0, t).map((c, i) => ({
        day: `2026-06-${String(i + 1).padStart(2, "0")}`,
        costCents: c,
      }));
      const f = forecastDailyRunRate({ points: window });
      predicted.push(f.dailyRunRateCents);
      actual.push(daily[t]);
    }
    const m = mape(actual, predicted);
    expect(m).toBeLessThanOrEqual(0.15);
  });

  it("flat-usage projection is near-exact (sanity)", () => {
    const observed = Array.from({ length: 10 }, () => 500);
    const points: DailyCostPoint[] = observed.map((c, i) => ({
      day: `2026-06-${String(i + 1).padStart(2, "0")}`,
      costCents: c,
    }));
    const projection = projectMonthEnd({
      points,
      monthToDateCents: 5000,
      dayOfMonth: 10,
      daysInMonth: 30,
    });
    const actualMonthEnd = 500 * 30;
    const err = Math.abs(projection.projectedMonthEndCents - actualMonthEnd) / actualMonthEnd;
    expect(err).toBeLessThanOrEqual(0.05);
  });
});
