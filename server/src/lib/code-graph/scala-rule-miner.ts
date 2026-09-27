/**
 * Scala business rule miner (#161).
 *
 * Scala (JVM services, Spark / data pipelines) states its business rules in a
 * few structural shapes this miner surfaces deterministically for Phase 1 of
 * docs generation:
 *
 *   1. Preconditions — `require(cond, "msg")`, `assert(cond, "msg")`,
 *      `assume(cond)`, and `ensuring(cond)` postconditions.
 *   2. Guard clauses — an `if (cond)` (or Scala 3 `if cond then`) whose body
 *      throws, returns, or yields a failure (`Left(...)`, `Failure(...)`,
 *      `sys.error(...)`); an `if` that compares to a constant is a threshold
 *      branch, including `if` expressions (`val fee = if (total > 50) 0 else 5`).
 *   3. `throw new XxxException("msg")` and `sys.error("msg")` — failure modes.
 *   4. `status match { case Status.Open => ... }` — dispatch on constant
 *      values (enum cases, literals); a guarded arm `case t if t > 100 =>` is a
 *      threshold branch. Destructuring (`Some(x)`, `Left(e)`), bindings and
 *      type patterns (`case e: IOException`) are not state.
 *   5. Constants — `val MaxItems = 50`, `final val MAX_ITEMS = 50`.
 *
 * False-positive guard: an `if` whose body only logs is NOT a rule.
 *
 * Deterministic line-local passes (no LLM call). A statement whose parentheses
 * stay open, or whose condition ends in an operator, is read as one logical line
 * (#170's {@link joinLogicalLine}: at most 12 lines / 4,000 characters, no
 * regex). ReDoS: every regex below is a literal, anchored or keyed on a fixed
 * token, and none lets two quantifiers match the same text; parentheses and
 * arms are read by linear scans ({@link splitParen}, {@link splitTopLevel}).
 */

import {
  joinLogicalLine,
  opensBracket,
  operatorContinues,
  stripComment,
} from "./rule-miner-continuation.js";
import {
  BODY_LOOKAHEAD,
  blockBody,
  braceDelta,
  type BraceMinedRule,
  comparesToConstant,
  constantLabel,
  exitsAfterLogging,
  isLiteralValue,
  isLoggingOnly,
  MAX_EXPR,
  MAX_RULES,
  renderGroupedRules,
  type SplitHead,
  splitParen,
  splitTopLevel,
  stripQuotes,
  truncate,
} from "./rule-miner-brace-shared.js";

export type MinedScalaRuleKind = "precondition" | "guard" | "throw" | "match-branch" | "const";
export type MinedScalaRule = BraceMinedRule<MinedScalaRuleKind>;

