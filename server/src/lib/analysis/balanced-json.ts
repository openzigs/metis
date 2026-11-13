/**
 * #1002 — balanced-brace extraction of a JSON object from model text.
 *
 * `extractJsonObject` used to recover an object padded with prose by slicing
 * from the first `{` to the LAST `}`. That only works when nothing after the
 * object contains a brace: a deep-dive draft followed by "then close the `}`
 * block" produced `Unexpected non-whitespace character after JSON at position
 * 2019`, and the user saw that text.
 *
 * This scanner walks the text ONCE, tracking brace depth and — while inside an
 * object — JSON string state and backslash escapes, so a `}` inside a string
 * value does not close anything. Each top-level `{…}` span is handed to
 * `JSON.parse` in order. A span followed by a JSON token (punctuation, or the
 * opening of another value) is a structural divergence, not commentary, and
 * nothing is returned.
 *
 * #1355 — the answer is the SOLE object that parses, not the first. "First
 * parseable span wins" read a model's preamble example (`The shape is
 * {"requirements": []}. Here it is: {"requirements": [ … ]}`) as its answer:
 * a well-formed, schema-valid, wrong result. Picking the LAST span instead only
 * moves the trap to an example written after the answer. With no schema at this
 * layer, two DIFFERENT objects cannot be told apart, so the scan reports
 * `ambiguous` and the caller fails — which sends the reply to the existing
 * re-prompt (`requestStructuredVerdict`) or repair (`repairAgentJson`) carrying
 * a message that says what was wrong. None of these is a rival (PR #1409
 * review): the same object written twice (key order aside), an empty `{}`
 * ("return {} when there are none"), and an object that is an element of an
 * array in the prose. Once an answer is held, nothing discards it as
 * not-found: a later span either is ignored or makes the reply ambiguous.
 *
 * #2407 — that holds when the reply STARTS with an object, too. "The leading
 * object is the answer" kept a model's short first object when it went on
 * "Correction: the object above is incomplete. Here is the full response." and
 * wrote a second, full one: the document reader lost whole batches of
 * sections while reporting them read. Two different objects are ambiguous
 * wherever the first one stands, and so is an answer followed by an object
 * that is opened and never closed (the correction, cut off by the output cap).
 *
 * Linear by construction: every character is visited once by the scan, and the
 * spans passed to `JSON.parse` are disjoint, so parsing is bounded by the input
 * length too. In particular an unbalanced prefix (`{{{{…`, or an object cut off
 * by the output cap) yields NO span — the scan never restarts from an inner
 * brace, which is what would make it quadratic, and which would also return an
 * inner fragment of a truncated answer as though it were the answer.
 */

export type BalancedJsonResult =
  | { found: true; value: unknown }
  /** `ambiguous` — two or more DIFFERENT top-level objects parsed (#1355). */
  | { found: false; ambiguous?: true };

/**
 * #1422 — the work one call did, counted in characters, so a test can prove the
 * scan linear without a stopwatch. A wall-clock ratio measured the machine as
 * much as the code: 56 ms against a 49 ms bound in a full `pnpm test` fan-out,
 * and green alone. Counts do not move with load.
 *
 * Every loop in this module adds to one field, so a change that makes any of
 * them revisit input — restarting the scan from an inner `{`, walking back past
 * the whitespace before a span, re-canonicalising a held answer — shows up as
 * work that grows faster than the input.
 *
 * RULE: any new loop over `text` — or any call that walks it, such as
 * `slice`, `indexOf` or `JSON.parse` on a span — must add what it visits to
 * one of these fields. Uncounted work is invisible to the counting tests; only
 * the coarse CPU-clock backstop in `balanced-json.test.ts` would catch it.
 */
export interface BalancedJsonWork {
  /** Characters the main scan stepped over. */
  scanned: number;
  /** Characters handed to `JSON.parse`. */
  parsed: number;
  /** Characters walked looking for the token next to a span. */
  walked: number;
  /** Characters of canonical JSON produced to compare two spans. */
  canonicalised: number;
}

const NOT_FOUND: BalancedJsonResult = { found: false };
const AMBIGUOUS: BalancedJsonResult = { found: false, ambiguous: true };

/**
 * #1355 — the error a caller raises on an `ambiguous` result. Worded for the
 * model as much as for the log: the re-prompt and the repair turn both quote
 * the parse error back, and this one says how to fix the reply.
 */
export const AMBIGUOUS_JSON_MESSAGE =
  "Model response contained more than one different JSON object, so which one is the answer " +
  "cannot be told; reply with only the one JSON object that is the answer, unchanged, and " +
  "drop the others (examples, illustrations, and an earlier version you then corrected)";

