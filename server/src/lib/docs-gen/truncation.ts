/**
 * #1226 — output-cap truncation detection for docs-gen section synthesis.
 *
 * A Phase-2 section call that hits the model's `max_tokens` output cap does NOT
 * fail: the provider returns HTTP 200 and the section body is either cut mid
 * sentence or replaced wholesale by a bedrock-access-gateway placeholder
 * (`[No response text was returned by the model (stopReason=max_tokens)...]`).
 * Neither is an exception, so the synthesizer used to persist the mutilated
 * section and still mark the document `ready`.
 *
 * This module owns the two independent truncation signals so both are testable
 * in isolation and neither can drift:
 *
 * 1. **Finish reason** — the provider's own stop signal (`length` on the
 *    OpenAI-compatible wire format, `max_tokens` on Anthropic's).
 * 2. **Placeholder text** — the gateway's substitute body, which arrives as
 *    ordinary stream deltas and would otherwise be written verbatim into
 *    `generated_documents.content`.
 *
 * Both are needed: a gateway that substitutes the placeholder may not forward a
 * finish reason at all, and a model cut off mid-sentence emits a finish reason
 * with no placeholder.
 */

/**
 * Provider finish reasons that mean "stopped because the OUTPUT cap was hit".
 *
 * `length` is the OpenAI-compatible spelling (bedrock-access-gateway, Ollama,
 * vLLM); `max_tokens` is Anthropic's. Compared case-insensitively after
 * trimming so a provider that shouts it still matches.
 */
const TRUNCATION_FINISH_REASONS: ReadonlySet<string> = new Set([
  "length",
  "max_tokens",
  "max_token",
  "model_length",
  "output_limit",
]);

/**
 * True when `reason` is a provider stop signal meaning the response was cut
 * short by the output-token cap. `undefined`/`null` (provider did not report
 * one) is NOT truncation — absence of evidence only.
 */
export function isTruncationFinishReason(reason: string | null | undefined): boolean {
  if (typeof reason !== "string") return false;
  return TRUNCATION_FINISH_REASONS.has(reason.trim().toLowerCase());
}

/**
 * The bedrock-access-gateway placeholder body. Matched on the distinctive
 * leading phrase and consumed up to the closing bracket — the trailing `]?`
 * makes an unterminated placeholder (itself cut off by the cap) strippable too.
 *
 * Recreated per call site because a `g`-flagged regex carries mutable
 * `lastIndex` state that would make repeated `.test()` calls alternate.
 */
function placeholderPattern(): RegExp {
  return /\[\s*No response text was returned by the model\b[^\]]*\]?/gi;
}

/**
 * A bare `stopReason=max_tokens` marker. Some gateway builds emit the stop
 * reason inline without the bracketed sentence, so this is checked separately
 * as a detection (not a stripping) signal.
 */
function stopReasonMarkerPattern(): RegExp {
  return /stop[_ ]?reason\s*[=:]\s*["']?max_tokens/gi;
}

/** True when `text` carries the gateway's max-tokens placeholder or marker. */
export function containsTruncationPlaceholder(text: string): boolean {
  return placeholderPattern().test(text) || stopReasonMarkerPattern().test(text);
}

/**
 * Removes the gateway placeholder from `text` so it can never be persisted into
 * `generated_documents.content`. Collapses the whitespace the removal leaves
 * behind; a section that was ONLY a placeholder strips to the empty string,
 * which the caller reports as a failed/missing section.
 */
export function stripTruncationPlaceholder(text: string): string {
  return text
    .replace(placeholderPattern(), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Which independent signals fired for a given section response. */
export interface TruncationSignals {
  /** The provider reported an output-cap stop reason. */
  finishReason: boolean;
  /** The gateway's placeholder/marker text appeared in the response body. */
  placeholder: boolean;
}

/** Outcome of inspecting one section response for output-cap truncation. */
export interface TruncationDetection {
  /** Response text with any gateway placeholder removed. */
  text: string;
  /** True when EITHER signal fired. */
  truncated: boolean;
  /** The raw provider finish reason, when one was reported. */
  reason?: string;
  signals: TruncationSignals;
}

/**
 * Inspects one section response for output-cap truncation using both signals
 * and returns the cleaned text alongside the verdict.
 *
 * The text is stripped unconditionally when the placeholder is present — a
 * placeholder is never legitimate content, regardless of the finish reason.
 */
export function detectTruncation(text: string, finishReason?: string | null): TruncationDetection {
  const placeholder = containsTruncationPlaceholder(text);
  const byFinishReason = isTruncationFinishReason(finishReason);
  return {
    text: placeholder ? stripTruncationPlaceholder(text) : text,
    truncated: placeholder || byFinishReason,
    ...(typeof finishReason === "string" && finishReason.length > 0
      ? { reason: finishReason }
      : {}),
    signals: { finishReason: byFinishReason, placeholder },
  };
}

/**
 * Combine the verdicts of two calls when EITHER call's output can end up in the
 * kept text (a draft plus an accepted refine pass). Truncation is sticky: a cut
 * in either call means the kept section may be incomplete.
 */
export function mergeTruncation(
  a: TruncationDetection,
  b: TruncationDetection,
): TruncationDetection {
  const reason = a.signals.finishReason ? a.reason : b.reason;
  return {
    text: b.text,
    truncated: a.truncated || b.truncated,
    ...(reason ? { reason } : {}),
    signals: {
      finishReason: a.signals.finishReason || b.signals.finishReason,
      placeholder: a.signals.placeholder || b.signals.placeholder,
    },
  };
}

/**
 * Human-readable detail for the degraded-output warning, naming which signal(s)
 * fired so an operator can tell a mid-sentence cut from a substituted body.
 */
export function describeTruncation(detection: TruncationDetection): string {
  const parts: string[] = [];
  if (detection.signals.finishReason) {
    parts.push(`provider finish reason "${detection.reason ?? "length"}"`);
  }
  if (detection.signals.placeholder) parts.push("gateway max-tokens placeholder in output");
  return parts.length > 0 ? parts.join(" + ") : "unknown truncation signal";
}
