/**
 * Rust business rule miner (#161).
 *
 * Rust services state their business rules as a validation-and-error surface
 * that is easy for an LLM to skim past in a dense source dump. This miner
 * surfaces it deterministically for Phase 1 of docs generation:
 *
 *   1. Preconditions — `assert!(cond, "msg")`, `assert_eq!` / `assert_ne!`,
 *      `debug_assert!`, and `ensure!(cond, Error)` (anyhow / snafu style).
 *   2. Guard clauses — an `if cond {` (no parentheses in Rust) whose body
 *      returns, yields `Err(...)`, or fails (`bail!`, `panic!`); `let ... else
 *      { return ... }` guards; `.ok_or(Error)` absence checks; and `if` that
 *      compares to a constant as a threshold branch, including `if`
 *      expressions (`let fee = if total > 50 { 0 } else { 5 };`).
 *   3. Failure modes — `panic!("msg")`, `bail!("msg")`, `unreachable!`,
 *      `return Err(Error::Kind)`.
 *   4. `match status { Status::Open => .., Status::A | Status::B => .. }` —
 *      dispatch on enum variants or literals; a guarded arm `t if t > 100 =>`
 *      is a threshold branch. `Some` / `None` / `Ok` / `Err` arms are
 *      destructuring, not state.
 *   5. Field validation attributes — `#[validate(range(min = 1))]`
 *      (`validator` crate) and `#[garde(...)]`.
 *   6. Constants — `const MAX_ITEMS: u32 = 50;`, `static RATE: f64 = 0.2;`.
 *
 * False-positive guard: an `if` whose body only logs (`info!`, `log::warn!`,
 * `println!`, `tracing::debug!`) is NOT a rule.
 *
 * Deterministic line-local passes (no LLM call). A condition that ends in an
 * operator or leaves a parenthesis open is read as one logical line (#170's
 * {@link joinLogicalLine}: at most 12 lines / 4,000 characters, no regex). A
 * `match` arm whose pattern continues with `|` on the next line is accumulated
 * for at most 12 lines. ReDoS: every regex is a literal keyed on a fixed token
 * with no two quantifiers able to match the same text; conditions, arguments
 * and arms are read by linear scans.
 */

import {
  joinLogicalLine,
  MAX_CONTINUATION_LINES,
  opensBracket,
  operatorContinues,
  stripComment,
} from "./rule-miner-continuation.js";
import {
  BODY_LOOKAHEAD,
  blankLiterals,
  blockBody,
  braceDelta,
  type BraceMinedRule,
  comparesToConstant,
  constantLabel,
  exitsAfterLogging,
  firstTopLevelBrace,
  isLiteralValue,
  isLoggingOnly,
  MAX_EXPR,
  MAX_RULES,
  renderGroupedRules,
  splitParen,
  splitTopLevel,
  stripQuotes,
  truncate,
} from "./rule-miner-brace-shared.js";

export type MinedRsRuleKind =
  "precondition" | "guard" | "throw" | "match-branch" | "annotation-validation" | "const";
export type MinedRsRule = BraceMinedRule<MinedRsRuleKind>;