/**
 * Parse the top-level balanced `{…}` span in `text` that is valid JSON —
 * provided it is the only one (or every other one is the same object).
 *
 * @param leadingOnly the answer must be a span that starts at index 0 — used
 *   when the text itself begins with `{`. Prose after it is commentary; a
 *   different object after it makes the reply ambiguous (#2407).
 * @param onWork test instrumentation (#1422): receives the call's work counts
 *   once, as it returns. Production callers pass nothing; the counting itself
 *   (integer increments on one object per call) is within benchmark noise of
 *   the uninstrumented scan on 400 KB inputs.
 */
export function parseBalancedJsonObject(
  text: string,
  {
    leadingOnly = false,
    onWork,
  }: { leadingOnly?: boolean; onWork?: (work: BalancedJsonWork) => void } = {},
): BalancedJsonResult {
  const work: BalancedJsonWork = { scanned: 0, parsed: 0, walked: 0, canonicalised: 0 };
  try {
    return scan(text, leadingOnly, work);
  } finally {
    onWork?.(work);
  }
}

function scan(text: string, leadingOnly: boolean, work: BalancedJsonWork): BalancedJsonResult {
  let start = -1;
  let depth = 0;
  let inString = false;
  let answer: { value: unknown; canonical?: string } | null = null;
  let elementBeforeAnswer = false;
  const from = text.indexOf("{");
  if (from < 0 || (leadingOnly && from !== 0)) return NOT_FOUND;

  for (let i = from; i < text.length; i++) {
    work.scanned++;
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c /* \ */) i++;
      else if (ch === 0x22 /* " */) inString = false;
      continue;
    }
    if (ch === 0x22 /* " */) {
      // Quotes in the prose BETWEEN objects are not JSON strings.
      if (depth > 0) inString = true;
    } else if (ch === 0x7b /* { */) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === 0x7d /* } */ && depth > 0) {
      depth--;
      if (depth === 0) {
        if (couldBeJsonObject(text, start, work)) {
          let value: unknown;
          let parsed = false;
          try {
            work.parsed += i + 1 - start;
            value = JSON.parse(text.slice(start, i + 1));
            parsed = true;
          } catch {
            // Balanced but not JSON — keep scanning.
          }
          if (parsed) {
            if (isArrayElement(text, start, i + 1, work)) {
              // PR #1409 review — an element of an array in the prose
              // (`List: [{"a":1}, {"a":2}]`) AFTER the answer is commentary,
              // not a rival. Recognised only when BOTH opened by `[`/`,` and
              // closed by `,`/`]`, so a prose comma (`e.g., {…}`) still
              // reaches the checks below. BEFORE any answer is held it may BE
              // the answer (`Here:\n[{…}]\nIf none, use {"requirements":[]}`,
              // or `Sure, {…}, and an empty one looks like {…}`): taking the
              // later object would be a schema-valid empty result, so a reply
              // with such a span and a later answer is ambiguous (cycle-2 review).
              if (answer === null) elementBeforeAnswer = true;
            } else if (continuesStructurally(text, i + 1, work)) {
              // What follows decides whether this object is the answer. Prose
              // is commentary. A JSON token means the model closed the object
              // EARLY and kept writing it (`{"findings":[…]}, {…}]}` —
              // observed on long agent answers): accepting the leading part
              // would drop the rest silently, where failing sends it to repair
              // or re-prompt. Once an answer is held, such a span is a rival
              // that may be the real answer cut short — never a reason to
              // discard the held one as NOT_FOUND (PR #1409 review).
              return answer === null ? NOT_FOUND : AMBIGUOUS;
            } else if (leadingOnly && answer !== null && isEmptyObject(answer.value)) {
              // #2407 review — a LEADING `{}` and a different, non-empty object
              // after it (`{}\n\nNo requirements found. A non-empty reply would
              // look like {"requirements":[…]}`). Main returned the `{}`;
              // holding the later object returns the example: a fabricated
              // answer, which is worse than a re-prompt. Neither can be told
              // to be the answer. A second `{}` is the same object.
              if (!isEmptyObject(value)) return AMBIGUOUS;
            } else if (answer === null || isEmptyObject(answer.value)) {
              // #2407 — under `leadingOnly` the leading object is held like any
              // other answer, not returned at once: a model that writes a short
              // object, then "Correction: the object above is incomplete" and a
              // second, full one, lost whole batches of sections to the first.
              // PR #1409 review — `{}` ("return {} when there are none") is
              // neither an answer to prefer over a real one nor a rival to it.
              answer = { value };
            } else if (!isEmptyObject(value)) {
              // #1355 — a second object. Compared canonically (keys sorted, so
              // a key-order difference is the same object), and only now, so
              // the common single-object reply never pays for it. Each span is
              // canonicalised at most once: still linear.
              // `canonicalJson` recurses; an object nested thousands deep
              // overflows the stack, and two objects that cannot be compared
              // cannot be told to be the same (cycle-2 review).
              try {
                answer.canonical ??= canonicalJson(answer.value, work);
                if (canonicalJson(value, work) !== answer.canonical) return AMBIGUOUS;
              } catch {
                return AMBIGUOUS;
              }
            }
          }
        }
        if (leadingOnly && answer === null) return NOT_FOUND;
      }
    }
  }
  if (answer === null) return NOT_FOUND;
  // #2407 — an object opened after the answer and never closed: the reply
  // stopped partway through a second object, which may be the corrected
  // answer cut off by the output cap. The held one is not safe to return.
  // #2407 review — only when it opens with a key (`{ "statements":`): a brace
  // in trailing prose or code (`the opening brace "{" is required.`) also
  // leaves the depth above zero, and is commentary, not a cut-off object.
  if (depth > 0 && opensWithKey(text, start, work)) return AMBIGUOUS;
  return elementBeforeAnswer ? AMBIGUOUS : { found: true, value: answer.value };
}

