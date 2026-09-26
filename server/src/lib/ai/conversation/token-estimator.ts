/**
 * Epic #127 / #137 — count tokens per provider, and estimate them before a
 * call from real numbers rather than a characters-÷-4 guess.
 *
 * ## After a call: what the provider reported
 *
 * Providers disagree on what "prompt tokens" means, so the context a call
 * occupied is read per provider ({@link contextInputTokens}):
 *
 *   • Anthropic Messages API — `input_tokens` EXCLUDES cache reads and cache
 *     writes (they are reported beside it), so the three are summed.
 *   • OpenAI-compatible (`local-gemma`, `bedrock-gateway`, `openai`, `azure`)
 *     — `prompt_tokens` already INCLUDES `cached_tokens`; it is the whole input.
 *
 * ## Before a call: a calibrated estimate
 *
 * No tokenizer for the served models ships in this repository (checked
 * `server/package.json`: no tiktoken / gpt-tokenizer / @anthropic-ai/tokenizer;
 * `@huggingface/transformers` can load a tokenizer but only by downloading it,
 * which a chat turn must not do). So the estimate is characters ÷ a
 * characters-per-token ratio, chosen in this order ({@link resolveTokenRatio}):
 *
 *   1. **calibrated** — this session's own recent turns on the same model:
 *      Σ prompt characters ÷ Σ provider-reported input tokens. Real numbers from
 *      the real tokenizer, so after one reported turn the estimate tracks it.
 *   2. **catalog** — a per-model ratio from the model catalog
 *      (`catalogCharsPerToken`: an operator override or a measured family).
 *   3. **default** — {@link DEFAULT_CHARS_PER_TOKEN}.
 */
import type { ChatMessage, TokenUsage } from "../types.js";
import { messageText } from "../types.js";
import { catalogCharsPerToken } from "../model-catalog.js";

/**
 * The fallback ratio. 3.0 is the LOWEST figure measured in this repo on real
 * content (fact-style bullets, laguna-s-2.1's own tokenizer — see
 * `PHASE1_INPUT_CHARS_PER_TOKEN` in `docs-gen/phase1-chunking.ts`; code measured
 * 3.66–3.95, Markdown 4.03). A low ratio over-counts tokens, which compacts a
 * little early rather than overflowing the window. The ~1.26–1.5 figure quoted
 * in #137 was an artefact of prompts that carried their facts twice (same file).
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.0;

/** A calibrated ratio outside this band is treated as a bad sample. */
export const MIN_CHARS_PER_TOKEN = 1.0;
export const MAX_CHARS_PER_TOKEN = 8.0;

/** Role/framing tokens every message costs on top of its text. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** How many recent reported turns the calibration averages over. */
export const CALIBRATION_WINDOW = 5;

/**
 * Tokens of CONTEXT a call occupied, from what the provider reported. Returns
 * `null` when nothing was reported — never 0, which would read as "empty".
 */
export function contextInputTokens(
  provider: string,
  usage: Pick<TokenUsage, "promptTokens" | "cacheReadTokens" | "cacheWriteTokens"> | null,
): number | null {
  if (!usage) return null;
  const prompt = usage.promptTokens ?? 0;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const total = provider === "anthropic" ? prompt + read + write : prompt;
  return total > 0 ? total : null;
}

/** A reported turn: how many prompt characters produced how many input tokens. */
export interface CalibrationSample {
  promptChars: number;
  inputTokens: number;
}

export type TokenRatioSource = "calibrated" | "catalog" | "default";

export interface TokenRatio {
  charsPerToken: number;
  source: TokenRatioSource;
  /** Calibrated only: how many reported turns it was computed from. */
  samples?: number;
}

/**
 * Σchars ÷ Σtokens over the most recent {@link CALIBRATION_WINDOW} samples;
 * `null` when there are none or the result is implausible.
 */
export function calibratedRatio(samples: readonly CalibrationSample[]): number | null {
  const usable = samples
    .filter((s) => s.promptChars > 0 && s.inputTokens > 0)
    .slice(-CALIBRATION_WINDOW);
  if (usable.length === 0) return null;
  const chars = usable.reduce((n, s) => n + s.promptChars, 0);
  const tokens = usable.reduce((n, s) => n + s.inputTokens, 0);
  const ratio = chars / tokens;
  return ratio >= MIN_CHARS_PER_TOKEN && ratio <= MAX_CHARS_PER_TOKEN ? ratio : null;
}

export function resolveTokenRatio(opts: {
  provider: string;
  model: string;
  samples?: readonly CalibrationSample[];
  env?: NodeJS.ProcessEnv;
}): TokenRatio {
  const samples = opts.samples ?? [];
  const calibrated = calibratedRatio(samples);
  if (calibrated !== null) {
    return {
      charsPerToken: calibrated,
      source: "calibrated",
      samples: Math.min(samples.length, CALIBRATION_WINDOW),
    };
  }
  const fromCatalog = catalogCharsPerToken(opts.provider, opts.model, opts.env);
  if (fromCatalog !== null) return { charsPerToken: fromCatalog, source: "catalog" };
  return { charsPerToken: DEFAULT_CHARS_PER_TOKEN, source: "default" };
}

export function estimateTextTokens(text: string, ratio: TokenRatio): number {
  if (!text) return 0;
  return Math.ceil(text.length / ratio.charsPerToken);
}

/** Characters the model will read from these messages (text parts only). */
export function promptChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageText(m).length, 0);
}

export function estimateMessageTokens(message: ChatMessage, ratio: TokenRatio): number {
  return estimateTextTokens(messageText(message), ratio) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateMessagesTokens(
  messages: readonly ChatMessage[],
  ratio: TokenRatio,
): number {
  return messages.reduce((n, m) => n + estimateMessageTokens(m, ratio), 0);
}
