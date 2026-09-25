/**
 * Kotlin business rule miner (#159).
 *
 * Kotlin (JVM services, Android) expresses its business rules in a handful of
 * structural shapes that are easy for an LLM to skim past in a dense source
 * dump. This miner surfaces them deterministically for Phase 1 of docs
 * generation:
 *
 *   1. Preconditions — `require(cond) { "msg" }`, `check(cond)`,
 *      `requireNotNull(x)`, `checkNotNull(x)`, `error("msg")`.
 *   2. Guard clauses — an `if` whose body throws or returns early (braced,
 *      inline, or next-line), and elvis guards `x ?: throw ...` / `?: return`.
 *   3. `throw XxxException("msg")` — every throw documents a failure mode.
 *   4. `when (status) { Status.A -> ...; Status.B, Status.C -> ... }` — state
 *      dispatch on a status/enum value. A subject-less `when { x > 10 -> ... }`
 *      contributes its constant-comparing arms as threshold branches.
 *   5. Bean Validation annotations, including Kotlin use-site targets —
 *      `@field:NotBlank`, `@get:Size(min = 1)`, `@Min(1)`, `@Pattern(...)`.
 *   6. Constants — `const val MAX = 50`, `val MAX_ITEMS = 50` — and comparisons
 *      against a literal or a named constant, including `if` expressions
 *      (`val fee = if (total > FREE_LIMIT) 0 else 5`).
 *
 * False-positive guard: an `if` whose body only logs (`logger.info { }`,
 * `log.debug(...)`, `println(...)`) is NOT a rule, whatever it compares.
 *
 * Deterministic line-local passes (no LLM call), mirroring {@link mineJavaRules}
 * / {@link mineTsRules}. Semgrep-safe: every regex is a literal and none nests
 * unbounded quantifiers.
 */

export interface MinedKtRule {
  kind: "precondition" | "guard" | "throw" | "when-branch" | "annotation-validation" | "const";
  /** Raw statement as found in source (trimmed, single-line-collapsed). */
  expression: string;
  /** Human-readable summary of what the rule enforces. */
  summary: string;
  /** Source file path (relative). */
  filePath: string;
  /** 1-based line number where the rule lives. */
  line: number;
  /** Containing function/class qualified name when known. */
  context: string | null;
}

const MAX_EXPR = 200;
const MAX_RULES = 400;
const LOOKAHEAD = 100;

