/**
 * Epic #486 / Issue #488 — Formula & Business Rule Extractor.
 *
 * Uses tree-sitter queries to extract:
 * - Arithmetic expressions (assignments involving math ops)
 * - Constants and magic numbers
 * - Conditional business logic (complex if-else chains)
 * - Validation patterns (range checks, null guards, regex matches)
 *
 * Supports TypeScript/JavaScript, Java, Python and Go; constants and arithmetic
 * assignments for Scala, Rust, C and C++ (#161).
 */
import type { Language } from "./parsers.js";
import { isLiteralValue, trailingIdentifier } from "./rule-miner-brace-shared.js";

export interface ExtractedFormula {
  /** Type of the extracted pattern */
  kind: "arithmetic" | "constant" | "business-rule" | "validation";
  /** Raw expression text from source */
  expression: string;
  /** Resolved description of what the formula does */
  description: string;
  /** Variable/constant name if applicable */
  name: string | null;
  /** Resolved constant value if applicable */
  resolvedValue: string | null;
  /** Source file path */
  filePath: string;
  /** Start line (1-based) */
  startLine: number;
  /** End line (1-based) */
  endLine: number;
  /** Containing symbol qualified name (if linkable) */
  symbolContext: string | null;
}

// Arithmetic operators to detect formulas
const MATH_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "Math.",
  "pow",
  "sqrt",
  "ceil",
  "floor",
  "round",
  "abs",
]);
/**
 * Extract formulas and business rules from source code.
 */
export function extractFormulas(
  source: string,
  filePath: string,
  language: Language,
): ExtractedFormula[] {
  const lines = source.split("\n");
  const formulas: ExtractedFormula[] = [];

  switch (language) {
    case "ts":
    case "js":
      extractTsFormulas(lines, filePath, formulas);
      break;
    case "java":
      extractJavaFormulas(lines, filePath, formulas);
      break;
    case "py":
      extractPythonFormulas(lines, filePath, formulas);
      break;
    case "go":
      extractGoFormulas(lines, filePath, formulas);
      break;
    case "scala":
    case "rs":
    case "c":
    case "cpp":
      extractBraceFamilyFormulas(lines, filePath, formulas, language);
      break;
    default:
      // Fallback: basic pattern matching for any language
      extractGenericFormulas(lines, filePath, formulas);
  }

  return formulas;
}

// ============================================================================
// TypeScript / JavaScript extraction
// ============================================================================

