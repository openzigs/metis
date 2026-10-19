/**
 * #1238 — usage a provider reported for a call whose stream then FAILED.
 *
 * A provider yields its `usage` chunk only at the end of a stream, so a stream
 * that drops mid-reply ends with no usage chunk at all — yet the provider has
 * already billed what it reported along the way (Anthropic's `message_start`
 * carries the prompt's `input_tokens` before any text). An adapter that saw
 * such a report attaches it to the error it throws; the caller that meters the
 * call reads it back with {@link partialUsageOf}.
 *
 * It rides on the error rather than as an early `usage` chunk on purpose:
 * several stream consumers meter EVERY usage chunk they see
 * (`analysis-usage.ts`, `impact-llm-runtime.ts`), and a second chunk per call
 * would bill those calls twice. Only a caller that asks gets the partial
 * figure, and it gets it only for a call that never yielded its final usage.
 *
 * Kept in a WeakMap, not on the error object, so no serialiser or error
 * response can ever leak it, and an error is never retained by it.
 */
import type { TokenUsage } from "./types.js";

const PARTIAL = new WeakMap<object, TokenUsage>();

/** Attach `usage` to `err` (an object); returns `err` for `throw attach(…)`. */
export function attachPartialUsage<E>(err: E, usage: TokenUsage): E {
  if (err !== null && typeof err === "object") PARTIAL.set(err, { ...usage });
  return err;
}

/**
 * The usage the provider reported before `err` ended its call, or `undefined`
 * when it reported none. Follows `cause` a few levels, so a caller that wraps
 * the adapter's error keeps it readable.
 */
export function partialUsageOf(err: unknown): TokenUsage | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur !== null && typeof cur === "object"; depth++) {
    const found = PARTIAL.get(cur);
    if (found) return { ...found };
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