/**
 * A JSON object's first token after `{` is a `"` (a key) or `}` (empty). Prose
 * braces (`{like this}`, `if (x) { return }`) almost never pass, which spares
 * them a `JSON.parse` that would throw — an exception per span is linear but
 * costs microseconds each, and a long answer full of code can carry thousands.
 */
function couldBeJsonObject(text: string, start: number, work: BalancedJsonWork): boolean {
  const ch = nextTokenCode(text, start + 1, work);
  return ch === 0x22 || ch === 0x7d;
}

/**
 * True when the `{` at `start` is followed by a complete JSON key and its `:`
 * (`{ "statements" :`) — what an object cut off after its first key looks
 * like, and what a quoted brace in prose (`"{" is required`) does not. Called
 * once, at the end of the scan, over text after the last top-level `{`: linear.
 */
function opensWithKey(text: string, start: number, work: BalancedJsonWork): boolean {
  let i = start + 1;
  for (; i < text.length && isJsonWhitespace(text.charCodeAt(i)); i++) work.walked++;
  if (text.charCodeAt(i) !== 0x22 /* " */) return false;
  for (i++; i < text.length; i++) {
    work.walked++;
    const ch = text.charCodeAt(i);
    if (ch === 0x5c /* \ */) i++;
    else if (ch === 0x22 /* " */) return nextTokenCode(text, i + 1, work) === 0x3a; /* : */
    // A JSON string never spans a raw line break: this quote opened prose.
    else if (ch === 0x0a || ch === 0x0d) return false;
  }
  return false;
}

function isJsonWhitespace(ch: number): boolean {
  return ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09;
}

/**
 * True when the first token at or after `from` is one JSON itself could
 * continue with: `,` `]` `}` `:` — or `{` `[` `"`, the start of a sibling
 * value. The second group matters as much as the first: a model that closes
 * its object early does not always write the comma
 * (`{"findings":[{…}]}\n{…}]}`), and accepting the leading object there drops
 * the remaining findings just as silently.
 */
function continuesStructurally(text: string, from: number, work: BalancedJsonWork): boolean {
  const ch = nextTokenCode(text, from, work);
  return (
    ch === 0x2c /* , */ ||
    ch === 0x5d /* ] */ ||
    ch === 0x7d /* } */ ||
    ch === 0x3a /* : */ ||
    ch === 0x7b /* { */ ||
    ch === 0x5b /* [ */ ||
    ch === 0x22 /* " */
  );
}

/** `{}` — never the answer when there is another object, and never its rival. */
function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** JSON with every object's keys sorted, so key order does not count as a difference. */
function canonicalJson(value: unknown, work: BalancedJsonWork): string {
  const canonical = JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
  work.canonicalised += canonical.length;
  return canonical;
}

/**
 * True when the span ending before `end` and starting at `start` sits between
 * `[`/`,` and `,`/`]` — an element of an array written in the prose. Only the
 * whitespace directly around the span is walked, and those runs are disjoint
 * between spans, so the scan stays linear.
 */
function isArrayElement(text: string, start: number, end: number, work: BalancedJsonWork): boolean {
  const after = nextTokenCode(text, end, work);
  if (after !== 0x2c /* , */ && after !== 0x5d /* ] */) return false;
  const before = prevTokenCode(text, start - 1, work);
  return before === 0x5b /* [ */ || before === 0x2c; /* , */
}

/** Char code of the last non-whitespace character at or before `from`, or -1. */
function prevTokenCode(text: string, from: number, work: BalancedJsonWork): number {
  for (let i = from; i >= 0; i--) {
    work.walked++;
    const ch = text.charCodeAt(i);
    if (ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09) continue;
    return ch;
  }
  return -1;
}

/** Char code of the first non-whitespace character at or after `from`, or -1. */
function nextTokenCode(text: string, from: number, work: BalancedJsonWork): number {
  for (let i = from; i < text.length; i++) {
    work.walked++;
    const ch = text.charCodeAt(i);
    if (ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09) continue;
    return ch;
  }
  return -1;
}
