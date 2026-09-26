/**
 * C# business rule miner (#158).
 *
 * Why this exists: the code graph already parses `.cs` (tree-sitter-c-sharp,
 * Issue #900), but C# modules reached Phase 1 of docs generation with no
 * deterministic rule inventory, so their rules depended entirely on the LLM
 * noticing them in a dense source dump. This miner surfaces the C# shapes that
 * encode business rules:
 *
 *   1. Guard clauses — an `if` whose body throws or returns early (Allman or
 *      K&R braces, or the inline `if (x) throw ...;` form).
 *   2. .NET guard helpers — `ArgumentNullException.ThrowIfNull(x)`,
 *      `ArgumentOutOfRangeException.ThrowIfNegative(x)`, Ardalis
 *      `Guard.Against.Null(x)`.
 *   3. `throw new XxxException("msg")`, including throw expressions
 *      (`?? throw new ...`).
 *   4. Data-annotation validation attributes — `[Required]`, `[Range(1, 99)]`,
 *      `[RegularExpression(@"...")]`, `[StringLength(50)]`, ...
 *   5. `switch` statements and `switch` expressions on a status/enum value.
 *   6. Constants — `const` / `static readonly` literals — and comparisons
 *      against a literal or a named constant (`if (qty > MaxQuantity)`).
 *   7. FluentValidation rules — `RuleFor(x => x.Email).NotEmpty().EmailAddress();`,
 *      including chains that span several lines.
 *
 * False-positive guards: an `if` whose body only logs (`_logger.LogDebug(...)`,
 * `Console.WriteLine(...)`) or whose condition is a log-level check is NOT a
 * rule, even when its condition compares against a constant.
 *
 * Deterministic line-local passes (no LLM call), mirroring {@link mineJavaRules}
 * / {@link mineTsRules}. Semgrep-safe: every regex is a literal (no `RegExp`
 * constructor on non-literal input) and none nests unbounded quantifiers.
 */

export interface MinedCsRule {
  kind:
    | "guard"
    | "precondition"
    | "throw"
    | "validation-attribute"
    | "fluent-rule"
    | "switch-case"
    | "const";
  /** Raw statement as found in source (trimmed, single-line-collapsed). */
  expression: string;
  /** Human-readable summary of what the rule enforces. */
  summary: string;
  /** Source file path (relative). */
  filePath: string;
  /** 1-based line number where the rule lives. */
  line: number;
  /** Containing method/class qualified name when known. */
  context: string | null;
}

const MAX_EXPR = 200;
const MAX_RULES = 400;
/** How far ahead a multi-line construct (switch, fluent chain) may extend. */
const LOOKAHEAD = 100;

