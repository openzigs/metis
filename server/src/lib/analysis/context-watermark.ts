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

/**
 * #213 — the chat answer cap, decided: chat sends NO `maxTokens` for its answer
 * (the provider's own default applies, and the output-cap / truncation handling
 * is unchanged), but the overflow check and the compaction target RESERVE room
 * for it. The reserve is
 *
 *     min(catalog maxOutputTokens, CHAT_ANSWER_RESERVE_PERCENT % of the window)
 *
 * — the percentage alone when the catalog does not know the model's output cap.
 * Reserving the catalog's full `maxOutputTokens` blindly would raise false 413s:
 * it is tens of thousands of tokens on some models, far past a chat answer, and
 * would refuse conversations that would have been answered. 10% of the window
 * (3,276 tokens on the 32,768 fallback; 20,000 on a 200K model) holds any
 * ordinary answer. 0 turns the reserve off (the pre-#213 behaviour).
 */
export const DEFAULT_ANSWER_RESERVE_PERCENT = 10;
/** Upper bound on a configured reserve: past half the window, nothing fits. */
export const MAX_ANSWER_RESERVE_PERCENT = 50;

export type AnswerReserveSource = "catalog" | "window-share" | "off";

export interface AnswerReserve {
  tokens: number;
  /** `catalog` = the model's catalog output cap was the smaller bound. */
  source: AnswerReserveSource;
}

/** Clamp a configured answer-reserve percentage into 0..50. */
export function clampAnswerReservePercent(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_ANSWER_RESERVE_PERCENT;
  return Math.min(MAX_ANSWER_RESERVE_PERCENT, Math.max(0, Math.round(raw)));
}

/** #213 — the tokens a chat turn keeps free in the window for the reply. */
export function resolveAnswerReserve(
  provider: string,
  model: string,
  contextWindowTokens: number,
  opts: { percent?: number; env?: NodeJS.ProcessEnv } = {},
): AnswerReserve {
  const percent = clampAnswerReservePercent(opts.percent);
  if (percent === 0 || contextWindowTokens <= 0) return { tokens: 0, source: "off" };
  const share = Math.floor((contextWindowTokens * percent) / 100);
  const cap = lookupCatalogEntry(provider, model, opts.env)?.maxOutputTokens;
  if (typeof cap === "number" && cap > 0 && cap < share) return { tokens: cap, source: "catalog" };
  return { tokens: share, source: "window-share" };
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
  /**
   * #213 — tokens kept free for the reply ({@link resolveAnswerReserve}). The
   * prompt overflows when prompt + reserve exceeds the window, and the
   * watermark never sits above window − reserve, so a turn always tries to
   * compact before it is refused.
   */
  answerReserveTokens?: number;
}

export interface WatermarkCheckResult {
  /** The estimated prompt is at or above the watermark. */
  overWatermark: boolean;
  /** The estimated prompt plus the answer reserve does not fit the window. */
  overWindow: boolean;
  estimatedTokens: number;
  watermarkTokens: number;
  /** #213 — tokens kept free for the reply. */
  answerReserveTokens: number;
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
  readonly answerReserveTokens: number;

  constructor(options: ContextWatermarkOptions) {
    this.contextWindow = options.contextWindow.tokens;
    this.contextWindowSource = options.contextWindow.source;
    this.watermarkPercent = clampWatermarkPercent(options.watermarkPercent);
    const reserve = options.answerReserveTokens;
    this.answerReserveTokens =
      typeof reserve === "number" && Number.isFinite(reserve) && reserve > 0
        ? Math.min(Math.floor(reserve), this.contextWindow)
        : 0;
    const fromPercent = Math.floor((this.contextWindow * this.watermarkPercent) / 100);
    const threshold = options.thresholdTokens;
    const capped =
      typeof threshold === "number" && threshold > 0
        ? Math.min(fromPercent, threshold)
        : fromPercent;
    // A watermark above the usable window would let a prompt overflow (413)
    // without ever trying to compact first.
    this.watermarkTokens = Math.min(capped, this.contextWindow - this.answerReserveTokens);
  }

  check(estimatedTokens: number): WatermarkCheckResult {
    const result: WatermarkCheckResult = {
      overWatermark: estimatedTokens >= this.watermarkTokens,
      overWindow: estimatedTokens + this.answerReserveTokens > this.contextWindow,
      estimatedTokens,
      watermarkTokens: this.watermarkTokens,
      answerReserveTokens: this.answerReserveTokens,
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
