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

// ---------------------------------------------------------------------------
// #166 — repetition loops
// ---------------------------------------------------------------------------

/** A reply that ran to the cap repeating itself, and the part worth keeping. */
export interface RepetitionLoop {
  /** The reply up to the loop's second copy of its repeated unit, whole lines only. */
  usablePrefix: string;
  /** The repeated unit (case and whitespace normalised). */
  unit: string;
  /** How many times the unit occurs in the inspected tail. */
  repeats: number;
}

/** Characters at the end of a reply inspected for a loop. */
const LOOP_TAIL_CHARS = 4_000;
/** Non-empty lines at the end of the tail compared for a line-level loop. */
const LOOP_TAIL_LINES = 12;
/** At most this many distinct lines among them reads as a loop. */
const LOOP_MAX_DISTINCT_LINES = 3;
/** A last line at least this long is read for a loop within it. */
const LOOP_LONG_LINE_CHARS = 1_000;
/** Words per n-gram for a loop within long lines. */
const LOOP_NGRAM = 6;
/** An n-gram repeated at least this often, covering at least half the tail's words. */
const LOOP_MIN_REPEATS = 6;

// Digits are NOT normalised: a numbered listing — copybook fields, a column
// table, "- FIELD-1 … FIELD-40" — is legitimate output a cap can cut off, and
// read as a loop it would lose every file the model had not reached yet (PR
// #281 review). A loop repeats its text; a listing does not.
const normaliseLoopText = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * #166 — detect a reply cut off at the output cap because the model was
 * repeating itself (the Phase-1 NOTES runaways: up to 28K characters of the
 * same aside). A bigger cap does not fix that, so a caller that cannot split
 * the input further keeps {@link RepetitionLoop.usablePrefix} instead of asking
 * again.
 *
 * Two linear checks on the last {@link LOOP_TAIL_CHARS} characters, compared
 * as written (case and whitespace aside — never digits, so a numbered listing
 * cut off at the cap is not a loop): the last
 * {@link LOOP_TAIL_LINES} non-empty lines hold at most
 * {@link LOOP_MAX_DISTINCT_LINES} distinct lines, or — in a last line of
 * {@link LOOP_LONG_LINE_CHARS}+ characters — one word {@link LOOP_NGRAM}-gram
 * occurs {@link LOOP_MIN_REPEATS}+ times and covers half its words (a loop
 * inside one long line). `null` otherwise —
 * including for a reply simply cut off mid-list, which is not a loop.
 */
export function detectRepetitionLoop(text: string): RepetitionLoop | null {
  const tail = text.slice(-LOOP_TAIL_CHARS);
  const lines = tail
    .split("\n")
    .map(normaliseLoopText)
    .filter((l) => l.length > 0);
  const last = lines.slice(-LOOP_TAIL_LINES);
  if (last.length >= LOOP_TAIL_LINES && new Set(last).size <= LOOP_MAX_DISTINCT_LINES) {
    const counts = new Map<string, number>();
    for (const l of last) counts.set(l, (counts.get(l) ?? 0) + 1);
    const [unit, repeats] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const loopLines = new Set(last);
    return {
      usablePrefix: prefixBeforeSecond(
        text,
        (l) => (normaliseLoopText(l) === unit ? 1 : 0),
        (l) => loopLines.has(normaliseLoopText(l)),
      ),
      unit,
      repeats,
    };
  }
  // A loop inside one line: only a long last line is read for one, so a list
  // whose items share a template phrase is never mistaken for a loop.
  const lastLine = lines.at(-1) ?? "";
  if (lastLine.length < LOOP_LONG_LINE_CHARS) return null;
  const words = lastLine.split(" ");
  if (words.length < LOOP_NGRAM * LOOP_MIN_REPEATS) return null;
  const grams = new Map<string, number>();
  for (let i = 0; i + LOOP_NGRAM <= words.length; i++) {
    const g = words.slice(i, i + LOOP_NGRAM).join(" ");
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  const [unit, repeats] = [...grams.entries()].sort((a, b) => b[1] - a[1])[0];
  if (repeats < LOOP_MIN_REPEATS || repeats * LOOP_NGRAM < words.length / 2) return null;
  return {
    usablePrefix: prefixBeforeSecond(
      text,
      (l) => countIn(l, unit),
      (l) => countIn(l, unit) > 0,
    ),
    unit,
    repeats,
  };
}

/**
 * `text` up to (not including) the line where the repeated unit occurs for the
 * second time (`occurrences` counts it per line), so one copy is kept and a
 * line that holds it several times — a loop inside one line — is dropped. Always whole lines, trailing blank
 * lines trimmed. Counting starts at the trailing run of loop lines (`inLoop`),
 * so a copy of the unit earlier in the reply — a "- None." closing an earlier
 * section — does not cut away the facts between it and the loop.
 */
function prefixBeforeSecond(
  text: string,
  occurrences: (line: string) => number,
  inLoop: (line: string) => boolean,
): string {
  const lines = text.split("\n");
  let start = lines.length;
  while (start > 0 && (lines[start - 1].trim() === "" || inLoop(lines[start - 1]))) start--;
  let seen = 0;
  let cut = lines.length;
  for (let i = start; i < lines.length; i++) {
    seen += occurrences(lines[i]);
    if (seen >= 2) {
      cut = i;
      break;
    }
  }
  return lines.slice(0, cut).join("\n").trimEnd();
}

/** Occurrences of `unit` in `line` once normalised. */
function countIn(line: string, unit: string): number {
  const norm = normaliseLoopText(line);
  let n = 0;
  for (let at = norm.indexOf(unit); at >= 0; at = norm.indexOf(unit, at + unit.length)) n++;
  return n;
}
