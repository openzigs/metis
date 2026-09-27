/**
 * Logical-line joining for the line-oriented rule miners (#170).
 *
 * Every `*-rule-miner.ts` reads source one physical line at a time, so a
 * condition formatted across lines —
 *
 * ```ts
 * if (
 *   athlete.thresholdPower === undefined ||
 *   athlete.thresholdPower <= 0
 * ) throw new RangeError("...");
 * ```
 *
 * — yielded no rule, or only a fragment of one. {@link joinLogicalLine} gives a
 * miner the whole construct as ONE logical line (the physical lines trimmed,
 * comment-stripped and joined with a space), so the miner's existing
 * single-line patterns apply to it unchanged. The miner anchors the rule at the
 * first physical line and keeps iterating physical lines as before, so every
 * rule a single-line pass finds is still found.
 *
 * Why a joiner and not a tree-sitter statement pass: the miners are synchronous
 * and run on symbol slices that need not parse on their own; a tree-sitter pass
 * would make them async (WASM boot) and change their callers. SAS and SQL have
 * no tree-sitter grammar here at all.
 *
 * Complexity / ReDoS: the scan is a single left-to-right pass over at most
 * {@link MAX_CONTINUATION_LINES} lines and {@link MAX_LOGICAL_CHARS} characters,
 * with no regular expression — so joining from EVERY line of an N-line file is
 * O(N) with a constant bound, and the miners' own patterns only ever see a
 * logical line of bounded length. A construct that does not close inside the
 * bound yields `null`, and the miner falls back to its single-line behaviour.
 */

/** Most physical lines one logical line may span (the header included). */
export const MAX_CONTINUATION_LINES = 12;
/** Most characters one logical line may hold; longer constructs are not joined. */
export const MAX_LOGICAL_CHARS = 4000;

export interface LogicalLine {
  /** The joined text: each physical line trimmed and comment-stripped, space-separated. */
  text: string;
  /** Index (into the `lines` array) of the last physical line consumed. */
  end: number;
}

export interface JoinOptions {
  /** Line-comment introducer outside strings: `//` (C family), `#` (Python), `--` (SQL). */
  comment?: "//" | "#" | "--";
  /** Python: a line ending in `\` continues onto the next line. */
  backslash?: boolean;
  /**
   * Keep joining while this holds, even at bracket depth 0 — for operator
   * continuations (`a &&` / `? b` / `?: throw`). Receives the last consumed
   * physical line and the next one, both trimmed and comment-stripped.
   */
  continues?: (last: string, next: string) => boolean;
  /**
   * Keep joining UNTIL the joined text satisfies this — for keyword-terminated
   * statements (SAS `;`, SQL `THEN`). If the bound is reached first the join
   * fails (`null`). Must be a linear-time test.
   */
  until?: (joined: string) => boolean;
}

interface ScanState {
  /** Net `(` / `[` depth, plus `{` opened INSIDE parentheses (a lambda). */
  depth: number;
}

/**
 * Scan one physical line: update bracket depth and return the line with its
 * trailing comment removed. Strings (`"`, `'`, `` ` ``, backslash escapes) are
 * skipped; an unterminated string ends at the line end. A `{` counts only when
 * already inside a bracket, so a block-opening brace after a closed condition
 * (`if (a) {`) does not keep the join going, while a lambda inside a condition
 * (`if (xs.any { it > 0 })`) does.
 */