// `require(` / `assert(` / `assume(` / `ensuring(` — the head only; the
// arguments are read by a balanced scan.
const PRECONDITION_HEAD_RE = /(?:^|[^\w.])(require|assert|assume)\s*\(/;
const ENSURING_HEAD_RE = /\.ensuring\s*\(/;
// `if (` at the start of a statement (`} else if (` too).
const IF_HEAD_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/;
// Scala 3 `if cond then` — the condition runs to ` then`, found with indexOf.
const IF_THEN_HEAD_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s+(?!\()/;
// `val fee = if (` — an if EXPRESSION.
const IF_EXPR_HEAD_RE = /=\s*if\s*\(/;
// `throw new X("msg")` / `throw X("msg")` (Scala 3 needs no `new`).
const THROW_RE = /\bthrow\s+(?:new\s+)?([A-Za-z_][\w.]*)\s*\(\s*("(?:[^"\\]|\\.)*")?/;
const SYS_ERROR_RE = /\bsys\.error\s*\(\s*("(?:[^"\\]|\\.)*")/;
// `<subject> match {` — the subject is read backwards from ` match` in code.
const MATCH_RE = /\smatch\s*\{/;
// `[modifiers] val Name[: T] = <value>` — a capitalised val (Scala's constant
// convention is UpperCamel; UPPER_SNAKE too). `\s*` is followed by `:` or `=`.
const CONST_RE =
  /^\s*(?:(?:private|protected|final|override|lazy|inline)(?:\[\w+\])?\s+)*val\s+([A-Z]\w*)\s*(?::[^=]*)?=(.*)$/;
const LOG_CALL_RE =
  /^\s*(?:(?:_?logger|_?log|LOG|LOGGER|Log)\s*\.\s*(?:trace|debug|info|warn|warning|error)\b|println\s*\(|print\s*\()/;
const EXIT_RE =
  /^\s*(?:throw\b|return\b|Left\s*\(|Failure\s*\(|sys\.error\s*\(|Future\.failed\s*\()/;

/** Where `require(`'s arguments start: its condition and optional message. */
function preconditionSummary(fn: string, args: string): string {
  const [cond, msg] = splitTopLevel(args, ",");
  const message = msg && msg.startsWith('"') ? stripQuotes(msg) : "";
  return `${fn}(${truncate(cond ?? "", 120)})${message ? `: ${truncate(message, 120)}` : ""}`;
}

/**
 * The expression a `match` is on: the text before ` match`, after the last
 * assignment `=` (not `==`, `<=`, `>=`, `!=`, `=>`) and a leading `return`.
 * A backwards scan.
 */
function matchSubject(text: string, matchAt: number): string {
  let s = text.slice(0, matchAt).trim();
  for (let k = s.length - 1; k >= 0; k--) {
    if (s[k] !== "=") continue;
    const before = s[k - 1] ?? "";
    const after = s[k + 1] ?? "";
    if ("=!<>".includes(before) || after === "=" || after === ">") continue;
    s = s.slice(k + 1).trim();
    break;
  }
  return s.replace(/^return\s+/, "").trim();
}

/**
 * Mine all rule-bearing Scala patterns from a source slice.
 *
 * @param source   Raw source text (a function body, a whole file, or any slice).
 * @param filePath Relative path — stored on each rule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name.
 * @param maxRules Most rules returned; docs-gen Phase 1 passes `Infinity`.
 */
export function mineScalaRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
  maxRules: number = MAX_RULES,
): MinedScalaRule[] {
  const rules: MinedScalaRule[] = [];
  const lines = source.split("\n");
  const push = (kind: MinedScalaRuleKind, expression: string, summary: string, i: number) => {
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
    // #170 — a statement whose parentheses stay open at the end of this line,
    // or whose condition ends in (or continues with) an operator, is read as
    // one logical line anchored here.
    const logical =
      opensBracket(raw) ||
      operatorContinues(stripComment(line, "//").trim(), (lines[i + 1] ?? "").trim())
        ? joinLogicalLine(lines, i, { comment: "//", continues: operatorContinues })
        : null;
    const indent = raw.length - raw.trimStart().length;
    const splitHead = (afterOpen: number): (SplitHead & { joined: boolean }) | null => {
      const own = splitParen(raw, afterOpen);
      if (own) return { ...own, joined: false };
      const joined = logical ? splitParen(logical.text, afterOpen - indent) : null;
      return joined ? { ...joined, joined: true } : null;
    };
    const stmtLine = logical ? logical.text : line;

    // ---- 1. constants ----
    const cMatch = CONST_RE.exec(raw);
    if (cMatch && isLiteralValue(stripComment(cMatch[2], "//"))) {
      push(
        "const",
        line,
        `Constant \`${cMatch[1]}\` = ${truncate(stripComment(cMatch[2], "//").trim(), 120)}`,
        i,
      );
      continue;
    }

    // ---- 2. preconditions ----
    const pHead = PRECONDITION_HEAD_RE.exec(raw);
    const pCall = pHead ? splitHead(pHead.index + pHead[0].length) : null;
    if (pHead && pCall) {
      push(
        "precondition",
        pCall.joined ? stmtLine : line,
        preconditionSummary(pHead[1], pCall.cond),
        i,
      );
      continue;
    }
    const ensHead = ENSURING_HEAD_RE.exec(raw);
    const ensCall = ensHead ? splitHead(ensHead.index + ensHead[0].length) : null;
    if (ensHead && ensCall) {
      push(
        "precondition",
        ensCall.joined ? stmtLine : line,
        `Postcondition ensuring(${truncate(splitTopLevel(ensCall.cond, ",")[0] ?? "", 120)})`,
        i,
      );
      continue;
    }

    // ---- 3. throws / sys.error ----
    const tMatch = THROW_RE.exec(raw);
    if (tMatch) {
      const full = !tMatch[2] && logical ? THROW_RE.exec(logical.text) : null;
      const msgLit = tMatch[2] ?? full?.[2];
      const msg = msgLit ? stripQuotes(msgLit) : "";
      push("throw", line, `Throws ${tMatch[1]}${msg ? `: ${truncate(msg, 140)}` : ""}`, i);
    }
    const sysErr = SYS_ERROR_RE.exec(raw) ?? (logical ? SYS_ERROR_RE.exec(logical.text) : null);
    if (sysErr) {
      push(
        "throw",
        line,
        `Fails with RuntimeException: ${truncate(stripQuotes(sysErr[1]), 140)}`,
        i,
      );
    }

    // ---- 4. match on a status / enum value ----
    const mMatch = MATCH_RE.exec(raw);
    if (mMatch) {
      const subject = matchSubject(raw, mMatch.index);
      const labels: string[] = [];
      // Arm guards are pushed after the dispatch rule, keeping line order.
      const armGuards: Array<[string, string, number]> = [];
      let depth = 0;
      const last = Math.min(i + BODY_LOOKAHEAD, lines.length);
      for (let j = i; j < last; j++) {
        const text = j === i ? raw.slice(mMatch.index + mMatch[0].length - 1) : lines[j];
        const code = stripComment(text, "//").trim();
        if (j > i && depth === 1 && code.startsWith("case ")) {
          const arrow = code.indexOf("=>");
          if (arrow > 0) {
            let pattern = code.slice(5, arrow).trim();
            const guardAt = pattern.indexOf(" if ");
            if (guardAt >= 0) {
              const guard = pattern.slice(guardAt + 4).trim();
              pattern = pattern.slice(0, guardAt).trim();
              if (comparesToConstant(guard)) {
                armGuards.push([code, `Branches on threshold ${truncate(guard, 140)}`, j]);
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
          `${subject} match { ${labels.join("; ")} }`,
          `State dispatch on \`${truncate(subject, 80)}\` with ${labels.length} branches: ${labels.slice(0, 8).join(", ")}${labels.length > 8 ? ", ..." : ""}`,
          i,
        );
      }
      for (const [expr, summary, at] of armGuards) push("guard", expr, summary, at);
      continue;
    }

    // ---- 5. if expressions: `val fee = if (total > 50) 0 else 5` ----
    const exprHead = IF_EXPR_HEAD_RE.exec(raw);
    if (exprHead) {
      const split = splitHead(exprHead.index + exprHead[0].length);
      if (split && comparesToConstant(split.cond)) {
        push(
          "guard",
          split.joined ? stmtLine : line,
          `Branches on threshold ${truncate(split.cond, 140)}`,
          i,
        );
      }
      continue;
    }

    // ---- 6. guard clauses / threshold branches ----
    let cond: string | null = null;
    let rest = "";
    let guardLine = line;
    let bodyFrom = i;
    const head = IF_HEAD_RE.exec(raw);
    if (head) {
      const split = splitHead(head[0].length);
      if (!split) continue;
      cond = split.cond;
      rest = split.rest;
      if (split.joined && logical) {
        guardLine = stmtLine;
        bodyFrom = logical.end;
      }
    } else if (IF_THEN_HEAD_RE.test(raw)) {
      // Scala 3: `if cond then body` — the condition ends at ` then`.
      const text = stmtLine;
      const ifAt = text.indexOf("if ");
      const thenAt = text.indexOf(" then", ifAt + 3);
      if (ifAt < 0 || thenAt < 0) continue;
      cond = text.slice(ifAt + 3, thenAt).trim();
      rest = text.slice(thenAt + 5).trim();
      if (logical) {
        guardLine = stmtLine;
        bodyFrom = logical.end;
      }
    }
    if (cond === null) continue;
    rest = rest.replace(/^\{\s*/, "");
    if (rest.endsWith("}")) rest = rest.slice(0, -1).trimEnd();
    if (rest.length > 0) {
      if (EXIT_RE.test(rest)) {
        push("guard", guardLine, `Rejects when ${truncate(cond, 140)}`, i);
      } else if (!LOG_CALL_RE.test(rest) && comparesToConstant(cond)) {
        push("guard", guardLine, `Branches on threshold ${truncate(cond, 140)}`, i);
      }
      continue;
    }
    const body = blockBody(lines, bodyFrom);
    if (isLoggingOnly(body, LOG_CALL_RE)) continue;
    if (exitsAfterLogging(body, LOG_CALL_RE, EXIT_RE)) {
      push("guard", guardLine, `Rejects/exits when ${truncate(cond, 140)}`, i);
    } else if (comparesToConstant(cond)) {
      push("guard", guardLine, `Branches on threshold ${truncate(cond, 140)}`, i);
    }
  }

  return rules;
}

const ORDER: readonly MinedScalaRuleKind[] = [
  "precondition",
  "guard",
  "throw",
  "match-branch",
  "const",
];

function scalaKindLabel(k: MinedScalaRuleKind): string {
  switch (k) {
    case "precondition":
      return "Preconditions (require / assert / ensuring)";
    case "guard":
      return "Guards (validation + reject)";
    case "throw":
      return "Throws (failure modes)";
    case "match-branch":
      return "State machines (match)";
    case "const":
      return "Constants / thresholds";
  }
}

/** Render mined Scala rules as a compact block for an LLM prompt. */
export function renderMinedScalaRules(rules: MinedScalaRule[], maxChars = 8000): string {
  return renderGroupedRules(rules, maxChars, ORDER, scalaKindLabel, "Scala");
}

/** Every kind the Scala renderer groups by (a kind missing here would never render). */
export const SCALA_RULE_KINDS = ORDER;