const TS_CONST_PATTERN =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::\s*\w+)?\s*=\s*(.+?);?\s*$/;
const TS_FORMULA_ASSIGN = /^\s*(?:(?:const|let|var)\s+)?(\w+)\s*(?::\s*\w+)?\s*=\s*(.+?);?\s*$/;
const TS_VALIDATION_PATTERN = /^\s*if\s*\(\s*(.+?)\s*\)\s*\{?\s*$/;
const TS_BUSINESS_RULE_KEYWORDS =
  /(?:threshold|limit|max|min|rate|factor|multiplier|discount|tax|fee|penalty|bonus|interest|margin|tolerance)/i;

function extractTsFormulas(lines: string[], filePath: string, out: ExtractedFormula[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Constants (UPPER_CASE assignments)
    const constMatch = line.match(TS_CONST_PATTERN);
    if (constMatch) {
      out.push({
        kind: "constant",
        expression: constMatch[2].trim(),
        description: `Constant ${constMatch[1]}`,
        name: constMatch[1],
        resolvedValue: constMatch[2].trim(),
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        symbolContext: null,
      });
      continue;
    }

    // Arithmetic formula assignments
    const assignMatch = line.match(TS_FORMULA_ASSIGN);
    if (assignMatch && containsMathOps(assignMatch[2])) {
      const expr = assignMatch[2].trim();
      if (expr.length > 10 && !expr.startsWith("await") && !expr.startsWith("new")) {
        out.push({
          kind: "arithmetic",
          expression: expr,
          description: `Calculation for ${assignMatch[1]}`,
          name: assignMatch[1],
          resolvedValue: null,
          filePath,
          startLine: lineNum,
          endLine: lineNum,
          symbolContext: null,
        });
      }
    }

    // Business rule conditionals
    const condMatch = line.match(TS_VALIDATION_PATTERN);
    if (condMatch) {
      const cond = condMatch[1];
      if (TS_BUSINESS_RULE_KEYWORDS.test(cond) || countComparisonOps(cond) >= 2) {
        const endLine = findBlockEnd(lines, i);
        out.push({
          kind: "business-rule",
          expression: cond,
          description: describeBusinessRule(cond),
          name: null,
          resolvedValue: null,
          filePath,
          startLine: lineNum,
          endLine: endLine + 1,
          symbolContext: null,
        });
      } else if (isValidationPattern(cond)) {
        out.push({
          kind: "validation",
          expression: cond,
          description: describeValidation(cond),
          name: null,
          resolvedValue: null,
          filePath,
          startLine: lineNum,
          endLine: lineNum,
          symbolContext: null,
        });
      }
    }
  }
}

// ============================================================================
// Java extraction
// ============================================================================

const JAVA_CONST_PATTERN =
  /^\s*(?:public|private|protected)?\s*(?:static)?\s*(?:final)\s+\w+\s+([A-Z][A-Z0-9_]*)\s*=\s*(.+?);?\s*$/;
const JAVA_FORMULA_ASSIGN = /^\s*(?:\w+\s+)?(\w+)\s*=\s*(.+?);?\s*$/;
const JAVA_VALIDATION = /^\s*if\s*\(\s*(.+?)\s*\)\s*\{?\s*$/;

function extractJavaFormulas(lines: string[], filePath: string, out: ExtractedFormula[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const constMatch = line.match(JAVA_CONST_PATTERN);
    if (constMatch) {
      out.push({
        kind: "constant",
        expression: constMatch[2].trim(),
        description: `Constant ${constMatch[1]}`,
        name: constMatch[1],
        resolvedValue: constMatch[2].trim(),
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        symbolContext: null,
      });
      continue;
    }

    const assignMatch = line.match(JAVA_FORMULA_ASSIGN);
    if (assignMatch && containsMathOps(assignMatch[2])) {
      const expr = assignMatch[2].trim();
      if (expr.length > 10 && !expr.startsWith("new")) {
        out.push({
          kind: "arithmetic",
          expression: expr,
          description: `Calculation for ${assignMatch[1]}`,
          name: assignMatch[1],
          resolvedValue: null,
          filePath,
          startLine: lineNum,
          endLine: lineNum,
          symbolContext: null,
        });
      }
    }

    const condMatch = line.match(JAVA_VALIDATION);
    if (condMatch) {
      const cond = condMatch[1];
      if (TS_BUSINESS_RULE_KEYWORDS.test(cond) || countComparisonOps(cond) >= 2) {
        out.push({
          kind: "business-rule",
          expression: cond,
          description: describeBusinessRule(cond),
          name: null,
          resolvedValue: null,
          filePath,
          startLine: lineNum,
          endLine: findBlockEnd(lines, i) + 1,
          symbolContext: null,
        });
      }
    }
  }
}

// ============================================================================
// Python extraction
// ============================================================================

const PY_CONST_PATTERN = /^\s*([A-Z][A-Z0-9_]*)\s*(?::\s*\w+)?\s*=\s*(.+?)\s*$/;
const PY_FORMULA_ASSIGN = /^\s*(\w+)\s*=\s*(.+?)\s*$/;
const PY_VALIDATION = /^\s*if\s+(.+?)\s*:\s*$/;

function extractPythonFormulas(lines: string[], filePath: string, out: ExtractedFormula[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const constMatch = line.match(PY_CONST_PATTERN);
    if (constMatch) {
      out.push({
        kind: "constant",
        expression: constMatch[2].trim(),
        description: `Constant ${constMatch[1]}`,
        name: constMatch[1],
        resolvedValue: constMatch[2].trim(),
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        symbolContext: null,
      });
      continue;
    }

    const assignMatch = line.match(PY_FORMULA_ASSIGN);
    if (assignMatch && containsMathOps(assignMatch[2]) && !assignMatch[1].startsWith("_")) {
      const expr = assignMatch[2].trim();
      if (expr.length > 10) {
        out.push({
          kind: "arithmetic",
          expression: expr,
          description: `Calculation for ${assignMatch[1]}`,
          name: assignMatch[1],
          resolvedValue: null,
          filePath,
          startLine: lineNum,
          endLine: lineNum,
          symbolContext: null,
        });
      }
    }

    const condMatch = line.match(PY_VALIDATION);
    if (condMatch) {
      const cond = condMatch[1];
      if (TS_BUSINESS_RULE_KEYWORDS.test(cond) || countComparisonOps(cond) >= 2) {
        out.push({
          kind: "business-rule",
          expression: cond,
          description: describeBusinessRule(cond),
          name: null,
          resolvedValue: null,
          filePath,
          startLine: lineNum,
          endLine: lineNum,
          symbolContext: null,
        });
      }
    }
  }
}

// ============================================================================
// Go extraction
// ============================================================================

const GO_CONST_PATTERN = /^\s*(?:const\s+)?([A-Z][A-Za-z0-9_]*)\s*(?:\w+)?\s*=\s*(.+?)\s*$/;

function extractGoFormulas(lines: string[], filePath: string, out: ExtractedFormula[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const constMatch = line.match(GO_CONST_PATTERN);
    if (constMatch && !line.includes("func")) {
      out.push({
        kind: "constant",
        expression: constMatch[2].trim(),
        description: `Constant ${constMatch[1]}`,
        name: constMatch[1],
        resolvedValue: constMatch[2].trim(),
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        symbolContext: null,
      });
    }

    // Go formula assignments
    if (
      (line.includes(":=") || line.includes("=")) &&
      containsMathOps(line) &&
      !line.includes("func")
    ) {
      const match = line.match(/^\s*(\w+)\s*:?=\s*(.+?)\s*$/);
      if (match && match[2].length > 10) {
        out.push({
          kind: "arithmetic",
          expression: match[2].trim(),
          description: `Calculation for ${match[1]}`,
          name: match[1],
          resolvedValue: null,
          filePath,
          startLine: lineNum,
          endLine: lineNum,
          symbolContext: null,
        });
      }
    }
  }
}

// ============================================================================
// Scala / Rust / C / C++ extraction — Issue #161
//
// Constants (a literal bound to a constant-looking or const-qualified name)
// and arithmetic assignments. Linear: the assignment is split with indexOf,
// never with a regex that could backtrack across the line, and the name is
// read by a bounded character scan.
// ============================================================================

/** `x = …` split at its first plain `=` (not `==`, `<=`, `>=`, `!=`, `=>`, `+=` …). */
function splitAssignment(code: string): { left: string; right: string } | null {
  for (let k = 1; k < code.length - 1; k++) {
    if (code[k] !== "=") continue;
    const before = code[k - 1];
    const after = code[k + 1];
    if ("=!<>+-*/%&|^:".includes(before) || after === "=" || after === ">") continue;
    return { left: code.slice(0, k).trim(), right: code.slice(k + 1).trim() };
  }
  return null;
}

/** The declared name on an assignment's left side: `val Rate: Double` → `Rate`. */
function declaredName(left: string, language: Language): string {
  let l = left;
  if (language === "scala" || language === "rs") {
    // `name: Type` — the type follows a colon (Rust paths use `::`, skipped).
    for (let k = 0; k < l.length; k++) {
      if (l[k] === ":" && l[k + 1] !== ":" && l[k - 1] !== ":") {
        l = l.slice(0, k);
        break;
      }
    }
  }
  if (l.endsWith("]")) l = l.slice(0, l.lastIndexOf("["));
  return trailingIdentifier(l);
}

const BRACE_CONST_KEYWORD: Record<string, RegExp> = {
  // A capitalised `val` (Scala's constant convention).
  scala: /^(?:(?:private|protected|final|override|lazy)\s+)*val\s+[A-Z]/,
  rs: /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s/,
  c: /\b(?:const|constexpr)\b/,
  cpp: /\b(?:const|constexpr)\b/,
};
const C_DEFINE_RE = /^#\s*define\s+([A-Za-z_]\w*)[ \t]+(\S.*)$/;

function extractBraceFamilyFormulas(
  lines: string[],
  filePath: string,
  out: ExtractedFormula[],
  language: Language,
): void {
  const constKeyword = BRACE_CONST_KEYWORD[language];
  for (let i = 0; i < lines.length; i++) {
    let code = lines[i].trim();
    const comment = code.indexOf("//");
    if (comment >= 0) code = code.slice(0, comment).trim();
    if (code.endsWith(";")) code = code.slice(0, -1).trim();
    if (code.length === 0) continue;
    const lineNum = i + 1;
    const push = (
      kind: ExtractedFormula["kind"],
      name: string,
      expression: string,
      resolvedValue: string | null,
    ) =>
      out.push({
        kind,
        expression,
        description: kind === "constant" ? `Constant ${name}` : `Calculation for ${name}`,
        name,
        resolvedValue,
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        symbolContext: null,
      });

    const def = language === "c" || language === "cpp" ? C_DEFINE_RE.exec(code) : null;
    if (def) {
      const value = def[2].trim();
      if (isLiteralValue(value)) push("constant", def[1], value, value);
      else if (containsMathOps(value) && value.length > 10) push("arithmetic", def[1], value, null);
      continue;
    }
    const assign = splitAssignment(code);
    if (!assign) continue;
    const name = declaredName(assign.left, language);
    if (!name) continue;
    const { right } = assign;
    if (constKeyword.test(assign.left) && isLiteralValue(right)) {
      push("constant", name, right, right);
      continue;
    }
    // A calculation: arithmetic on the right, not a call-only or string value.
    if (
      right.length > 10 &&
      containsMathOps(right) &&
      !right.startsWith('"') &&
      !right.startsWith("new ") &&
      !right.startsWith("if ") &&
      !right.startsWith("match ")
    ) {
      push("arithmetic", name, right, null);
    }
  }
}

// ============================================================================
// Generic fallback extraction
// ============================================================================

function extractGenericFormulas(lines: string[], filePath: string, out: ExtractedFormula[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    // Only extract obvious constants (UPPER_CASE = value)
    const match = line.match(
      /^\s*(?:(?:export|public|private|protected|static|final|const|let|var)\s+)*([A-Z][A-Z0-9_]+)\s*=\s*(.+?)\s*[;]?\s*$/,
    );
    if (match) {
      out.push({
        kind: "constant",
        expression: match[2].trim(),
        description: `Constant ${match[1]}`,
        name: match[1],
        resolvedValue: match[2].trim(),
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        symbolContext: null,
      });
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function containsMathOps(expr: string): boolean {
  for (const op of MATH_OPS) {
    if (expr.includes(op)) return true;
  }
  // Also check for numeric literal arithmetic: number op number
  return /\d\s*[+\-*/%]\s*\d/.test(expr);
}

function countComparisonOps(expr: string): number {
  // Count distinct comparison operator occurrences without double-counting
  const matches = expr.match(/[!=<>]=?=?/g) ?? [];
  // Filter to only actual comparison operators
  const ops = matches.filter((m) => ["==", "===", "!=", "!==", "<", ">", "<=", ">="].includes(m));
  // Count logical operators as indicators of compound conditions
  const logicals = (expr.match(/&&|\|\|/g) ?? []).length;
  return ops.length + logicals;
}

function findBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }
    if (depth <= 0 && i > startIdx) return i;
  }
  return Math.min(startIdx + 10, lines.length - 1);
}

function isValidationPattern(cond: string): boolean {
  // Null/undefined checks, type guards, range checks
  return (
    cond.includes("null") ||
    cond.includes("undefined") ||
    cond.includes("typeof") ||
    cond.includes("instanceof") ||
    /\w+\s*[<>]=?\s*\d/.test(cond) ||
    cond.includes(".length") ||
    cond.includes(".test(") ||
    cond.includes(".match(")
  );
}

function describeBusinessRule(cond: string): string {
  if (cond.includes("threshold")) return "Threshold check";
  if (cond.includes("limit")) return "Limit enforcement";
  if (cond.includes("rate")) return "Rate calculation check";
  if (cond.includes("discount") || cond.includes("tax")) return "Financial rule";
  if (cond.includes("max") || cond.includes("min")) return "Boundary enforcement";
  return "Business rule condition";
}

function describeValidation(cond: string): string {
  if (cond.includes("null") || cond.includes("undefined")) return "Null/undefined guard";
  if (cond.includes("typeof")) return "Type check";
  if (cond.includes("instanceof")) return "Instance type validation";
  if (cond.includes(".length")) return "Length validation";
  if (cond.includes(".test(") || cond.includes(".match(")) return "Pattern validation";
  if (/[<>]=?/.test(cond)) return "Range validation";
  return "Input validation";
}