// `require(` / `check(` / `requireNotNull(` / `checkNotNull(` — the head only.
// The argument list is read by a balanced-paren scan ({@link splitIf}); a regex
// with two lazy groups here was cubic on a long line (ReDoS).
const PRECONDITION_HEAD_RE = /(?:^|[^\w.])(require|check|requireNotNull|checkNotNull)\s*\(/;
// The lazy-message lambda after the call: `{ "message" }`.
const LAZY_MESSAGE_RE = /^\{\s*("(?:[^"\\]|\\.)*")/;
// `error("msg")` — throws IllegalStateException.
const ERROR_CALL_RE = /(?:^|[^\w.])error\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/;
// `if (` at the start of a statement (`} else if (` too). The condition itself
// is read by a balanced-paren scan ({@link splitIf}) because Kotlin statements
// carry no `;`, so a regex cannot tell `if (a(b)) c(d)` from a block header.
const IF_HEAD_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/;
// `val x = if (<cond>) a else b` — an if EXPRESSION.
const IF_EXPR_HEAD_RE = /=\s*if\s*\(/;
// `?: throw X(...)` / `?: return ...`.
// The lookbehind anchors the receiver at a word start: without it the regex
// retried the identifier from every position — quadratic on a long line.
const ELVIS_RE = /(?<![\w.])(\w[\w.]*(?:\([^()]*\))?)\s*\?:\s*(throw\b.*|return\b.*)$/;
// `throw XxxException("...")` — Kotlin has no `new`.
const THROW_RE = /\bthrow\s+([A-Z][\w.]*)\s*\(\s*("(?:[^"\\]|\\.)*")?/;
// `when (subject) {` / `when (val s = x.status) {` / `when {`. The subject is
// trimmed and its `val s =` binding stripped in code: `\(\s*(?:val…)?([^)]*?)\s*\)`
// let three quantifiers share one whitespace run and was cubic on `when (` +
// spaces with no `)` (ReDoS). No two quantifiers here can match the same text.
const WHEN_RE = /\bwhen\s*(?:\(([^)]*)\)\s*)?\{/;
const WHEN_VAL_BINDING_RE = /^val\s+\w+\s*=/;
// Bean Validation annotations with optional Kotlin use-site target.
const ANNOTATION_RE =
  /@(?:field:|get:|set:|param:|property:|setparam:)?([A-Z]\w*)\s*(\((?:[^()]|\([^()]*\))*\))?/g;
const VALIDATION_ANNOTATIONS = new Set([
  "NotNull",
  "NotBlank",
  "NotEmpty",
  "Null",
  "Size",
  "Min",
  "Max",
  "DecimalMin",
  "DecimalMax",
  "Digits",
  "Positive",
  "PositiveOrZero",
  "Negative",
  "NegativeOrZero",
  "Pattern",
  "Email",
  "Past",
  "PastOrPresent",
  "Future",
  "FutureOrPresent",
  "AssertTrue",
  "AssertFalse",
  "Valid",
  "Validated",
  "Range",
  "Length",
  "URL",
  "CreditCardNumber",
]);
// `const val NAME = literal` / `val UPPER_NAME = literal` / `private const val ...`.
const CONST_RE =
  /^\s*(?:(?:private|internal|public|protected)\s+)?(?:const\s+val\s+([A-Za-z_]\w*)|val\s+([A-Z][A-Z0-9_]*))\s*(?::\s*[\w.?<>]+\s*)?=\s*(-?\d[\w.]*|"(?:[^"\\]|\\.)*"|'[^']*'|true|false)\s*$/;
const LITERAL_CMP_RE = /(?:[<>]=?|==|!=)\s*(?:-?\d+(?:\.\d+)?[LlFf]?\b|"[^"]*")/;
const NAMED_CMP_RE =
  /(?:[<>]=?|==|!=)\s*(?:[A-Z][A-Za-z0-9]*\.[A-Z]\w*|[A-Z][A-Z0-9_]{2,}\b|[A-Z][a-z]\w*\b)/;
// `x in 1..10` / `x !in ALLOWED` / `x is Status.Closed`.
const RANGE_OR_IS_RE = /!?in\s+(?:-?\d|[A-Z])|\bis\s+[A-Z]/;
const LOG_CALL_RE =
  /^\s*(?:(?:_?logger|_?log|LOG|LOGGER|Log|Timber)\s*\.\s*(?:trace|debug|info|warn|warning|error|v|d|i|w|e|atInfo|atDebug|atWarn)\b|println\s*\(|print\s*\()/;
const EXIT_RE = /^\s*(?:throw\b|return\b)/;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function stripQuotes(s: string): string {
  return s.replace(/^"|"$/g, "").trim();
}

/**
 * Split a parenthesised head (`if (`, `require(`) whose `(` ends at `afterOpen`
 * into the text inside the parentheses and the text after the matching `)`. Returns null when the parentheses do not close on the
 * line (a multi-line condition).
 */
function splitIf(text: string, afterOpen: number): { cond: string; rest: string } | null {
  let depth = 1;
  for (let k = afterOpen; k < text.length; k++) {
    const ch = text[k];
    if (ch === '"') {
      const close = text.indexOf('"', k + 1);
      if (close === -1) return null;
      k = close;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return { cond: text.slice(afterOpen, k).trim(), rest: text.slice(k + 1).trim() };
      }
    }
  }
  return null;
}

function comparesToConstant(cond: string): boolean {
  return LITERAL_CMP_RE.test(cond) || NAMED_CMP_RE.test(cond) || RANGE_OR_IS_RE.test(cond);
}

/**
 * The top-level statements of an `if` body that starts after `headerIdx`:
 * either a braced block (Allman or K&R) or a single unbraced statement.
 * Continuation lines of a multi-line call or lambda are not separate
 * statements, so brackets `{`/`(` are counted together and only lines that
 * START at body depth are returned. Bounded lookahead.
 */
function ifBody(lines: string[], headerIdx: number): string[] {
  let depth = lines[headerIdx].trimEnd().endsWith("{") ? 1 : 0;
  const body: string[] = [];
  for (let j = headerIdx + 1; j < Math.min(headerIdx + 1 + LOOKAHEAD, lines.length); j++) {
    const l = lines[j].trim();
    if (l.length === 0 || l.startsWith("//")) continue;
    if (depth === 0) {
      if (l === "{") {
        depth = 1;
        continue;
      }
      // Unbraced single-statement body.
      body.push(l);
      break;
    }
    const startDepth = depth;
    for (const ch of l) {
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth--;
    }
    const stmt = l
      .replace(/^[})\s]+/, "")
      .replace(/\}\s*$/, "")
      .trim();
    if (startDepth === 1 && stmt.length > 0 && !/^[})]/.test(l)) body.push(stmt);
    if (depth <= 0) break;
  }
  return body;
}

