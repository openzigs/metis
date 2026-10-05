/**
 * #751 — recover the COMPLETE prefix of a synthesis reply that the output cap
 * cut off mid-JSON.
 *
 * A thinking model (DeepSeek `deepseek-flash`) spends its reasoning from the
 * same `max_tokens` as its answer, so a large requirement set arrives as
 * `{"summary": …, "requirements": [ {…}, {…}, {"ty` — and `JSON.parse` rejects
 * all of it. Every requirement before the cut is nevertheless whole. This
 * module walks the reply structurally and returns those elements, so the caller
 * can keep them and ask the model only for the findings they do not cover.
 *
 * Deliberately a scanner, not a "close the open brackets and re-parse" repair:
 * the element being written when the cap fired is incomplete by definition,
 * and repairing it would invent a truncated title or a half-list of acceptance
 * criteria and present it as the model's answer. Only elements whose closing
 * brace was actually emitted are returned.
 *
 * Linear in the input, with no regex over the untrusted body: the reply can be
 * tens of kilobytes of model output, and #1253/#1260 measured quadratic
 * backtracking on exactly this truncated shape.
 */

export interface SalvagedSynthesis {
  /** The top-level `summary` string, when it was emitted whole. */
  summary?: string;
  /** Every `requirements[]` element that was emitted whole and parses as JSON. Unvalidated. */
  requirements: unknown[];
  /** `true` when the top-level object closed — i.e. the reply was not cut off. */
  complete: boolean;
}

const isWs = (c: string | undefined): boolean =>
  c === " " || c === "\n" || c === "\r" || c === "\t";

function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i])) i++;
  return i;
}

/** Index just past the closing quote of the string opening at `i`, or -1 if unterminated. */
function scanString(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === '"') return j + 1;
  }
  return -1;
}

/**
 * Index just past the JSON value starting at `i`, or -1 when the input ends
 * first. Objects and arrays are matched by depth, skipping string contents, so
 * a `}` inside a title cannot close anything. Bare primitives run to the next
 * delimiter.
 */
function scanValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return scanString(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (d === '"') {
        const end = scanString(s, j);
        if (end < 0) return -1;
        j = end - 1;
      } else if (d === "{" || d === "[") {
        depth++;
      } else if (d === "}" || d === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  let j = i;
  while (j < s.length && s[j] !== "," && s[j] !== "}" && s[j] !== "]" && !isWs(s[j])) j++;
  // A primitive that runs into end-of-input may itself be cut (`tru`, `12`).
  return j < s.length ? j : -1;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Collect the whole elements of the array opening at `i`. Returns the index past it, or -1. */
function scanRequirements(s: string, i: number, out: unknown[]): number {
  let j = i + 1;
  for (;;) {
    j = skipWs(s, j);
    if (j >= s.length) return -1;
    if (s[j] === "]") return j + 1;
    if (s[j] === ",") {
      j++;
      continue;
    }
    const end = scanValue(s, j);
    if (end < 0) return -1;
    const parsed = tryParse(s.slice(j, end));
    // A complete-but-malformed element is skipped, not fatal: its neighbours
    // were written independently and are still the model's own answer.
    if (parsed.ok) out.push(parsed.value);
    j = end;
  }
}

/**
 * Salvage the whole `summary` and `requirements[]` elements from a possibly
 * truncated synthesis reply. Never throws; returns no requirements when
 * nothing whole can be found.
 */
export function salvageSynthesisPrefix(raw: string): SalvagedSynthesis {
  const result: SalvagedSynthesis = { requirements: [], complete: false };
  // Skips a fence or prose preamble the same way `extractJsonObject` does.
  const start = raw.indexOf("{");
  if (start < 0) return result;
  let i = start + 1;
  for (;;) {
    i = skipWs(raw, i);
    if (i >= raw.length) return result;
    if (raw[i] === "}") {
      result.complete = true;
      return result;
    }
    if (raw[i] === ",") {
      i++;
      continue;
    }
    if (raw[i] !== '"') return result;
    const keyEnd = scanString(raw, i);
    if (keyEnd < 0) return result;
    const key = tryParse(raw.slice(i, keyEnd));
    i = skipWs(raw, keyEnd);
    if (raw[i] !== ":") return result;
    i = skipWs(raw, i + 1);
    if (i >= raw.length) return result;

    if (key.ok && key.value === "requirements" && raw[i] === "[") {
      const end = scanRequirements(raw, i, result.requirements);
      if (end < 0) return result;
      i = end;
      continue;
    }
    const end = scanValue(raw, i);
    if (end < 0) return result;
    if (key.ok && key.value === "summary") {
      const summary = tryParse(raw.slice(i, end));
      if (summary.ok && typeof summary.value === "string") result.summary = summary.value;
    }
    i = end;
  }
}
