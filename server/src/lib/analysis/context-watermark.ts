/**
 * Epic #515 / Issue #519 — context-window watermark, revived by #138.
 *
 * This module was never imported: chat trimmed history with a fixed sliding
 * window instead, which silently dropped old turns. It is now the trigger for
 * automatic compaction on every chat turn (`lib/async/compaction.ts`).
 *
 * #138 changes from the original:
 *
 *   • The context window comes from the MODEL CATALOG (#135) —
 *     {@link resolveContextWindow} — not from a hardcoded table here that had
 *     already drifted (it listed Sonnet 4.6 at 200K; the catalog has 1M). When
 *     the catalog does not know the window, an explicit, configurable fallback
 *     is used and REPORTED as a fallback, never passed off as the real window.
 *   • Tokens come from the calibrated estimator (#137), not characters ÷ 4.
 *   • The watermark decides WHETHER to compact. Which turns to fold is the
 *     compactor's job, because it needs turn boundaries this module never had.
 */
import { lookupCatalogEntry } from "../ai/model-catalog.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("context-watermark");

/** Default watermark: compact once the prompt reaches 80% of the window. */
export const DEFAULT_WATERMARK_PERCENT = 80;
/** Bounds on a configured watermark percentage. */
export const MIN_WATERMARK_PERCENT = 10;
export const MAX_WATERMARK_PERCENT = 95;

/**
 * Window assumed when the catalog does not know the model's (a local model
 * that discovery has not described yet, or an id no source lists). 32,768 is
 * deliberately modest: an under-estimate only compacts early, while an
 * over-estimate would let the prompt overflow a small local context. Operators
 * with a larger window set it per model in `AI_MODEL_CATALOG_OVERRIDES`.
 */
export const DEFAULT_CONTEXT_WINDOW_FALLBACK = 32_768;

export type ContextWindowSource = "catalog" | "fallback";

export interface ResolvedContextWindow {
  tokens: number;
  source: ContextWindowSource;
}

/**
 * The context window for `provider:model`, from the model catalog. `fallback`
 * (a positive integer ≥ 1,024) replaces {@link DEFAULT_CONTEXT_WINDOW_FALLBACK}
 * when set.
 */
export function resolveContextWindow(
  provider: string,
  model: string,
  opts: { fallback?: number; env?: NodeJS.ProcessEnv } = {},
): ResolvedContextWindow {
  const window = lookupCatalogEntry(provider, model, opts.env)?.contextWindow;
  if (typeof window === "number" && window > 0) return { tokens: window, source: "catalog" };
  const fallback =
    typeof opts.fallback === "number" && Number.isFinite(opts.fallback) && opts.fallback >= 1024
      ? Math.floor(opts.fallback)
      : DEFAULT_CONTEXT_WINDOW_FALLBACK;
  return { tokens: fallback, source: "fallback" };
}

/** Clamp a configured watermark percentage into the supported band. */
export function clampWatermarkPercent(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_WATERMARK_PERCENT;
  return Math.min(MAX_WATERMARK_PERCENT, Math.max(MIN_WATERMARK_PERCENT, Math.round(raw)));
}

export interface ContextWatermarkOptions {
  contextWindow: ResolvedContextWindow;
  /** Percentage of the window at which to compact (default 80). */
  watermarkPercent?: number;
  /**
   * An absolute token ceiling that caps the watermark from above — the
   * per-project `contextCompactionThreshold` / `CONTEXT_COMPACTION_THRESHOLD_TOKENS`
   * setting that existed before #138. Never raises the watermark.
   */
  thresholdTokens?: number | null;
}

export interface WatermarkCheckResult {
  /** The estimated prompt is at or above the watermark. */
  overWatermark: boolean;
  /** The estimated prompt does not fit the window at all. */
  overWindow: boolean;
  estimatedTokens: number;
  watermarkTokens: number;
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
  /** estimatedTokens ÷ contextWindow. */
  utilization: number;
}

/** Decides, from an estimated prompt size, whether a turn must compact first. */
export class ContextWatermark {
  readonly contextWindow: number;
  readonly contextWindowSource: ContextWindowSource;
  readonly watermarkPercent: number;
  readonly watermarkTokens: number;

  constructor(options: ContextWatermarkOptions) {
    this.contextWindow = options.contextWindow.tokens;
    this.contextWindowSource = options.contextWindow.source;
    this.watermarkPercent = clampWatermarkPercent(options.watermarkPercent);
    const fromPercent = Math.floor((this.contextWindow * this.watermarkPercent) / 100);
    const threshold = options.thresholdTokens;
    this.watermarkTokens =
      typeof threshold === "number" && threshold > 0
        ? Math.min(fromPercent, threshold)
        : fromPercent;
  }

  check(estimatedTokens: number): WatermarkCheckResult {
    const result: WatermarkCheckResult = {
      overWatermark: estimatedTokens >= this.watermarkTokens,
      overWindow: estimatedTokens > this.contextWindow,
      estimatedTokens,
      watermarkTokens: this.watermarkTokens,
      contextWindow: this.contextWindow,
      contextWindowSource: this.contextWindowSource,
      utilization: this.contextWindow > 0 ? estimatedTokens / this.contextWindow : 1,
    };
    if (result.overWatermark) {
      log.info("Context watermark reached", {
        estimatedTokens,
        watermarkTokens: this.watermarkTokens,
        contextWindow: this.contextWindow,
        contextWindowSource: this.contextWindowSource,
        utilization: Math.round(result.utilization * 100),
      });
    }
    return result;
  }
}
