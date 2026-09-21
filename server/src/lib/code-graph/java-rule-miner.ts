/**
 * Java-specific business rule miner.
 *
 * Why this exists: the LLM-driven Phase 1 fact extraction in
 * docs-gen/holistic-synthesizer.ts misses categories of rules that are
 * trivially identifiable by structure but easy for an LLM to overlook
 * in dense source dumps:
 *
 *   1. Bean Validation annotations (`@NotNull`, `@Size(min=1,max=255)`,
 *      `@Min`, `@Max`, `@Pattern`, `@AssertTrue`, `@DecimalMin`, etc.) \u2014
 *      these ARE business rules expressed declaratively.
 *   2. Defensive preconditions (`Objects.requireNonNull(...)`,
 *      `Preconditions.checkArgument(...)`, `Validate.isTrue(...)`,
 *      `Assert.notNull(...)`) \u2014 each is a discrete validation rule.
 *   3. Explicit `throw new XxxException(message)` \u2014 every throw is a
 *      documented failure mode that should appear in the rules catalog.
 *   4. `switch` / `case` blocks on enum status fields \u2014 these encode
 *      state machines and should be surfaced as STATUS_TRANSITIONS.
 *
 * This miner runs deterministic regex passes over the raw source (no
 * LLM call) and produces a structured inventory that gets injected into
 * the Phase 1 user prompt as a "MUST INCLUDE THESE RULES" checklist.
 *
 * The miner is regex-based (not tree-sitter) because:
 *   - It runs per-method-slice, not per-whole-file, and slices may not
 *     parse cleanly out of context.
 *   - The patterns we care about are line-local and unambiguous.
 *   - Tree-sitter loading adds 200ms+ of WASM init we don't need here.
 *
 * If false positives become a problem we can swap to tree-sitter queries
 * later without changing the public API.
 */

export interface MinedRule {
  kind: "annotation-validation" | "precondition" | "throw" | "switch-case" | "null-guard";
  /** Raw line as found in source (trimmed). */
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

// Bean Validation / Hibernate Validator / Jakarta annotations.
// Pattern matches `@AnnotationName` optionally followed by `(args)`.
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
  "ScriptAssert",
  "UniqueElements",
  "ConvertGroup",
]);

const ANNOTATION_RE = /@([A-Z][A-Za-z0-9_]*)\s*(\([^)]*\))?/g;

// Defensive precondition method calls. The capture group is the
// argument list which usually contains the condition + message.
const PRECONDITION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /Objects\.requireNonNull\s*\(([^;]+)\)/g, label: "Null guard" },
  {
    re: /Preconditions\.check(?:Argument|State|NotNull|Element\s*Index|Position\s*Index)\s*\(([^;]+)\)/g,
    label: "Guava precondition",
  },
  {
    re: /Validate\.(?:notNull|notEmpty|notBlank|isTrue|matchesPattern|inclusiveBetween|exclusiveBetween)\s*\(([^;]+)\)/g,
    label: "Apache Commons Validate",
  },
  {
    re: /Assert\.(?:notNull|notEmpty|hasText|hasLength|isTrue|isInstanceOf|state)\s*\(([^;]+)\)/g,
    label: "Spring Assert",
  },
  {
    re: /(?:require|check|ensure)(?:NonNull|NotNull|That|State|Argument)\s*\(([^;]+)\)/g,
    label: "Custom precondition",
  },
];

// `throw new XxxException("message")` \u2014 every throw documents a failure mode.
const THROW_RE = /throw\s+new\s+([A-Z]\w*(?:Exception|Error|Throwable))\s*\(([^;]*)\)\s*;?/g;

// `switch (xxxStatus)` / `case STATE:` \u2014 captures state machine transitions.
const SWITCH_RE = /switch\s*\(\s*([\w.()]+)\s*\)/;
const CASE_RE = /case\s+([A-Z][A-Z0-9_]*)\s*:/g;

// `if (x == null)` / `if (x != null)` style null checks that throw or return early.
const NULL_GUARD_RE = /if\s*\(\s*(\w+(?:\.\w+)*)\s*[!=]=\s*null\s*\)/;

/**
 * Mine all rule-bearing patterns from a source slice.
 *
 * @param source     Raw source text (a method body, a whole file, or any slice).
 * @param filePath   Relative path \u2014 stored on each MinedRule for traceability.
 * @param baseLine   1-based line number that source[0] corresponds to. When
 *                   mining a method slice extracted from the middle of a
 *                   file, pass the method's startLine so reported line
 *                   numbers stay accurate against the original file.
 * @param context    Optional symbol qualified name (e.g. "BidValidator.validate").
 */
