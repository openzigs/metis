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
 * `JSON.parse` in order and the first that parses wins — unless a JSON token
 * follows it (punctuation, or the opening of another value), which is a
 * structural divergence and not commentary.
 *
 * Linear by construction: every character is visited once by the scan, and the
 * spans passed to `JSON.parse` are disjoint, so parsing is bounded by the input
 * length too. In particular an unbalanced prefix (`{{{{…`, or an object cut off
 * by the output cap) yields NO span — the scan never restarts from an inner
 * brace, which is what would make it quadratic, and which would also return an
 * inner fragment of a truncated answer as though it were the answer.
 */

export type BalancedJsonResult = { found: true; value: unknown } | { found: false };

const NOT_FOUND: BalancedJsonResult = { found: false };

/**
 * Parse the first top-level balanced `{…}` span in `text` that is valid JSON.
 *
 * @param leadingOnly consider only a span that starts at index 0 — used when
 *   the text itself begins with `{`, where the leading object is the answer and
 *   anything after it is commentary.
 */
export function parseFirstBalancedJsonObject(
  text: string,
  { leadingOnly = false }: { leadingOnly?: boolean } = {},
): BalancedJsonResult {
  let start = -1;
  let depth = 0;
  let inString = false;
  const from = text.indexOf("{");
  if (from < 0 || (leadingOnly && from !== 0)) return NOT_FOUND;

  for (let i = from; i < text.length; i++) {
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
        if (couldBeJsonObject(text, start)) {
          let value: unknown;
          let parsed = false;
          try {
            value = JSON.parse(text.slice(start, i + 1));
            parsed = true;
          } catch {
            // Balanced but not JSON — keep scanning.
          }
          if (parsed) {
            // What follows decides whether this object is the answer. Prose is
            // commentary. A JSON token means the model closed the object
            // EARLY and kept writing it (`{"findings":[…]}, {…}]}` — observed
            // on long agent answers): accepting the leading part would drop
            // the rest silently, where failing sends it to repair or re-prompt.
            return continuesStructurally(text, i + 1) ? NOT_FOUND : { found: true, value };
          }
        }
        if (leadingOnly) return NOT_FOUND;
      }
    }
  }
  return NOT_FOUND;
}

/**
 * A JSON object's first token after `{` is a `"` (a key) or `}` (empty). Prose
 * braces (`{like this}`, `if (x) { return }`) almost never pass, which spares
 * them a `JSON.parse` that would throw — an exception per span is linear but
 * costs microseconds each, and a long answer full of code can carry thousands.
 */
function couldBeJsonObject(text: string, start: number): boolean {
  const ch = nextTokenCode(text, start + 1);
  return ch === 0x22 || ch === 0x7d;
}

/**
 * True when the first token at or after `from` is one JSON itself could
 * continue with: `,` `]` `}` `:` — or `{` `[` `"`, the start of a sibling
 * value. The second group matters as much as the first: a model that closes
 * its object early does not always write the comma
 * (`{"findings":[{…}]}\n{…}]}`), and accepting the leading object there drops
 * the remaining findings just as silently.
 */
function continuesStructurally(text: string, from: number): boolean {
  const ch = nextTokenCode(text, from);
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

/** Char code of the first non-whitespace character at or after `from`, or -1. */
function nextTokenCode(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09) continue;
    return ch;
  }
  return -1;
}
