/**
 * Epic #596 / Issue #616 — AST Parser for TypeScript, JavaScript, and Python.
 *
 * Parses source files into a simplified AST representation with
 * per-function/class summaries suitable for embedding and caching.
 * Uses regex-based lightweight parsing (no external AST dependencies)
 * to extract top-level constructs: classes, functions, interfaces, types.
 */

export type SupportedLanguage = "typescript" | "javascript" | "python";

export interface ASTNode {
  /** Symbol name (function/class/interface/type name). */
  name: string;
  /** Kind of construct. */
  kind: "function" | "class" | "method" | "interface" | "type" | "variable";
  /** 1-based start line in the source file. */
  startLine: number;
  /** 1-based end line in the source file. */
  endLine: number;
  /** The raw source code of this construct. */
  source: string;
  /** Signature (e.g. function params + return type). */
  signature: string;
  /** JSDoc or docstring, if present. */
  docstring: string | null;
  /** For class nodes, the child methods. */
  children: ASTNode[];
}

export interface ParseResult {
  filePath: string;
  language: SupportedLanguage;
  nodes: ASTNode[];
  /** Total lines in the file. */
  totalLines: number;
}

/**
 * Detect language from file extension.
 */
export function detectLanguage(filePath: string): SupportedLanguage | null {
  if (/\.tsx?$/.test(filePath)) return "typescript";
  if (/\.jsx?$/.test(filePath)) return "javascript";
  if (/\.py$/.test(filePath)) return "python";
  return null;
}

/**
 * Parse source code into a simplified AST.
 */
export function parseSource(filePath: string, source: string): ParseResult | null {
  const language = detectLanguage(filePath);
  if (!language) return null;

  const lines = source.split("\n");
  const nodes = language === "python" ? parsePython(lines) : parseTypeScriptOrJS(lines, language);

  return { filePath, language, nodes, totalLines: lines.length };
}

// ── TypeScript / JavaScript parser ──────────────────────────────────────

const TS_FUNCTION_RE =
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?\s*\{/;
const TS_ARROW_CONST_RE =
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^\s=]+)?\s*=>/;
const TS_CLASS_RE =
  /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/;
const TS_INTERFACE_RE = /^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/;
const TS_TYPE_RE = /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/;
const TS_METHOD_RE =
  /^\s+(?:(?:public|private|protected|static|readonly|async|abstract)\s+)*(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{;]+))?\s*[{;]/;
const JSDOC_START_RE = /^\s*\/\*\*/;
const JSDOC_END_RE = /\*\//;

function parseTypeScriptOrJS(lines: string[], _language: SupportedLanguage): ASTNode[] {
  const nodes: ASTNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check for JSDoc block preceding a construct
    let docstring: string | null = null;
    if (JSDOC_START_RE.test(line)) {
      const docLines: string[] = [];
      const docStart = i;
      while (i < lines.length) {
        docLines.push(lines[i]);
        if (JSDOC_END_RE.test(lines[i]) && i > docStart) break;
        if (i === docStart && JSDOC_END_RE.test(lines[i])) break;
        i++;
      }
      docstring = docLines.join("\n");
      i++;
      if (i >= lines.length) break;
    }

    const currentLine = lines[i];
    const trimmed = currentLine.trimStart();

    // Interface
    const ifaceMatch = trimmed.match(TS_INTERFACE_RE);
    if (ifaceMatch) {
      const startLine = i + 1;
      const endLine = findClosingBrace(lines, i);
      nodes.push({
        name: ifaceMatch[1],
        kind: "interface",
        startLine,
        endLine: endLine + 1,
        source: lines.slice(i, endLine + 1).join("\n"),
        signature: trimmed.replace(/\s*\{$/, ""),
        docstring,
        children: [],
      });
      i = endLine + 1;
      continue;
    }

    // Type alias
    const typeMatch = trimmed.match(TS_TYPE_RE);
    if (typeMatch) {
      const startLine = i + 1;
      const endLine = findStatementEnd(lines, i);
      nodes.push({
        name: typeMatch[1],
        kind: "type",
        startLine,
        endLine: endLine + 1,
        source: lines.slice(i, endLine + 1).join("\n"),
        signature: trimmed.split("=")[0].trim(),
        docstring,
        children: [],
      });
      i = endLine + 1;
      continue;
    }

    // Class
    const classMatch = trimmed.match(TS_CLASS_RE);
    if (classMatch) {
      const startLine = i + 1;
      const endLine = findClosingBrace(lines, i);
      const methods = extractMethods(lines, i + 1, endLine);
      nodes.push({
        name: classMatch[1],
        kind: "class",
        startLine,
        endLine: endLine + 1,
        source: lines.slice(i, endLine + 1).join("\n"),
        signature: trimmed.replace(/\s*\{$/, ""),
        docstring,
        children: methods,
      });
      i = endLine + 1;
      continue;
    }

    // Function declaration
    const funcMatch = trimmed.match(TS_FUNCTION_RE);
    if (funcMatch) {
      const startLine = i + 1;
      const endLine = findClosingBrace(lines, i);
      nodes.push({
        name: funcMatch[1],
        kind: "function",
        startLine,
        endLine: endLine + 1,
        source: lines.slice(i, endLine + 1).join("\n"),
        signature: buildSignature(funcMatch[1], funcMatch[3], funcMatch[4]),
        docstring,
        children: [],
      });
      i = endLine + 1;
      continue;
    }

    // Arrow function const
    const arrowMatch = trimmed.match(TS_ARROW_CONST_RE);
    if (arrowMatch) {
      const startLine = i + 1;
      const endLine = findClosingBrace(lines, i);
      nodes.push({
        name: arrowMatch[1],
        kind: "function",
        startLine,
        endLine: endLine + 1,
        source: lines.slice(i, endLine + 1).join("\n"),
        signature: arrowMatch[1],
        docstring,
        children: [],
      });
      i = endLine + 1;
      continue;
    }

    i++;
  }

  return nodes;
}

function extractMethods(lines: string[], start: number, end: number): ASTNode[] {
  const methods: ASTNode[] = [];
  for (let i = start; i < end; i++) {
    const match = lines[i].match(TS_METHOD_RE);
    if (match && match[1] !== "constructor") {
      const methodEnd = findClosingBrace(lines, i);
      methods.push({
        name: match[1],
        kind: "method",
        startLine: i + 1,
        endLine: methodEnd + 1,
        source: lines.slice(i, methodEnd + 1).join("\n"),
        signature: buildSignature(match[1], match[3], match[4]),
        docstring: null,
        children: [],
      });
      i = methodEnd;
    }
  }
  return methods;
}

function buildSignature(name: string, params?: string, returnType?: string): string {
  const p = params?.trim() ?? "";
  const r = returnType ? `: ${returnType}` : "";
  return `${name}(${p})${r}`;
}

function findClosingBrace(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

function findStatementEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth--;
    }
    if (depth <= 0 && (lines[i].trimEnd().endsWith(";") || lines[i].trimEnd().endsWith(","))) {
      return i;
    }
  }
  return start;
}