export function mineJavaRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
): MinedRule[] {
  const rules: MinedRule[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = baseLine + i;

    // ---- 1. Validation annotations ----
    let aMatch: RegExpExecArray | null;
    ANNOTATION_RE.lastIndex = 0;
    while ((aMatch = ANNOTATION_RE.exec(line)) !== null) {
      const name = aMatch[1];
      if (!VALIDATION_ANNOTATIONS.has(name)) continue;
      const args = aMatch[2] ?? "";
      rules.push({
        kind: "annotation-validation",
        expression: `@${name}${args}`,
        summary: summarizeAnnotation(name, args),
        filePath,
        line: lineNum,
        context,
      });
    }

    // ---- 2. Precondition method calls ----
    for (const { re, label } of PRECONDITION_PATTERNS) {
      re.lastIndex = 0;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = re.exec(line)) !== null) {
        const args = pMatch[1].trim();
        rules.push({
          kind: "precondition",
          expression: pMatch[0].trim(),
          summary: `${label}: ${truncate(args, 160)}`,
          filePath,
          line: lineNum,
          context,
        });
      }
    }

    // ---- 3. Throws ----
    THROW_RE.lastIndex = 0;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = THROW_RE.exec(line)) !== null) {
      const exType = tMatch[1];
      const message = tMatch[2].trim();
      rules.push({
        kind: "throw",
        expression: tMatch[0].trim(),
        summary: `Throws ${exType}${message ? `: ${truncate(stripQuotes(message), 160)}` : ""}`,
        filePath,
        line: lineNum,
        context,
      });
    }

    // ---- 4. Switch/case state transitions ----
    const sMatch = line.match(SWITCH_RE);
    if (sMatch) {
      const subject = sMatch[1];
      // Look ahead for case labels until matching close brace or 100 lines.
      const cases: string[] = [];
      let depth = 0;
      let started = false;
      for (let j = i; j < Math.min(i + 100, lines.length); j++) {
        for (const ch of lines[j]) {
          if (ch === "{") {
            depth++;
            started = true;
          } else if (ch === "}") depth--;
        }
        CASE_RE.lastIndex = 0;
        let cMatch: RegExpExecArray | null;
        while ((cMatch = CASE_RE.exec(lines[j])) !== null) {
          cases.push(cMatch[1]);
        }
        if (started && depth <= 0) break;
      }
      if (cases.length > 0) {
        rules.push({
          kind: "switch-case",
          expression: `switch(${subject}) { ${cases.map((c) => `case ${c}`).join("; ")} }`,
          summary: `State dispatch on \`${subject}\` with ${cases.length} branches: ${cases.slice(0, 8).join(", ")}${cases.length > 8 ? ", ..." : ""}`,
          filePath,
          line: lineNum,
          context,
        });
      }
    }

    // ---- 5. Null guards (only when paired with throw/return on next non-blank line) ----
    const nMatch = line.match(NULL_GUARD_RE);
    if (nMatch) {
      // Peek ahead up to 3 lines for an early return or throw to confirm it's a guard.
      let isGuard = false;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (next.length === 0 || next === "{") continue;
        if (next.startsWith("throw") || next.startsWith("return")) {
          isGuard = true;
        }
        break;
      }
      if (isGuard) {
        rules.push({
          kind: "null-guard",
          expression: line.trim(),
          summary: `Null guard on \`${nMatch[1]}\` with early exit`,
          filePath,
          line: lineNum,
          context,
        });
      }
    }
  }

  return rules;
}

/**
 * Render a list of mined rules as a compact markdown-ish block suitable
 * for embedding in an LLM prompt. Caps total length to keep prompt
 * budget under control.
 */
export function renderMinedRules(rules: MinedRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  // Group by kind for legibility.
  const groups = new Map<MinedRule["kind"], MinedRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedRule["kind"][] = [
    "annotation-validation",
    "precondition",
    "throw",
    "switch-case",
    "null-guard",
  ];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${kindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... ${list.length - parts.length} more rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function kindLabel(k: MinedRule["kind"]): string {
  switch (k) {
    case "annotation-validation":
      return "Bean Validation Annotations";
    case "precondition":
      return "Defensive Preconditions";
    case "throw":
      return "Explicit Throws (failure modes)";
    case "switch-case":
      return "State Machines (switch/case)";
    case "null-guard":
      return "Null Guards with Early Exit";
  }
}

function summarizeAnnotation(name: string, args: string): string {
  const cleanArgs = args.replace(/^\(|\)$/g, "").trim();
  switch (name) {
    case "NotNull":
    case "NotBlank":
    case "NotEmpty":
      return `Field must not be ${name === "NotNull" ? "null" : name === "NotBlank" ? "blank" : "empty"}`;
    case "Size":
    case "Length":
      return `Length/size constraint: ${cleanArgs || "default bounds"}`;
    case "Min":
    case "Max":
    case "DecimalMin":
    case "DecimalMax":
      return `Numeric bound: ${name} ${cleanArgs}`;
    case "Pattern":
      return `Regex constraint: ${truncate(cleanArgs, 100)}`;
    case "Email":
      return "Must be a valid email address";
    case "Past":
    case "PastOrPresent":
    case "Future":
    case "FutureOrPresent":
      return `Temporal constraint: ${name}`;
    case "AssertTrue":
    case "AssertFalse":
      return `Boolean assertion: must be ${name === "AssertTrue" ? "true" : "false"}`;
    case "Valid":
    case "Validated":
      return "Cascade validation to nested object";
    case "Range":
      return `Range constraint: ${cleanArgs}`;
    case "Positive":
    case "PositiveOrZero":
    case "Negative":
    case "NegativeOrZero":
      return `Sign constraint: ${name}`;
    default:
      return `${name}${cleanArgs ? `(${truncate(cleanArgs, 80)})` : ""} validation`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}

function stripQuotes(s: string): string {
  return s
    .replace(/^["']|["']$/g, "")
    .replace(/^["']\s*\+\s*/, "")
    .trim();
}
