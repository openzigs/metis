/**
 * Epic #515 / Issue #519 — Adaptive context window watermark with proactive
 * compaction.
 *
 * - Watermark = configurable percentage of model context limit (default: 80%)
 * - Model context limits stored in config
 * - Checks context size before each turn; triggers compaction if above watermark
 * - Compaction is gradual: summarize oldest 25% of history first
 * - Integrates with existing compaction.ts (calls its summarization logic)
 * - Logs when compaction triggers with before/after token counts
 * - Does NOT compact if session has fewer than 5 turns
 */
import { createChildLogger } from "../logger.js";

const log = createChildLogger("context-watermark");

/** Known model context limits (in tokens). */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "us.anthropic.claude-sonnet-4-6": 200_000,
  "anthropic.claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_385,
  o1: 200_000,
  "o1-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
};

/** Default context limit when model is unknown. */
const DEFAULT_CONTEXT_LIMIT = 128_000;

/** Default watermark percentage (0-1). */
const DEFAULT_WATERMARK_PERCENTAGE = 0.8;

/** Minimum turns before compaction is allowed. */
const MIN_TURNS_FOR_COMPACTION = 5;

/** Fraction of oldest turns to summarize per compaction pass. */
const COMPACTION_FRACTION = 0.25;

/** Characters per token approximation. */
const CHARS_PER_TOKEN = 4;

export interface ContextWatermarkOptions {
  /** Model name to look up context limit. */
  model?: string;
  /** Override context limit in tokens (ignores model lookup). */
  contextLimit?: number;
  /** Watermark percentage (0-1). Default: 0.8. */
  watermarkPercentage?: number;
  /** Minimum turns before compaction is allowed. Default: 5. */
  minTurns?: number;
  /** Fraction of oldest turns to summarize. Default: 0.25. */
  compactionFraction?: number;
}

export interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface WatermarkCheckResult {
  /** Whether compaction was triggered. */
  compactionTriggered: boolean;
  /** Current token usage. */
  currentTokens: number;
  /** The watermark threshold in tokens. */
  watermarkTokens: number;
  /** Context limit for the model. */
  contextLimit: number;
  /** Utilization percentage (0-1). */
  utilization: number;
  /** Reason if compaction was skipped. */
  skipReason?: string;
}

export interface CompactionRequest {
  /** Messages to compact. */
  messages: ChatTurn[];
  /** Number of oldest non-system turns to summarize. */
  turnsToSummarize: number;
  /** Before token count. */
  beforeTokens: number;
}

/**
 * Estimate tokens for a single message.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Calculate total tokens across all messages.
 */
export function totalTokens(messages: ChatTurn[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * Get the context limit for a model.
 */
export function getModelContextLimit(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  const limit = MODEL_CONTEXT_LIMITS[model];
  if (limit) return limit;

  // Try prefix matching (e.g. "claude-sonnet-4-..." matches "claude-sonnet-4-20250514")
  for (const [key, value] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(key.split("-").slice(0, 3).join("-"))) {
      return value;
    }
  }

  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Count non-system turns in a message array.
 */
export function countNonSystemTurns(messages: ChatTurn[]): number {
  return messages.filter((m) => m.role !== "system").length;
}

/**
 * Context watermark monitor. Checks context size against model limits and
 * triggers gradual compaction when the watermark is exceeded.
 */
export class ContextWatermark {
  private readonly contextLimit: number;
  private readonly watermarkPercentage: number;
  private readonly watermarkTokens: number;
  private readonly minTurns: number;
  private readonly compactionFraction: number;

  constructor(options: ContextWatermarkOptions = {}) {
    this.contextLimit = options.contextLimit ?? getModelContextLimit(options.model);
    this.watermarkPercentage = options.watermarkPercentage ?? DEFAULT_WATERMARK_PERCENTAGE;
    this.watermarkTokens = Math.floor(this.contextLimit * this.watermarkPercentage);
    this.minTurns = options.minTurns ?? MIN_TURNS_FOR_COMPACTION;
    this.compactionFraction = options.compactionFraction ?? COMPACTION_FRACTION;
  }

  /**
   * Check if context has exceeded the watermark and return a compaction
   * request if needed. Does NOT perform the compaction itself — the caller
   * is responsible for executing it via the existing compaction.ts logic.
   */
  check(messages: ChatTurn[]): WatermarkCheckResult & { compactionRequest?: CompactionRequest } {
    const currentTokens = totalTokens(messages);
    const utilization = currentTokens / this.contextLimit;

    const baseResult: WatermarkCheckResult = {
      compactionTriggered: false,
      currentTokens,
      watermarkTokens: this.watermarkTokens,
      contextLimit: this.contextLimit,
      utilization,
    };

    // Below watermark: no action needed
    if (currentTokens <= this.watermarkTokens) {
      return baseResult;
    }

    // Check minimum turns
    const nonSystemTurns = countNonSystemTurns(messages);
    if (nonSystemTurns < this.minTurns) {
      log.info("Context above watermark but too few turns for compaction", {
        currentTokens,
        watermarkTokens: this.watermarkTokens,
        nonSystemTurns,
        minTurns: this.minTurns,
      });
      return {
        ...baseResult,
        skipReason: `Too few turns (${nonSystemTurns} < ${this.minTurns})`,
      };
    }

    // Calculate turns to summarize (oldest 25% of non-system turns)
    const turnsToSummarize = Math.max(1, Math.floor(nonSystemTurns * this.compactionFraction));

    log.info("Context watermark exceeded, requesting compaction", {
      currentTokens,
      watermarkTokens: this.watermarkTokens,
      utilization: Math.round(utilization * 100),
      nonSystemTurns,
      turnsToSummarize,
    });

    return {
      ...baseResult,
      compactionTriggered: true,
      compactionRequest: {
        messages,
        turnsToSummarize,
        beforeTokens: currentTokens,
      },
    };
  }

  /**
   * Get the current watermark threshold in tokens.
   */
  getWatermarkTokens(): number {
    return this.watermarkTokens;
  }

  /**
   * Get the model context limit.
   */
  getContextLimit(): number {
    return this.contextLimit;
  }

  /**
   * Get watermark percentage.
   */
  getWatermarkPercentage(): number {
    return this.watermarkPercentage;
  }

  /**
   * Helper to log compaction results (call after executing compaction).
   */
  logCompactionResult(beforeTokens: number, afterTokens: number): void {
    const saved = beforeTokens - afterTokens;
    const savedPct = Math.round((saved / beforeTokens) * 100);
    log.info("Context compaction completed", {
      beforeTokens,
      afterTokens,
      savedTokens: saved,
      savedPercentage: savedPct,
    });
  }
}
