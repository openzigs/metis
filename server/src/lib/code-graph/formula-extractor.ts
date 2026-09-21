/**
 * Epic #486 / Issue #488 — Formula & Business Rule Extractor.
 *
 * Uses tree-sitter queries to extract:
 * - Arithmetic expressions (assignments involving math ops)
 * - Constants and magic numbers
 * - Conditional business logic (complex if-else chains)
 * - Validation patterns (range checks, null guards, regex matches)
 *
 * Supports TypeScript/JavaScript and Java.
 */
import type { Language } from "./parsers.js";

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