function isLoggingOnly(statements: string[]): boolean {
  return statements.length > 0 && statements.every((s) => LOG_CALL_RE.test(s));
}

/**
 * True when the body's first non-logging statement exits (`throw`/`return`).
 * Leading log lines are skipped so `log(...); return;` is still a guard; an exit
 * after other work is not.
 */
function exitsAfterLogging(statements: string[]): boolean {
  const first = statements.find((s) => !LOG_CALL_RE.test(s));
  return first !== undefined && EXIT_RE.test(first);
}

function summarizeAnnotation(name: string, args: string): string {
  const a = args.replace(/^\(|\)$/g, "").trim();
  switch (name) {
    case "NotNull":
      return "Field must not be null";
    case "NotBlank":
      return "Field must not be blank";
    case "NotEmpty":
      return "Field must not be empty";
    case "Size":
    case "Length":
      return `Length/size constraint: ${a || "default bounds"}`;
    case "Min":
    case "Max":
    case "DecimalMin":
    case "DecimalMax":
      return `Numeric bound: ${name} ${a}`;
    case "Pattern":
      return `Regex constraint: ${truncate(a, 100)}`;
    case "Email":
      return "Must be a valid email address";
    case "Valid":
    case "Validated":
      return "Cascade validation to nested object";
    default:
      return `${name}${a ? `(${truncate(a, 80)})` : ""} validation`;
  }
}

/**
 * Mine all rule-bearing Kotlin patterns from a source slice.
 *
 * @param source   Raw source text (a function body, a whole file, or any slice).
 * @param filePath Relative path — stored on each rule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name (e.g. "OrderService.place").
 */
