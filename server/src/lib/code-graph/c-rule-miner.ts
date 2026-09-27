/**
 * C / C++ business rule miner (#161).
 *
 * C and C++ are mostly systems code, but where they carry business logic
 * (pricing engines, settlement and billing cores, embedded control) it is the
 * same guard-and-error surface as elsewhere. This miner surfaces it
 * deterministically for Phase 1 of docs generation, for `.c` and for C++
 * (`.cpp` / `.cc` / `.cxx` / headers):
 *
 *   1. Preconditions — `assert(cond)`, `static_assert(cond, "msg")`,
 *      `_Static_assert`, and the Guidelines Support Library's `Expects(cond)` /
 *      `Ensures(cond)`.
 *   2. Guard clauses — an `if (cond)` whose body returns, `goto`s an error
 *      label, throws, or exits (`exit(`, `abort(`); an `if` that compares to a
 *      constant is a threshold branch, as is a ternary
 *      (`fee = total > LIMIT ? 0 : 5;`).
 *   3. C++ `throw std::invalid_argument("msg")` — failure modes.
 *   4. `switch (status) { case ORDER_OPEN: ... }` — dispatch on constant
 *      labels (`default` excluded).
 *   5. Constants — object-like `#define MAX_ITEMS 50`, `const` / `constexpr`
 *      literals (`static const double RATE = 0.2;`), and enumerators with an
 *      explicit value (`MAX_RETRIES = 3,`).
 *
 * False-positive guard: an `if` whose body only logs (`printf`, `fprintf`,
 * `syslog`, `std::cerr <<`, `LOG_*`) is NOT a rule.
 *
 * Deterministic line-local passes (no LLM call). A condition that leaves a
 * parenthesis open or ends in an operator is read as one logical line (#170's
 * {@link joinLogicalLine}: at most 12 lines / 4,000 characters, no regex).
 * ReDoS: every regex is a literal keyed on a fixed token with no two
 * quantifiers able to match the same text; conditions, case labels and
 * declarations are read by linear scans.
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
  exitsAfterLogging,
  isLiteralValue,
  isLoggingOnly,
  MAX_EXPR,
  MAX_RULES,
  renderGroupedRules,
  skipLiteral,
  type SplitHead,
  splitParen,
  splitTopLevel,
  stripQuotes,
  trailingIdentifier,
  truncate,
} from "./rule-miner-brace-shared.js";

export type MinedCRuleKind = "precondition" | "guard" | "throw" | "switch-branch" | "const";
export type MinedCRule = BraceMinedRule<MinedCRuleKind>;

// `assert(` / `static_assert(` / `_Static_assert(` / `Expects(` / `Ensures(`.
const PRECONDITION_HEAD_RE =
  /(?:^|[^\w.>:])(assert|static_assert|_Static_assert|Expects|Ensures)\s*\(/;
// `if (` at the start of a statement (`} else if (` too).
const IF_HEAD_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*(?:constexpr\s*)?\(/;
// `throw X("msg")` / `throw X{"msg"}` (a bare `throw;` rethrow has no type).
const THROW_RE = /\bthrow\s+([A-Za-z_][\w:]*)\s*[({]\s*("(?:[^"\\]|\\.)*")?/;
// `switch (`.
const SWITCH_HEAD_RE = /(?:^|[^\w])switch\s*\(/;
// `#define NAME value` — object-like only (a `(` right after the name is a macro function).
const DEFINE_RE = /^\s*#\s*define\s+([A-Za-z_]\w*)[ \t]+(\S.*)$/;
// A declaration that starts with a const-ness keyword or storage class before it.
const CONST_DECL_RE =
  /^(?:(?:static|extern|inline|volatile|unsigned|signed)\s+)*(?:const|constexpr|constinit)\b/;
// `NAME = 3,` — an enumerator with an explicit value (on a trimmed line).
const ENUMERATOR_RE = /^([A-Z][A-Z0-9_]*)\s*=\s*(-?\d[\w.']*)\s*,?$/;
const LOG_CALL_RE =
  /^\s*(?:(?:std::)?(?:printf|fprintf|vfprintf|puts|fputs|perror|syslog)\s*\(|(?:LOG|log|LOGGER|logger|spdlog|qDebug|qWarning|qInfo|qCritical)\w*\s*(?:\(|::|\.|<<|->)|(?:std::)?(?:cout|cerr|clog)\s*<<)/;
const EXIT_RE =
  /^\s*(?:return\b|throw\b|goto\s+\w|(?:std::)?(?:exit|abort|_Exit|quick_exit)\s*\(|_exit\s*\(|longjmp\s*\()/;

/** `case A: case B:` on one line → [`A`, `B`]; `default:` is skipped. Linear scan. */
function caseLabels(code: string): string[] {
  const out: string[] = [];
  let k = code.indexOf("case ");
  while (k >= 0) {
    // Only a `case` that starts the line or follows a statement end / label.
    let b = k - 1;
    while (b >= 0 && (code[b] === " " || code[b] === "\t")) b--;
    if (b >= 0 && !";:{}".includes(code[b])) break;
    let j = k + 5;
    let end = -1;
    while (j < code.length) {
      const ch = code[j];
      if (ch === "'" || ch === '"') {
        j = skipLiteral(code, j);
        continue;
      }
      if (ch === ":" && code[j + 1] === ":") {
        j += 2;
        continue;
      }
      if (ch === ":") {
        end = j;
        break;
      }
      j++;
    }
    if (end < 0) break;
    const label = code.slice(k + 5, end).trim();
    if (label) out.push(label);
    k = code.indexOf("case ", end + 1);
  }
  return out;
}