// ── Python parser ───────────────────────────────────────────────────────

const PY_FUNCTION_RE = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\S+))?\s*:/;
const PY_CLASS_RE = /^(\s*)class\s+(\w+)(?:\([^)]*\))?\s*:/;

function parsePython(lines: string[]): ASTNode[] {
  const nodes: ASTNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Class
    const classMatch = line.match(PY_CLASS_RE);
    if (classMatch && classMatch[1].length === 0) {
      const startLine = i + 1;
      const docstring = extractPythonDocstring(lines, i + 1);
      const endLine = findPythonBlockEnd(lines, i, 0);
      const methods = extractPythonMethods(lines, i + 1, endLine);
      nodes.push({
        name: classMatch[2],
        kind: "class",
        startLine,
        endLine: endLine + 1,
        source: lines.slice(i, endLine + 1).join("\n"),
        signature: `class ${classMatch[2]}`,
        docstring,
        children: methods,
      });
      i = endLine + 1;
      continue;
    }

    // Top-level function
    const funcMatch = line.match(PY_FUNCTION_RE);
    if (funcMatch && funcMatch[1].length === 0) {
      const startLine = i + 1;
      const docstring = extractPythonDocstring(lines, i + 1);
      const endLine = findPythonBlockEnd(lines, i, 0);
      nodes.push({
        name: funcMatch[2],
        kind: "function",
        startLine,
        endLine: endLine + 1,
        source: lines.slice(i, endLine + 1).join("\n"),
        signature: `def ${funcMatch[2]}(${funcMatch[3]})${funcMatch[4] ? ` -> ${funcMatch[4]}` : ""}`,
        docstring,
        children: [],
      });
      i = endLine + 1;
      continue;
    }

    i++;
  }

  return nodes;
}

function extractPythonMethods(lines: string[], start: number, end: number): ASTNode[] {
  const methods: ASTNode[] = [];
  for (let i = start; i <= end; i++) {
    const match = lines[i]?.match(PY_FUNCTION_RE);
    if (match && match[1].length > 0 && match[2] !== "__init__") {
      const methodEnd = findPythonBlockEnd(lines, i, match[1].length);
      const docstring = extractPythonDocstring(lines, i + 1);
      methods.push({
        name: match[2],
        kind: "method",
        startLine: i + 1,
        endLine: methodEnd + 1,
        source: lines.slice(i, methodEnd + 1).join("\n"),
        signature: `def ${match[2]}(${match[3]})${match[4] ? ` -> ${match[4]}` : ""}`,
        docstring,
        children: [],
      });
      i = methodEnd;
    }
  }
  return methods;
}

function extractPythonDocstring(lines: string[], afterDef: number): string | null {
  const next = lines[afterDef]?.trim();
  if (!next) return null;
  if (next.startsWith('"""') || next.startsWith("'''")) {
    const quote = next.slice(0, 3);
    if (next.endsWith(quote) && next.length > 6) return next.slice(3, -3);
    const docLines = [next.slice(3)];
    for (let j = afterDef + 1; j < lines.length; j++) {
      if (lines[j].trim().endsWith(quote)) {
        docLines.push(lines[j].trim().slice(0, -3));
        return docLines.join("\n").trim();
      }
      docLines.push(lines[j].trim());
    }
  }
  return null;
}

function findPythonBlockEnd(lines: string[], start: number, baseIndent: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent && line.trim() !== "") {
      return i - 1;
    }
  }
  return lines.length - 1;
}

/**
 * Generate a concise textual summary of an AST node suitable for embedding.
 */
export function summarizeNode(node: ASTNode): string {
  const parts: string[] = [];
  parts.push(`${node.kind} ${node.name}: ${node.signature}`);
  if (node.docstring) {
    parts.push(node.docstring.slice(0, 200));
  }
  if (node.children.length > 0) {
    parts.push(`Methods: ${node.children.map((c) => c.name).join(", ")}`);
  }
  return parts.join(" | ");
}