export function mineKtRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
  /**
   * Most rules returned (default {@link MAX_RULES}). Docs-gen Phase 1 passes
   * `Infinity`: it mines whole files and must not lose any rule past the cap.
   */
  maxRules: number = MAX_RULES,
): MinedKtRule[] {
  const rules: MinedKtRule[] = [];
  const lines = source.split("\n");
  const push = (kind: MinedKtRule["kind"], expression: string, summary: string, i: number) => {
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
    if (line.length === 0 || line.startsWith("//") || line.startsWith("*")) continue;

    // ---- 1. validation annotations (may share a line with the parameter) ----
    ANNOTATION_RE.lastIndex = 0;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = ANNOTATION_RE.exec(raw)) !== null) {
      if (!VALIDATION_ANNOTATIONS.has(aMatch[1])) continue;
      push("annotation-validation", aMatch[0], summarizeAnnotation(aMatch[1], aMatch[2] ?? ""), i);
    }

    // ---- 2. constants ----
    const cMatch = CONST_RE.exec(raw);
    if (cMatch) {
      push(
        "const",
        line,
        `Constant \`${cMatch[1] ?? cMatch[2]}\` = ${truncate(cMatch[3], 120)}`,
        i,
      );
      continue;
    }

    // ---- 3. preconditions ----
    const pHead = PRECONDITION_HEAD_RE.exec(raw);
    const pCall = pHead ? splitIf(raw, pHead.index + pHead[0].length) : null;
    if (pHead && pCall) {
      const lazy = LAZY_MESSAGE_RE.exec(pCall.rest);
      const msg = lazy ? stripQuotes(lazy[1]) : "";
      push(
        "precondition",
        line,
        `${pHead[1]}(${truncate(pCall.cond, 120)})${msg ? `: ${truncate(msg, 120)}` : ""}`,
        i,
      );
      continue;
    }
    const eMatch = ERROR_CALL_RE.exec(raw);
    // The `[^\w.]` prefix in ERROR_CALL_RE already rejects `logger.error(...)`.
    if (eMatch) {
      push(
        "throw",
        line,
        `Fails with IllegalStateException: ${truncate(stripQuotes(eMatch[1]), 140)}`,
        i,
      );
    }

    // ---- 4. throws ----
    const tMatch = THROW_RE.exec(raw);
    if (tMatch) {
      const msg = tMatch[2] ? stripQuotes(tMatch[2]) : "";
      push("throw", line, `Throws ${tMatch[1]}${msg ? `: ${truncate(msg, 140)}` : ""}`, i);
    }

    // ---- 5. when on a status/enum ----
    const wMatch = WHEN_RE.exec(raw);
    if (wMatch) {
      const subject = wMatch[1]?.trim().replace(WHEN_VAL_BINDING_RE, "").trim();
      const labels: string[] = [];
      let depth = 0;
      for (let j = i; j < Math.min(i + LOOKAHEAD, lines.length); j++) {
        let text = lines[j];
        if (j === i) text = text.slice(wMatch.index + wMatch[0].length - 1);
        if (j > i && depth === 1) {
          // A when-arm is `<conditions> -> ...`. Found with indexOf, not a regex:
          // `^\s*(.+?)\s*->` was cubic on a long whitespace run (ReDoS).
          const arrow = text.indexOf("->");
          const armCond = arrow > 0 ? text.slice(0, arrow).trim() : "";
          const arm = armCond ? [text, armCond] : null;
          if (arm && arm[1] !== "else") {
            if (subject) {
              labels.push(
                ...arm[1]
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              );
            } else if (comparesToConstant(arm[1])) {
              push("guard", text.trim(), `Branches on threshold ${truncate(arm[1], 140)}`, j);
            }
          }
        }
        for (const ch of text) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        if (depth <= 0) break;
      }
      if (subject && labels.length > 0) {
        push(
          "when-branch",
          `when(${subject}) { ${labels.join("; ")} }`,
          `State dispatch on \`${subject}\` with ${labels.length} branches: ${labels.slice(0, 8).join(", ")}${labels.length > 8 ? ", ..." : ""}`,
          i,
        );
      }
      continue;
    }

    // ---- 6. elvis guards ----
    const elvis = ELVIS_RE.exec(line);
    if (elvis) {
      push("guard", line, `Rejects when \`${truncate(elvis[1], 100)}\` is null`, i);
      continue;
    }

    // ---- 7. if expressions: `val fee = if (total > 50) 0 else 5` ----
    const exprHead = IF_EXPR_HEAD_RE.exec(raw);
    if (exprHead) {
      const split = splitIf(raw, exprHead.index + exprHead[0].length);
      if (split && comparesToConstant(split.cond)) {
        push("guard", line, `Branches on threshold ${truncate(split.cond, 140)}`, i);
      }
      continue;
    }

    // ---- 8. guard clauses / threshold branches ----
    const head = IF_HEAD_RE.exec(raw);
    if (!head) continue;
    const split = splitIf(raw, head[0].length);
    if (!split) continue;
    const { cond } = split;
    let rest = split.rest.replace(/^\{\s*/, "");
    if (rest.endsWith("}")) rest = rest.slice(0, -1).trimEnd();
    if (rest.length > 0) {
      // Inline body on the header line.
      if (EXIT_RE.test(rest)) {
        push("guard", line, `Rejects when ${truncate(cond, 140)}`, i);
      } else if (!LOG_CALL_RE.test(rest) && comparesToConstant(cond)) {
        push("guard", line, `Branches on threshold ${truncate(cond, 140)}`, i);
      }
      continue;
    }
    const body = ifBody(lines, i);
    if (isLoggingOnly(body)) continue;
    if (exitsAfterLogging(body)) {
      push("guard", line, `Rejects/exits when ${truncate(cond, 140)}`, i);
    } else if (comparesToConstant(cond)) {
      push("guard", line, `Branches on threshold ${truncate(cond, 140)}`, i);
    }
  }

  return rules;
}

/**
 * Render mined Kotlin rules as a compact markdown-ish block for an LLM prompt.
 * Mirrors {@link renderMinedTsRules}.
 */
export function renderMinedKtRules(rules: MinedKtRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  const groups = new Map<MinedKtRule["kind"], MinedKtRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedKtRule["kind"][] = [
    "annotation-validation",
    "precondition",
    "guard",
    "throw",
    "when-branch",
    "const",
  ];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${ktKindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more Kotlin rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function ktKindLabel(k: MinedKtRule["kind"]): string {
  switch (k) {
    case "annotation-validation":
      return "Validation annotations";
    case "precondition":
      return "Preconditions (require / check)";
    case "guard":
      return "Guards (validation + reject)";
    case "throw":
      return "Throws (failure modes)";
    case "when-branch":
      return "State machines (when)";
    case "const":
      return "Constants / thresholds";
  }
}