/** The value of a `const` / `constexpr` declaration and its name, when the value is a literal. */
function constDeclaration(code: string): { name: string; value: string } | null {
  if (!CONST_DECL_RE.test(code) || !code.endsWith(";")) return null;
  const eq = code.indexOf("=");
  if (eq < 0 || code[eq + 1] === "=") return null;
  let left = code.slice(0, eq).trimEnd();
  if (left.endsWith("]")) left = left.slice(0, left.lastIndexOf("[")).trimEnd();
  const name = trailingIdentifier(left);
  const value = code.slice(eq + 1, -1).trim();
  if (!name || !isLiteralValue(value)) return null;
  return { name, value };
}

/**
 * Mine all rule-bearing C / C++ patterns from a source slice.
 *
 * @param source   Raw source text (a function body, a whole file, or any slice).
 * @param filePath Relative path — stored on each rule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name.
 * @param maxRules Most rules returned; docs-gen Phase 1 passes `Infinity`.
 */
export function mineCRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
  maxRules: number = MAX_RULES,
): MinedCRule[] {
  const rules: MinedCRule[] = [];
  const lines = source.split("\n");
  const push = (kind: MinedCRuleKind, expression: string, summary: string, i: number) => {
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

    // ---- 1. constants: #define, const/constexpr, enumerators ----
    const def = DEFINE_RE.exec(code);
    if (def) {
      const value = def[2].replace(/\/\*.*$/, "").trim();
      if (isLiteralValue(value))
        push("const", line, `Constant \`${def[1]}\` = ${truncate(value, 120)}`, i);
      continue;
    }
    if (code.startsWith("#")) continue; // other preprocessor lines
    const decl = constDeclaration(code);
    if (decl) {
      push("const", line, `Constant \`${decl.name}\` = ${truncate(decl.value, 120)}`, i);
      continue;
    }
    const en = ENUMERATOR_RE.exec(code);
    if (en) {
      push("const", line, `Constant \`${en[1]}\` = ${en[2]}`, i);
      continue;
    }

    const logical =
      opensBracket(raw) || operatorContinues(code, stripComment(lines[i + 1] ?? "", "//").trim())
        ? joinLogicalLine(lines, i, { comment: "//", continues: operatorContinues })
        : null;
    const stmt = logical ? logical.text : code;
    const indent = raw.length - raw.trimStart().length;
    const splitHead = (afterOpen: number): (SplitHead & { joined: boolean }) | null => {
      const own = splitParen(raw, afterOpen);
      if (own) return { ...own, joined: false };
      const joined = logical ? splitParen(logical.text, afterOpen - indent) : null;
      return joined ? { ...joined, joined: true } : null;
    };

    // ---- 2. preconditions ----
    const pHead = PRECONDITION_HEAD_RE.exec(raw);
    const pCall = pHead ? splitHead(pHead.index + pHead[0].length) : null;
    if (pHead && pCall) {
      const [cond, msg] = splitTopLevel(pCall.cond, ",");
      const message = msg?.startsWith('"') ? `: ${truncate(stripQuotes(msg), 120)}` : "";
      push(
        "precondition",
        pCall.joined ? stmt : line,
        `${pHead[1]}(${truncate(cond ?? "", 120)})${message}`,
        i,
      );
      continue;
    }

    // ---- 3. throws (C++) ----
    const tMatch = THROW_RE.exec(raw);
    if (tMatch) {
      const full = !tMatch[2] && logical ? THROW_RE.exec(logical.text) : null;
      const msgLit = tMatch[2] ?? full?.[2];
      const msg = msgLit ? stripQuotes(msgLit) : "";
      push("throw", line, `Throws ${tMatch[1]}${msg ? `: ${truncate(msg, 140)}` : ""}`, i);
    }

    // ---- 4. switch on a status / enum value ----
    const sHead = SWITCH_HEAD_RE.exec(raw);
    const sSplit = sHead ? splitHead(sHead.index + sHead[0].length) : null;
    if (sHead && sSplit) {
      const subject = sSplit.cond;
      const labels: string[] = [];
      let depth = 0;
      let opened = false;
      const from = sSplit.joined && logical ? logical.end : i;
      const last = Math.min(from + BODY_LOOKAHEAD, lines.length);
      for (let j = from; j < last; j++) {
        const text = stripComment(lines[j], "//");
        if (opened && depth === 1) labels.push(...caseLabels(text.trim()));
        const d = braceDelta(text);
        if (!opened && text.includes("{")) {
          opened = true;
          // Labels on the header line itself, after its `{`.
          const after = text.slice(text.indexOf("{") + 1).trim();
          if (after) labels.push(...caseLabels(after));
        }
        depth += d;
        if (opened && depth <= 0) break;
      }
      const constant = labels.filter((l) => l !== "default");
      if (constant.length > 0) {
        push(
          "switch-branch",
          `switch (${subject}) { ${constant.join("; ")} }`,
          `State dispatch on \`${truncate(subject, 80)}\` with ${constant.length} branches: ${constant.slice(0, 8).join(", ")}${constant.length > 8 ? ", ..." : ""}`,
          i,
        );
      }
      continue;
    }

    // ---- 5. guard clauses / threshold branches ----
    const head = IF_HEAD_RE.exec(raw);
    if (head) {
      const split = splitHead(head[0].length);
      if (!split) continue;
      const guardLine = split.joined ? stmt : line;
      const bodyFrom = split.joined && logical ? logical.end : i;
      const { cond } = split;
      let rest = split.rest.replace(/^\{\s*/, "");
      if (rest.endsWith("}")) rest = rest.slice(0, -1).trimEnd();
      if (rest.length > 0) {
        if (EXIT_RE.test(rest)) push("guard", guardLine, `Rejects when ${truncate(cond, 140)}`, i);
        else if (!LOG_CALL_RE.test(rest) && comparesToConstant(cond)) {
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
      continue;
    }

    // ---- 6. ternary thresholds: `fee = total > LIMIT ? 0 : 5;` ----
    const q = stmt.indexOf("?");
    if (q > 0 && stmt.indexOf(":", q) > q) {
      let eq = -1;
      for (let k = q - 1; k > 0; k--) {
        if (stmt[k] === "=" && !"=!<>".includes(stmt[k - 1]) && stmt[k + 1] !== "=") {
          eq = k;
          break;
        }
      }
      const retAt = stmt.startsWith("return ") ? 6 : -1;
      const from = eq >= 0 ? eq + 1 : retAt;
      if (from > 0) {
        const cond = stmt
          .slice(from, q)
          .trim()
          .replace(/^\(|\)$/g, "");
        if (cond && comparesToConstant(cond)) {
          push("guard", stmt, `Branches on threshold ${truncate(cond, 140)}`, i);
        }
      }
    }
  }

  return rules;
}

const ORDER: readonly MinedCRuleKind[] = [
  "precondition",
  "guard",
  "throw",
  "switch-branch",
  "const",
];

function cKindLabel(k: MinedCRuleKind): string {
  switch (k) {
    case "precondition":
      return "Preconditions (assert / static_assert)";
    case "guard":
      return "Guards (validation + reject)";
    case "throw":
      return "Throws (failure modes)";
    case "switch-branch":
      return "State machines (switch/case)";
    case "const":
      return "Constants / thresholds";
  }
}

/** Render mined C / C++ rules as a compact block for an LLM prompt. */
export function renderMinedCRules(rules: MinedCRule[], maxChars = 8000): string {
  return renderGroupedRules(rules, maxChars, ORDER, cKindLabel, "C/C++");
}

/** Every kind the C / C++ renderer groups by (a kind missing here would never render). */
export const C_RULE_KINDS = ORDER;