// `if (<cond>)` optionally followed by `{` — the condition is captured greedily
// to the LAST `)` so nested calls in the condition survive. `\s*(?:\{\s*)?`, not
// `\s*\{?\s*`: two adjacent optional whitespace runs backtrack quadratically.
const IF_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\((.+)\)\s*(?:\{\s*)?$/;
// Inline `if (<cond>) throw ...;` / `if (<cond>) return ...;` / `{ throw ... }`.
const INLINE_IF_RE = /^\s*(?:else\s+)?if\s*\((.+?)\)\s*(?:\{\s*)?((?:throw|return)\b.*)$/;
// Inline `if (<cond>) <statement>;` — used only to recognise logging-only ifs.
const INLINE_STMT_IF_RE = /^\s*(?:else\s+)?if\s*\((.+?)\)\s*(?:\{\s*)?([A-Za-z_][\w.]*\s*\(.*)$/;
// `throw new XxxException("...")` — message capture is optional.
const THROW_RE = /throw\s+new\s+([A-Za-z_][\w.]*)\s*\(\s*(\$?@?"(?:[^"\\]|\\.)*")?/;
// .NET 6+ static guard helpers and the Ardalis.GuardClauses package.
const THROW_HELPER_RE =
  /\b(Argument(?:Null|OutOfRange)?Exception|ObjectDisposedException)\.(ThrowIf\w*)\s*\(([^;]*)\)\s*;/;
const GUARD_AGAINST_RE = /\bGuard\.Against\.(\w+)\s*\(([^;]*)\)\s*;/;
// `switch (subject)` statement header. The subject is trimmed in code, not by
// `\s*` around the capture: `\(\s*([^)]+?)\s*\)` let three quantifiers share
// one whitespace run and was cubic on `switch (` + spaces with no `)` (ReDoS).
const SWITCH_RE = /\bswitch\s*\(([^)]+)\)/;
// `case Status.Pending:` / `case "gold":` / `case 3:` / `case X when y > 0:`.
// Single greedy class up to the `:` (a lazy group + optional `when` guard was
// cubic on a long line with no `:`); the guard is stripped afterwards.
const CASE_RE = /^\s*case\b([^:]*):/;
// `subject switch {` — a switch EXPRESSION. The lookbehind anchors the subject
// at a word start (otherwise quadratic on a long identifier run).
const SWITCH_EXPR_RE = /(?<![\w.])([A-Za-z_][\w.]*)\s+switch\s*(?:\{|$)/;
// A switch-expression arm `Status.Gold => ...` (the discard `_` is skipped).
const ARM_RE = /^\s*([A-Za-z_][\w.]*|"[^"]*"|-?\d+(?:\.\d+)?)\s*(?:when\b[^=]*)?=>/;
// `const int MaxItems = 50;` / `public static readonly decimal Rate = 0.2m;`.
const CONST_RE =
  /^\s*(?:(?:public|private|protected|internal|static|new)\s+)*(?:const|static\s+readonly|readonly\s+static)\s+[\w.<>?[\]]+\s+([A-Za-z_]\w*)\s*=\s*(-?\d[\w.]*|\$?@?"(?:[^"\\]|\\.)*"|'[^']*'|true|false)\s*;/;
// Comparison against a numeric / string literal.
const LITERAL_CMP_RE = /(?:[<>]=?|==|!=)\s*(?:-?\d+(?:\.\d+)?[mMdDfFlLuU]?\b|"[^"]*")/;
// Comparison against a named constant: `Status.Closed`, `MAX_ITEMS`, `MaxQuantity`.
const NAMED_CMP_RE =
  /(?:[<>]=?|==|!=)\s*(?:[A-Z][A-Za-z0-9]*\.[A-Z]\w*|[A-Z][A-Z0-9_]{2,}\b|[A-Z][a-z]\w*\b)/;
// `x is Status.Closed` / `x is > 10` pattern matching.
const IS_PATTERN_RE = /\bis\s+(?:not\s+)?(?:[<>]=?\s*-?\d|[A-Z][A-Za-z0-9]*\.[A-Z]\w*)/;
// Log calls — an if whose body is only these is not a business rule.
const LOG_CALL_RE =
  /^\s*(?:_?logger|_?log|Log|Logger|this\._?logger|Console|Debug|Trace)\s*\.\s*(?:Log\w*|Write\w*|Info\w*|Warn\w*|Error\w*|Debug\w*|Trace\w*|Fatal\w*|Verbose\w*|Information\w*|Critical\w*)\s*\(/;
// A condition that only tests whether logging is enabled.
const LOG_LEVEL_COND_RE = /\bIsEnabled\s*\(|\bLogLevel\.|\bIs(?:Debug|Trace|Info)Enabled\b/;
const EXIT_RE = /^\s*(?:throw\b|return\b)/;
// FluentValidation rule entry points.
const FLUENT_START_RE = /\bRuleFor(?:Each)?\s*\(\s*\w+\s*=>\s*\w+\.([\w.]+)\s*\)/;
const FLUENT_VALIDATORS = new Set([
  "NotNull",
  "NotEmpty",
  "Null",
  "Empty",
  "Equal",
  "NotEqual",
  "Length",
  "MinimumLength",
  "MaximumLength",
  "LessThan",
  "LessThanOrEqualTo",
  "GreaterThan",
  "GreaterThanOrEqualTo",
  "InclusiveBetween",
  "ExclusiveBetween",
  "Matches",
  "EmailAddress",
  "CreditCard",
  "IsInEnum",
  "IsEnumName",
  "PrecisionScale",
  "Must",
  "MustAsync",
  "SetValidator",
]);
// `.Name(args)` segments of a fluent chain. Args stop at the first `)` that is
// not nested one level deep — enough for `GreaterThan(0)` / `Must(BeValid)` /
// `Must(x => x.Count() > 0)`.
const FLUENT_CALL_RE = /\.([A-Z]\w*)\s*\(((?:[^()]|\([^()]*\))*)\)/g;
const WITH_MESSAGE_RE = /\.WithMessage\s*\(\s*\$?@?"((?:[^"\\]|\\.)*)"/;

// System.ComponentModel.DataAnnotations (+ .NET 8 additions) validation attributes.
const VALIDATION_ATTRIBUTES = new Set([
  "Required",
  "Range",
  "RegularExpression",
  "StringLength",
  "MaxLength",
  "MinLength",
  "Length",
  "EmailAddress",
  "Phone",
  "Url",
  "CreditCard",
  "Compare",
  "AllowedValues",
  "DeniedValues",
  "Base64String",
  "FileExtensions",
  "EnumDataType",
]);

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function stripQuotes(s: string): string {
  return s.replace(/^\$?@?"|"$/g, "").trim();
}

/** Whether a condition compares against a literal or a named constant. */
function comparesToConstant(cond: string): boolean {
  return LITERAL_CMP_RE.test(cond) || NAMED_CMP_RE.test(cond) || IS_PATTERN_RE.test(cond);
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

/**
 * Split an attribute section's inner text on top-level commas, respecting
 * parentheses and string literals: `Required, Range(1, 10)` → two entries.
 */
function splitAttributes(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (ch === '"') {
      k = skipString(inner, k);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, k).trim());
      start = k + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out.filter((s) => s.length > 0);
}

/**
 * Index of the closing quote of the string literal opening at `open`. A
 * verbatim string (`@"..."`, `$@"..."`) treats backslash literally and escapes a
 * quote as `""`; a regular string escapes with backslash. Unterminated → end.
 */
function skipString(text: string, open: number): number {
  const verbatim = text[open - 1] === "@" || (text[open - 1] === "$" && text[open - 2] === "@");
  for (let p = open + 1; p < text.length; p++) {
    const ch = text[p];
    if (verbatim) {
      if (ch === '"') {
        if (text[p + 1] === '"') p++;
        else return p;
      }
    } else if (ch === "\\") p++;
    else if (ch === '"') return p;
  }
  return text.length;
}

/**
 * Attribute sections at the start of a line: `[Required]`, `[Required, Range(1, 5)]`,
 * `[RegularExpression(@"^[A-Z]{3}$")] public string Code { get; set; }`. Brackets
 * inside string literals do not end a section. Returns the inner text of each.
 */
function leadingAttributeSections(line: string): string[] {
  const sections: string[] = [];
  let k = 0;
  while (k < line.length) {
    while (k < line.length && /\s/.test(line[k])) k++;
    if (line[k] !== "[") break;
    let depth = 0;
    let end = -1;
    for (let p = k; p < line.length; p++) {
      const ch = line[p];
      if (ch === '"') {
        p = skipString(line, p);
        continue;
      }
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          end = p;
          break;
        }
      }
    }
    if (end === -1) break;
    sections.push(line.slice(k + 1, end));
    k = end + 1;
  }
  return sections;
}

function summarizeAttribute(name: string, args: string): string {
  const a = args.trim();
  switch (name) {
    case "Required":
      return "Field is required";
    case "Range":
      return `Value must be within range ${truncate(a, 100)}`;
    case "RegularExpression":
      return `Must match pattern ${truncate(a, 100)}`;
    case "StringLength":
    case "MaxLength":
    case "MinLength":
    case "Length":
      return `Length constraint ${name}(${truncate(a, 100)})`;
    case "EmailAddress":
      return "Must be a valid email address";
    case "Compare":
      return `Must match ${truncate(a, 100)}`;
    default:
      return `${name}${a ? `(${truncate(a, 100)})` : ""} validation`;
  }
}

/**
 * Mine all rule-bearing C# patterns from a source slice.
 *
 * @param source   Raw source text (a method body, a whole file, or any slice).
 * @param filePath Relative path — stored on each rule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name (e.g. "OrderService.Place").
 */
export function mineCsRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
  /**
   * Most rules returned (default {@link MAX_RULES}). Docs-gen Phase 1 passes
   * `Infinity`: it mines whole files and must not lose any rule past the cap.
   */
  maxRules: number = MAX_RULES,
): MinedCsRule[] {
  const rules: MinedCsRule[] = [];
  const lines = source.split("\n");
  const push = (kind: MinedCsRule["kind"], expression: string, summary: string, i: number) => {
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

    // ---- 1. validation attributes (may share a line with the member) ----
    for (const section of leadingAttributeSections(raw)) {
      for (const attr of splitAttributes(section)) {
        const m = /^([A-Za-z_][\w.]*?)(?:Attribute)?\s*(?:\(([\s\S]*)\))?$/.exec(attr);
        if (!m) continue;
        const name = m[1].split(".").pop() ?? m[1];
        if (!VALIDATION_ATTRIBUTES.has(name)) continue;
        push("validation-attribute", `[${attr}]`, summarizeAttribute(name, m[2] ?? ""), i);
      }
    }

    // ---- 2. constants ----
    const cMatch = CONST_RE.exec(raw);
    if (cMatch) {
      push("const", line, `Constant \`${cMatch[1]}\` = ${truncate(cMatch[2], 120)}`, i);
      continue;
    }

    // ---- 3. FluentValidation chains (may span lines up to the closing `;`) ----
    const fMatch = FLUENT_START_RE.exec(raw);
    if (fMatch) {
      // Accumulate to the `;` that ends the statement at bracket depth 0, so a
      // multi-line `Must(c => { ...; })` lambda stays inside its chain.
      let stmt = "";
      let depth = 0;
      let j = i;
      for (; j < Math.min(i + LOOKAHEAD, lines.length); j++) {
        const l = lines[j].trim();
        stmt += stmt ? ` ${l}` : l;
        for (const ch of l) {
          if (ch === "(" || ch === "{") depth++;
          else if (ch === ")" || ch === "}") depth--;
        }
        if (depth <= 0 && l.endsWith(";")) break;
      }
      const validators: string[] = [];
      FLUENT_CALL_RE.lastIndex = 0;
      let vm: RegExpExecArray | null;
      while ((vm = FLUENT_CALL_RE.exec(stmt)) !== null) {
        if (FLUENT_VALIDATORS.has(vm[1])) {
          validators.push(`${vm[1]}(${truncate(vm[2], 60)})`);
        }
      }
      if (validators.length > 0) {
        const msg = WITH_MESSAGE_RE.exec(stmt);
        push(
          "fluent-rule",
          stmt,
          `Field \`${fMatch[1]}\` rules: ${validators.join(", ")}${msg ? ` — "${truncate(msg[1], 100)}"` : ""}`,
          i,
        );
        // The chain's continuation lines belong to this rule — do not mine a
        // guard inside a `Must(...)` lambda a second time.
        i = j;
        continue;
      }
      // No recognised validator: fall through so other passes still see the line.
    }

    // ---- 4. .NET guard helpers ----
    const hMatch = THROW_HELPER_RE.exec(raw);
    if (hMatch) {
      push(
        "precondition",
        line,
        `${hMatch[2]} guard on ${truncate(hMatch[3], 120)} (${hMatch[1]})`,
        i,
      );
      continue;
    }
    const gMatch = GUARD_AGAINST_RE.exec(raw);
    if (gMatch) {
      push("precondition", line, `Guard against ${gMatch[1]}: ${truncate(gMatch[2], 120)}`, i);
      continue;
    }

    // ---- 5. throws ----
    const tMatch = THROW_RE.exec(raw);
    if (tMatch) {
      const msg = tMatch[2] ? stripQuotes(tMatch[2]) : "";
      push("throw", line, `Throws ${tMatch[1]}${msg ? `: ${truncate(msg, 140)}` : ""}`, i);
      // Fall through — an inline `if (...) throw` also encodes the guard.
    }

    // ---- 6. switch statements / expressions ----
    const sHead = SWITCH_RE.exec(raw);
    const sMatch = sHead && sHead[1].trim() ? sHead : null;
    const seMatch = sMatch ? null : SWITCH_EXPR_RE.exec(raw);
    if (sMatch || seMatch) {
      const subject = (sMatch ?? seMatch)![1].trim();
      const labels: string[] = [];
      let depth = 0;
      let started = false;
      for (let j = i; j < Math.min(i + LOOKAHEAD, lines.length); j++) {
        if (j > i) {
          const lab = sMatch ? CASE_RE.exec(lines[j]) : ARM_RE.exec(lines[j]);
          if (lab && depth === 1) {
            const label = lab[1].split(/\bwhen\b/)[0].trim();
            if (label && label !== "_") labels.push(label);
          }
        }
        for (const ch of lines[j]) {
          if (ch === "{") {
            depth++;
            started = true;
          } else if (ch === "}") depth--;
        }
        if (started && depth <= 0) break;
      }
      if (labels.length > 0) {
        push(
          "switch-case",
          `switch(${subject}) { ${labels.join("; ")} }`,
          `State dispatch on \`${subject}\` with ${labels.length} branches: ${labels.slice(0, 8).join(", ")}${labels.length > 8 ? ", ..." : ""}`,
          i,
        );
      }
      continue;
    }

    // ---- 7. guard clauses ----
    const inline = INLINE_IF_RE.exec(raw);
    if (inline) {
      push("guard", line, `Rejects when ${truncate(inline[1], 140)}`, i);
      continue;
    }
    const inlineStmt = INLINE_STMT_IF_RE.exec(raw);
    if (inlineStmt && !IF_RE.test(raw)) {
      // `if (x > 10) DoSomething();` — a rule only when it is not a log line.
      const cond = inlineStmt[1];
      if (!LOG_CALL_RE.test(inlineStmt[2]) && !LOG_LEVEL_COND_RE.test(cond)) {
        if (comparesToConstant(cond)) {
          push("guard", line, `Branches on threshold ${truncate(cond, 140)}`, i);
        }
      }
      continue;
    }
    const ifMatch = IF_RE.exec(raw);
    if (ifMatch) {
      const cond = ifMatch[1];
      if (LOG_LEVEL_COND_RE.test(cond)) continue;
      const body = ifBody(lines, i);
      if (isLoggingOnly(body)) continue;
      const exits = exitsAfterLogging(body);
      if (exits) {
        push("guard", line, `Rejects/exits when ${truncate(cond, 140)}`, i);
      } else if (comparesToConstant(cond)) {
        push("guard", line, `Branches on threshold ${truncate(cond, 140)}`, i);
      }
      continue;
    }

    // ---- 8. threshold ternary: `var fee = total > FreeShippingMin ? 0 : 5;` ----
    if (!tMatch && line.includes("?") && line.includes(":")) {
      const condMatch = /=\s*([^=?][^?]*?)\s*\?(?!\?)/.exec(line);
      if (condMatch && comparesToConstant(condMatch[1])) {
        push("guard", line, `Branches on threshold ${truncate(condMatch[1], 140)}`, i);
      }
    }
  }

  return rules;
}

/**
 * Render mined C# rules as a compact markdown-ish block for an LLM prompt.
 * Mirrors {@link renderMinedTsRules}.
 */
export function renderMinedCsRules(rules: MinedCsRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  const groups = new Map<MinedCsRule["kind"], MinedCsRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedCsRule["kind"][] = [
    "validation-attribute",
    "fluent-rule",
    "precondition",
    "guard",
    "throw",
    "switch-case",
    "const",
  ];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${csKindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more C# rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function csKindLabel(k: MinedCsRule["kind"]): string {
  switch (k) {
    case "validation-attribute":
      return "Validation attributes (DataAnnotations)";
    case "fluent-rule":
      return "FluentValidation rules";
    case "precondition":
      return "Guard helpers (ThrowIf / Guard.Against)";
    case "guard":
      return "Guards (validation + reject)";
    case "throw":
      return "Throws (failure modes)";
    case "switch-case":
      return "State machines (switch)";
    case "const":
      return "Constants / thresholds";
  }
}