function scanLine(line: string, state: ScanState, comment: JoinOptions["comment"]): string {
  let quote = "";
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (quote) {
      if (ch === "\\") k++;
      else if (ch === quote) quote = "";
      continue;
    }
    // Outside a string a backslash is an escape inside a regex literal
    // (`/^https?:\/\//`): skip the escaped character so `\/\/` is not read as
    // a comment and `\(` is not read as a bracket.
    if (ch === "\\") {
      k++;
      continue;
    }
    if (comment && ch === comment[0] && line.startsWith(comment, k)) {
      return line.slice(0, k);
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[") state.depth++;
    else if (ch === ")" || ch === "]") state.depth = Math.max(0, state.depth - 1);
    else if (ch === "{" && state.depth > 0) state.depth++;
    else if (ch === "}" && state.depth > 0) state.depth--;
  }
  return line;
}

/**
 * Join the construct that starts on `lines[start]` into one logical line.
 *
 * Joining continues while any bracket opened so far is unclosed, while a
 * Python line ends in `\`, while `opts.continues` says the next line carries on
 * the expression, or until `opts.until` is satisfied.
 *
 * Returns `null` when nothing needs joining (the construct is complete on its
 * own line), or when it does not complete within {@link MAX_CONTINUATION_LINES}
 * lines / {@link MAX_LOGICAL_CHARS} characters — the caller then keeps its
 * single-line behaviour.
 */
export function joinLogicalLine(
  lines: readonly string[],
  start: number,
  opts: JoinOptions = {},
): LogicalLine | null {
  if (lines[start] === undefined || lines[start].length > MAX_LOGICAL_CHARS) return null;
  const state: ScanState = { depth: 0 };
  const parts: string[] = [];
  let length = 0;
  const last = Math.min(lines.length - 1, start + MAX_CONTINUATION_LINES - 1);

  for (let j = start; j <= last; j++) {
    let part = scanLine(lines[j], state, opts.comment).trim();
    const backslash = opts.backslash === true && part.endsWith("\\");
    if (backslash) part = part.slice(0, -1).trimEnd();
    if (part.length > 0) {
      parts.push(part);
      length += part.length + 1;
      if (length > MAX_LOGICAL_CHARS) return null;
    }
    const text = parts.join(" ");
    const unmet = opts.until !== undefined && !opts.until(text);
    let more = state.depth > 0 || backslash || unmet;
    if (!more && opts.continues && j + 1 < lines.length) {
      const next = stripComment(lines[j + 1], opts.comment).trim();
      more = next.length > 0 && opts.continues(part, next);
    }
    if (!more) return j === start ? null : { text, end: j };
  }
  // Ran out of lines (or the bound) with the construct still open.
  if (state.depth > 0 || (opts.until !== undefined && !opts.until(parts.join(" ")))) return null;
  // Only an operator continuation was still pending: what we have is complete.
  return last === start ? null : { text: parts.join(" "), end: last };
}

/** A line with its trailing comment removed (strings respected). */
export function stripComment(line: string, comment: JoinOptions["comment"]): string {
  return scanLine(line, { depth: 0 }, comment);
}

/**
 * Whether the parentheses/brackets opened on `line` stay open at its end —
 * the cheap test a miner uses before paying for a join.
 */
export function opensBracket(line: string, comment: JoinOptions["comment"] = "//"): boolean {
  if (line.length > MAX_LOGICAL_CHARS) return false;
  const state: ScanState = { depth: 0 };
  scanLine(line, state, comment);
  return state.depth > 0;
}

/**
 * A binary/boolean operator at the end of `last` or the start of `next` —
 * the shape of an expression continued on the following line in the C family
 * (`a &&` ⏎ `b`, `x > 0` ⏎ `? y : z`, `foo` ⏎ `?: throw ...`).
 */
export function operatorContinues(last: string, next: string): boolean {
  return TRAILING_OPERATOR_RE.test(last) || LEADING_OPERATOR_RE.test(next);
}

// Anchored single-token tests — no unbounded quantifier can backtrack.
const TRAILING_OPERATOR_RE = /(?:&&|\|\||[?:=<>+\-*/%,(]|\?:)$/;
const LEADING_OPERATOR_RE =
  /^(?:&&|\|\||\?\??|:|\.(?!\.)|[<>]=?|[=!]==?|\+|-(?!-)|\*|\/(?![/*])|%)/;