// `assert!(` / `assert_eq!(` / `ensure!(` … — the head only.
const PRECONDITION_HEAD_RE =
  /(?:^|[^\w:])(assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne|ensure)!\s*\(/;
// `panic!(` / `bail!(` / `unreachable!(` / `unimplemented!(`.
const FAIL_HEAD_RE = /(?:^|[^\w:])(panic|bail|unreachable|unimplemented)!\s*\(/;
// `return Err(` / a statement that starts with `Err(`.
const ERR_HEAD_RE = /^\s*(?:return\s+)?Err\s*\(/;
// `if <cond> {` at the start of a statement (`} else if` too); not `if let`.
const IF_HEAD_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s+(?!let\b)/;
// `let fee = if <cond> {` — an if EXPRESSION.
const IF_EXPR_HEAD_RE = /=\s*if\s+(?!let\b)/;
// `let <pattern> = <expr> else {` — the `else` is found with indexOf.
const LET_ELSE_HEAD_RE = /^\s*let\s/;
// `.ok_or(` / `.ok_or_else(` — an absence check that fails with an error.
const OK_OR_HEAD_RE = /\.ok_or(?:_else)?\s*\(/;
// `match <subject> {`.
const MATCH_HEAD_RE = /(?:^|[^\w.])match\s/;
// `#[validate(...)]` / `#[garde(...)]` — the attribute head.
const VALIDATE_ATTR_RE = /#\[\s*(validate|garde)\s*\(/;
// `[pub[(crate)]] const|static [mut] NAME: T = value;`
const CONST_RE =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:/;
const LOG_CALL_RE =
  /^\s*(?:(?:log|tracing)::)?(?:trace|debug|info|warn|error|e?println|e?print|dbg)!\s*[([{]/;
const EXIT_RE =
  /^\s*(?:return\b|Err\s*\(|(?:anyhow::)?bail!|panic!|unreachable!|(?:std::)?process::exit\s*\()/;
// A match arm continued on the next line: it ends in `|`, or the next starts with `|`.
const ARM_CONTINUES_RE = /\|$/;

/** Summary of a precondition macro's arguments: its condition and message. */
function preconditionSummary(macro: string, args: string): string {
  const parts = splitTopLevel(args, ",");
  if (macro.endsWith("_eq") || macro.endsWith("_ne")) {
    const op = macro.endsWith("_eq") ? "==" : "!=";
    const msg = parts[2]?.startsWith('"') ? `: ${truncate(stripQuotes(parts[2]), 120)}` : "";
    return `${macro}!(${truncate(`${parts[0] ?? ""} ${op} ${parts[1] ?? ""}`, 120)})${msg}`;
  }
  const second = parts[1] ?? "";
  const msg = second.startsWith('"')
    ? `: ${truncate(stripQuotes(second), 120)}`
    : second
      ? ` else ${truncate(second, 120)}`
      : "";
  return `${macro}!(${truncate(parts[0] ?? "", 120)})${msg}`;
}

/**
 * The text after an `if ` / `match ` keyword up to its block-opening `{`
 * (the first `{` outside brackets), or null when the brace is not in `text`.
 */
function headerUpToBrace(text: string, from: number): { cond: string; rest: string } | null {
  const brace = firstTopLevelBrace(text, from);
  if (brace < 0) return null;
  return { cond: text.slice(from, brace).trim(), rest: text.slice(brace + 1).trim() };
}

/**
 * Mine all rule-bearing Rust patterns from a source slice.
 *
 * @param source   Raw source text (a function body, a whole file, or any slice).
 * @param filePath Relative path — stored on each rule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name.
 * @param maxRules Most rules returned; docs-gen Phase 1 passes `Infinity`.
 */
export function mineRsRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
  maxRules: number = MAX_RULES,
): MinedRsRule[] {
  const rules: MinedRsRule[] = [];
  const lines = source.split("\n");
  const push = (kind: MinedRsRuleKind, expression: string, summary: string, i: number) => {
    // One line or dispatch block can yield several rules; the cap holds per rule.
    if (rules.length >= maxRules) return;
    rules.push({
      kind,
      expression: truncate(expression, MAX_EXPR),
      summary,
      filePath,
      line: baseLine + i,
      context,
    });
  };

  for (let i = 0; i < lines.length && rules.length < maxRules; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (
      line.length === 0 ||
      line.startsWith("//") ||
      line.startsWith("*") ||
      line.startsWith("/*")
    ) {
      continue;
    }
    const code = stripComment(line, "//").trim();
    const logical =
      opensBracket(raw) || operatorContinues(code, stripComment(lines[i + 1] ?? "", "//").trim())
        ? joinLogicalLine(lines, i, { comment: "//", continues: operatorContinues })
        : null;
    const stmt = logical ? logical.text : code;
    // Last physical line of the statement header, and — Allman style — the
    // line after it when that line opens the block with `{`.
    const headerEnd = logical ? logical.end : i;
    const allman = (lines[headerEnd + 1] ?? "").trim().startsWith("{");
    /** A header up to its `{`, or up to the end when the `{` opens the next line. */
    const header = (from: number): { cond: string; rest: string } | null =>
      headerUpToBrace(stmt, from) ?? (allman ? { cond: stmt.slice(from).trim(), rest: "" } : null);
    // Offsets found in `raw` map into `stmt` (which starts at the trimmed line).
    const indent = raw.length - raw.trimStart().length;
    const parenArgs = (afterOpenInRaw: number): { args: string; joined: boolean } | null => {
      const own = splitParen(raw, afterOpenInRaw);
      if (own) return { args: own.cond, joined: false };
      const joined = logical ? splitParen(logical.text, afterOpenInRaw - indent) : null;
      return joined ? { args: joined.cond, joined: true } : null;
    };

    // ---- 1. validation attributes ----
    const attr = VALIDATE_ATTR_RE.exec(raw);
    if (attr) {
      const args = parenArgs(attr.index + attr[0].length);
      if (args) {
        push(
          "annotation-validation",
          args.joined ? stmt : line,
          `Field validation (${attr[1]}): ${truncate(args.args, 140)}`,
          i,
        );
      }
      continue;
    }

    // ---- 2. constants ----
    const cMatch = CONST_RE.exec(raw);
    if (cMatch) {
      const eq = code.indexOf("=");
      const value =
        eq >= 0
          ? code
              .slice(eq + 1)
              .replace(/;$/, "")
              .trim()
          : "";
      if (isLiteralValue(value)) {
        push("const", line, `Constant \`${cMatch[1]}\` = ${truncate(value, 120)}`, i);
      }
      continue;
    }

    // ---- 3. preconditions ----
    const pHead = PRECONDITION_HEAD_RE.exec(raw);
    const pArgs = pHead ? parenArgs(pHead.index + pHead[0].length) : null;
    if (pHead && pArgs) {
      push(
        "precondition",
        pArgs.joined ? stmt : line,
        preconditionSummary(pHead[1], pArgs.args),
        i,
      );
      continue;
    }

    // ---- 4. failure modes ----
    const fHead = FAIL_HEAD_RE.exec(raw);
    if (fHead) {
      const fArgs = parenArgs(fHead.index + fHead[0].length);
      const first = fArgs ? (splitTopLevel(fArgs.args, ",")[0] ?? "") : "";
      const what = first.startsWith('"') ? stripQuotes(first) : first;
      push("throw", line, `Fails (${fHead[1]}!)${what ? `: ${truncate(what, 140)}` : ""}`, i);
    }
    const errHead = ERR_HEAD_RE.exec(raw);
    if (errHead) {
      const eArgs = parenArgs(errHead[0].length);
      if (eArgs) push("throw", line, `Returns error ${truncate(eArgs.args, 140)}`, i);
    }

    // ---- 5. .ok_or(Error) absence checks ----
    const okOr = OK_OR_HEAD_RE.exec(raw);
    if (okOr) {
      const oArgs = parenArgs(okOr.index + okOr[0].length);
      if (oArgs) {
        const receiver = code.slice(0, okOr.index - indent).replace(/^let\s+[^=]*=\s*/, "");
        push(
          "guard",
          oArgs.joined ? stmt : line,
          `Rejects when \`${truncate(receiver, 80)}\` is absent: ${truncate(oArgs.args.replace(/^\|\|\s*/, ""), 120)}`,
          i,
        );
      }
    }

    // ---- 6. match on a status / enum value ----
    // Literals blanked: `bail!("no match for {}")` is not a match header.
    const mHead = MATCH_HEAD_RE.exec(blankLiterals(code));
    const mSplit = mHead ? header(mHead.index + mHead[0].length) : null;
    if (mHead && mSplit) {
      const subject = mSplit.cond;
      const labels: string[] = [];
      // Arm guards are pushed after the dispatch rule, keeping line order.
      const armGuards: Array<[string, string, number]> = [];
      // The header may be joined across lines; the block starts on the line
      // holding its `{`.
      const startLine = stmt.includes("{") ? (code.includes("{") ? i : headerEnd) : headerEnd + 1;
      let depth = 0;
      let pending = "";
      let pendingFrom = -1;
      let pendingLines = 0;
      const last = Math.min(startLine + BODY_LOOKAHEAD, lines.length);
      for (let j = startLine; j < last; j++) {
        const text = j === startLine ? lines[j].slice(lines[j].indexOf("{")) : lines[j];
        const armCode = stripComment(text, "//").trim();
        if (j > startLine && depth === 1 && armCode.length > 0) {
          const arrow = armCode.indexOf("=>");
          if (
            arrow < 0 &&
            pendingLines < MAX_CONTINUATION_LINES - 1 &&
            ARM_CONTINUES_RE.test(armCode)
          ) {
            if (pendingFrom < 0) pendingFrom = j;
            pending = `${pending} ${armCode}`.trim();
            pendingLines++;
          } else if (arrow >= 0) {
            let pattern = `${pending} ${armCode.slice(0, arrow)}`.trim().replace(/^\|\s*/, "");
            const armLine = pendingFrom >= 0 ? pendingFrom : j;
            pending = "";
            pendingFrom = -1;
            pendingLines = 0;
            const guardAt = pattern.indexOf(" if ");
            if (guardAt >= 0) {
              const guard = pattern.slice(guardAt + 4).trim();
              pattern = pattern.slice(0, guardAt).trim();
              if (comparesToConstant(guard)) {
                armGuards.push([armCode, `Branches on threshold ${truncate(guard, 140)}`, armLine]);
              }
            }
            for (const alt of splitTopLevel(pattern, "|")) {
              const label = constantLabel(alt);
              if (label) labels.push(label);
            }
          }
        }
        depth += braceDelta(text);
        if (depth <= 0) break;
      }
      if (subject && labels.length > 0) {
        push(
          "match-branch",
          `match ${subject} { ${labels.join("; ")} }`,
          `State dispatch on \`${truncate(subject, 80)}\` with ${labels.length} branches: ${labels.slice(0, 8).join(", ")}${labels.length > 8 ? ", ..." : ""}`,
          i,
        );
      }
      for (const [expr, summary, at] of armGuards) push("guard", expr, summary, at);
      continue;
    }

    // ---- 7. if expressions: `let fee = if total > 50 { 0 } else { 5 };` ----
    const exprHead = IF_EXPR_HEAD_RE.exec(code);
    if (exprHead) {
      const split = headerUpToBrace(stmt, exprHead.index + exprHead[0].length);
      if (split && comparesToConstant(split.cond)) {
        push("guard", stmt, `Branches on threshold ${truncate(split.cond, 140)}`, i);
      }
      continue;
    }

    // ---- 8. let-else guards: `let Some(x) = y else { return ... };` ----
    if (LET_ELSE_HEAD_RE.test(raw)) {
      const elseAt = stmt.indexOf(" else {");
      if (elseAt > 0) {
        const binding = stmt.slice(4, elseAt).trim();
        push("guard", stmt, `Rejects unless \`${truncate(binding, 140)}\` matches`, i);
        continue;
      }
    }

    // ---- 9. guard clauses / threshold branches ----
    const head = IF_HEAD_RE.exec(code);
    if (!head) continue;
    const split = header(head[0].length);
    if (!split) continue;
    const { cond } = split;
    let rest = split.rest;
    if (rest.endsWith("}")) rest = rest.slice(0, -1).trimEnd();
    const bodyFrom = headerEnd;
    if (rest.length > 0) {
      if (EXIT_RE.test(rest)) {
        push("guard", stmt, `Rejects when ${truncate(cond, 140)}`, i);
      } else if (!LOG_CALL_RE.test(rest) && comparesToConstant(cond)) {
        push("guard", stmt, `Branches on threshold ${truncate(cond, 140)}`, i);
      }
      continue;
    }
    const body = blockBody(lines, bodyFrom);
    if (isLoggingOnly(body, LOG_CALL_RE)) continue;
    if (exitsAfterLogging(body, LOG_CALL_RE, EXIT_RE)) {
      push("guard", stmt, `Rejects/exits when ${truncate(cond, 140)}`, i);
    } else if (comparesToConstant(cond)) {
      push("guard", stmt, `Branches on threshold ${truncate(cond, 140)}`, i);
    }
  }

  return rules;
}

const ORDER: readonly MinedRsRuleKind[] = [
  "annotation-validation",
  "precondition",
  "guard",
  "throw",
  "match-branch",
  "const",
];

function rsKindLabel(k: MinedRsRuleKind): string {
  switch (k) {
    case "annotation-validation":
      return "Validation attributes";
    case "precondition":
      return "Preconditions (assert! / ensure!)";
    case "guard":
      return "Guards (validation + reject)";
    case "throw":
      return "Failure modes (Err / panic! / bail!)";
    case "match-branch":
      return "State machines (match)";
    case "const":
      return "Constants / thresholds";
  }
}

/** Render mined Rust rules as a compact block for an LLM prompt. */
export function renderMinedRsRules(rules: MinedRsRule[], maxChars = 8000): string {
  return renderGroupedRules(rules, maxChars, ORDER, rsKindLabel, "Rust");
}

/** Every kind the Rust renderer groups by (a kind missing here would never render). */
export const RS_RULE_KINDS = ORDER;
