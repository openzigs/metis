/**
 * Pure forecasting math for the FinOps time-series cost forecaster (Epic #47
 * / Issue #48).
 *
 * Two hand-coded estimators combine into a month-end spend projection:
 *
 *   1. Ordinary-least-squares (OLS) linear regression over the rolling
 *      window of daily cost. Captures a linear growth/decline trend.
 *   2. Exponentially-weighted moving average (EWMA). Captures the recent
 *      run-rate, weighting newer days more heavily via the smoothing factor
 *      `alpha`. EWMA_t = alpha * x_t + (1 - alpha) * EWMA_{t-1}.
 *
 * The month-end projection sums actual month-to-date cost plus the
 * forecast daily run-rate multiplied by the number of remaining days in the
 * calendar month. The forecast daily run-rate blends the OLS slope-projected
 * next-day value with the EWMA level so neither a noisy trend nor a stale
 * average dominates.
 *
 * No third-party library is used — both estimators are textbook closed-form
 * computations. See `forecast-service.test.ts` for the MAPE ≤ 15% backtest.
 */

/** A single day of observed cost (integer cents) keyed by ISO date (UTC). */
export interface DailyCostPoint {
  /** ISO `YYYY-MM-DD` (UTC). */
  day: string;
  /** Cost in integer cents for that day. */
  costCents: number;
}

export interface OlsResult {
  /** Intercept (cost at x=0). */
  intercept: number;
  /** Slope (cost delta per day). */
  slope: number;
}

/**
 * Ordinary least squares over points (x = index 0..n-1, y = costCents).
 * Returns a zero-slope line at the mean when there are < 2 points or the
 * x-variance is zero (degenerate, avoids divide-by-zero).
 */
export function linearRegression(values: number[]): OlsResult {
  const n = values.length;
  if (n === 0) return { intercept: 0, slope: 0 };
  if (n === 1) return { intercept: values[0], slope: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    return { intercept: sumY / n, slope: 0 };
  }
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { intercept, slope };
}

/**
 * Predict the y value of an OLS line at index `x`.
 */
export function predictAt(ols: OlsResult, x: number): number {
  return ols.intercept + ols.slope * x;
}

/**
 * Exponentially-weighted moving average. `alpha` in (0,1]; higher = more
 * weight on recent observations. Returns the final smoothed level. An empty
 * series returns 0.
 */
export function ewma(values: number[], alpha: number): number {
  if (values.length === 0) return 0;
  const a = clampAlpha(alpha);
  let level = values[0];
  for (let i = 1; i < values.length; i++) {
    level = a * values[i] + (1 - a) * level;
  }
  return level;
}

function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return 0.5;
  if (alpha <= 0) return 0.01;
  if (alpha > 1) return 1;
  return alpha;
}

export interface ForecastInput {
  /** Rolling-window daily cost points, oldest first. */
  points: DailyCostPoint[];
  /** EWMA smoothing factor (default 0.3). */
  alpha?: number;
  /**
   * Blend weight on the OLS trend vs the EWMA level for the projected daily
   * run-rate. 0 = pure EWMA, 1 = pure OLS. Default 0.5.
   */
  trendWeight?: number;
}

export interface ForecastResult {
  /** Blended projected daily run-rate (cents/day), clamped at 0. */
  dailyRunRateCents: number;
  /** OLS slope (cents/day). */
  slopeCentsPerDay: number;
  /** Final EWMA level (cents/day). */
  ewmaCents: number;
  /** Number of observed points used. */
  sampleDays: number;
}

const DEFAULT_ALPHA = 0.3;
const DEFAULT_TREND_WEIGHT = 0.5;

/**
 * Compute the blended daily run-rate forecast from a rolling window of daily
 * cost. The OLS component predicts the *next* day (index n) from the trend;
 * the EWMA component reflects the recent smoothed level. The two are blended
 * by `trendWeight` and clamped at zero (cost can't go negative).
 */
export function forecastDailyRunRate(input: ForecastInput): ForecastResult {
  const { points } = input;
  const alpha = input.alpha ?? DEFAULT_ALPHA;
  const trendWeight = clamp01(input.trendWeight ?? DEFAULT_TREND_WEIGHT);
  const values = points.map((p) => p.costCents);
  const n = values.length;

  if (n === 0) {
    return { dailyRunRateCents: 0, slopeCentsPerDay: 0, ewmaCents: 0, sampleDays: 0 };
  }

  const ols = linearRegression(values);
  // Project the trend one day past the window (the first forecast day).
  const olsNext = Math.max(0, predictAt(ols, n));
  const ewmaLevel = Math.max(0, ewma(values, alpha));
  const blended = trendWeight * olsNext + (1 - trendWeight) * ewmaLevel;

  return {
    dailyRunRateCents: Math.max(0, blended),
    slopeCentsPerDay: ols.slope,
    ewmaCents: ewmaLevel,
    sampleDays: n,
  };
}

export interface MonthEndProjectionInput extends ForecastInput {
  /** Month-to-date actual cost in integer cents. */
  monthToDateCents: number;
  /** Days already elapsed in the calendar month (1-based, inclusive of today). */
  dayOfMonth: number;
  /** Total days in the calendar month. */
  daysInMonth: number;
}

export interface MonthEndProjection extends ForecastResult {
  /** Projected total month-end cost in integer cents. */
  projectedMonthEndCents: number;
  /** Remaining days in the month the run-rate is applied to. */
  remainingDays: number;
}

/**
 * Project month-end total cost = actual MTD + run-rate * remaining days.
 * The run-rate comes from the blended OLS/EWMA forecast.
 */
export function projectMonthEnd(input: MonthEndProjectionInput): MonthEndProjection {
  const forecast = forecastDailyRunRate(input);
  const remainingDays = Math.max(0, input.daysInMonth - input.dayOfMonth);
  const projectedMonthEndCents = Math.ceil(
    input.monthToDateCents + forecast.dailyRunRateCents * remainingDays,
  );
  return { ...forecast, projectedMonthEndCents, remainingDays };
}

/**
 * Mean Absolute Percentage Error between actual and predicted series.
 * Skips zero-actual points (undefined percentage) so a sparse warm-up
 * doesn't dominate. Returns a fraction (0.15 == 15%). Returns 0 when there
 * are no comparable points.
 */
export function mape(actual: number[], predicted: number[]): number {
  const len = Math.min(actual.length, predicted.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (actual[i] === 0) continue;
    sum += Math.abs((actual[i] - predicted[i]) / actual[i]);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
