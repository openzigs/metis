/**
 * Epic #1316 / issue #1321 — online-eval configuration.
 *
 * Every knob resolves through {@link ConfigService} on each read so an admin
 * write to `runtime_config` takes effect on the next sampled run without a
 * restart (same posture as `analysis/cost-cap.ts`).
 *
 * Defaults are deliberately conservative: the feature is OFF, the sample rate
 * is 1%, drift alerting is separately OFF, and the token budget is its own
 * allowance — never `ANALYSIS_MONTHLY_TOKEN_CAP`.
 */
import path from "node:path";
import {
  DEFAULT_ONLINE_EVAL_DRIFT_THRESHOLD_PCT,
  DEFAULT_ONLINE_EVAL_ENABLED,
  DEFAULT_ONLINE_EVAL_MAX_CHARS,
  DEFAULT_ONLINE_EVAL_MONTHLY_TOKEN_BUDGET,
  DEFAULT_ONLINE_EVAL_SAMPLE_RATE,
  DEFAULT_ONLINE_EVAL_TOKENS_PER_SCORE,
  DEFAULT_ONLINE_EVAL_WINDOW_SIZE,
} from "@metis/shared";
import { getConfigService } from "../../config/index.js";

/** The slice of `ConfigService` this module needs — keeps tests dependency-free. */
export interface OnlineEvalConfigReader {
  get(key: string): string | undefined;
  getBool(key: string, defaultValue?: boolean): boolean;
  getNumber(key: string, defaultValue?: number): number;
}

export interface OnlineEvalConfig {
  /** Kill switch. When false nothing is sampled, scored or written. */
  enabled: boolean;
  /** Fraction of eligible completed runs to score, clamped to [0, 1]. */
  sampleRate: number;
  /** Monthly token allowance, separate from `ANALYSIS_MONTHLY_TOKEN_CAP`. 0 = disabled. */
  monthlyTokenBudget: number;
  /** Tokens reserved BEFORE each judge call. */
  tokensPerScore: number;
  /** Samples per aggregation window. */
  windowSize: number;
  /** Drop on a trended metric that counts as drift. */
  driftThresholdPct: number;
  /**
   * Drift alerting is gated independently of `enabled`. It must stay OFF until
   * a real judge lands (#1317) — alerting on `StubRagasJudge` output would page
   * on a lexical heuristic that does not measure faithfulness.
   */
  driftAlertsEnabled: boolean;
  /** Redacted text handed to the judge is truncated to this many characters. */
  maxChars: number;
  /** Where window envelopes are written. */
  resultsDir: string;
}

function clamp01(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function nonNegativeInt(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i >= 0 ? i : fallback;
}

export function defaultOnlineResultsDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "eval-results", "online");
}

export function resolveOnlineEvalConfig(
  cfg: OnlineEvalConfigReader = getConfigService(),
): OnlineEvalConfig {
  const rawDir = (cfg.get("ONLINE_EVAL_RESULTS_DIR") ?? "").trim();
  return {
    enabled: cfg.getBool("ONLINE_EVAL_ENABLED", DEFAULT_ONLINE_EVAL_ENABLED),
    sampleRate: clamp01(
      cfg.getNumber("ONLINE_EVAL_SAMPLE_RATE", DEFAULT_ONLINE_EVAL_SAMPLE_RATE),
      DEFAULT_ONLINE_EVAL_SAMPLE_RATE,
    ),
    monthlyTokenBudget: nonNegativeInt(
      cfg.getNumber("ONLINE_EVAL_MONTHLY_TOKEN_BUDGET", DEFAULT_ONLINE_EVAL_MONTHLY_TOKEN_BUDGET),
      DEFAULT_ONLINE_EVAL_MONTHLY_TOKEN_BUDGET,
    ),
    tokensPerScore: Math.max(
      1,
      nonNegativeInt(
        cfg.getNumber("ONLINE_EVAL_TOKENS_PER_SCORE", DEFAULT_ONLINE_EVAL_TOKENS_PER_SCORE),
        DEFAULT_ONLINE_EVAL_TOKENS_PER_SCORE,
      ),
    ),
    windowSize: Math.max(
      1,
      nonNegativeInt(
        cfg.getNumber("ONLINE_EVAL_WINDOW_SIZE", DEFAULT_ONLINE_EVAL_WINDOW_SIZE),
        DEFAULT_ONLINE_EVAL_WINDOW_SIZE,
      ),
    ),
    driftThresholdPct: clamp01(
      cfg.getNumber("ONLINE_EVAL_DRIFT_THRESHOLD_PCT", DEFAULT_ONLINE_EVAL_DRIFT_THRESHOLD_PCT),
      DEFAULT_ONLINE_EVAL_DRIFT_THRESHOLD_PCT,
    ),
    driftAlertsEnabled: cfg.getBool("ONLINE_EVAL_DRIFT_ALERTS_ENABLED", false),
    maxChars: Math.max(
      1,
      nonNegativeInt(
        cfg.getNumber("ONLINE_EVAL_MAX_CHARS", DEFAULT_ONLINE_EVAL_MAX_CHARS),
        DEFAULT_ONLINE_EVAL_MAX_CHARS,
      ),
    ),
    resultsDir: rawDir ? path.resolve(rawDir) : defaultOnlineResultsDir(),
  };
}
