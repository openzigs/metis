/**
 * Epic #298 / Issue #308 — language parser interface + parser implementations
 * for TypeScript, JavaScript, Python, Go, Java.
 *
 * Issue #322 — primary path is now `web-tree-sitter` with bundled WASM
 * grammars, which resolves all the v1-regex limitations (nested classes,
 * computed property names, methods inside classes, dynamic imports,
 * generic arrow functions, multi-token Java return types). The original
 * regex parsers below are retained as a deterministic fallback for unit
 * tests that import `parseSource` without booting `initCodeGraphParsers()`.
 *
 * Each parser returns the SAME ParsedFile shape so the ingest orchestrator
 * does not need to know which language (or which backend) it parsed.
 */
import { createHash } from "node:crypto";
import { buildCodeQualifiedName, moduleQualifiedName } from "./qualified-name.js";
import { isTreeSitterReady, parseWithTreeSitter } from "./parsers-tree-sitter.js";

export {
  initCodeGraphParsers,
  findStringLiterals,
  findJavaConcatSqlCandidates,
} from "./parsers-tree-sitter.js";
export type { StringLiteral } from "./parsers-tree-sitter.js";

export type SymbolKind = "function" | "class" | "interface" | "type" | "module" | "method";
export type EdgeKind = "calls" | "imports" | "defines" | "references";
export type Language = "ts" | "js" | "py" | "go" | "java" | "sas" | "cs";

export interface ParsedSymbol {
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  /** SHA256 of the symbol body — used for incremental "did this symbol change?" checks. */
  contentHash: string;
}

export interface ParsedEdge {
  kind: EdgeKind;
  /**
   * The qualified name of the source symbol. The orchestrator resolves this
   * to a `fromSymbolId` after persisting symbols.
   */
  fromQualifiedName: string;
  /**
   * The qualified name of the target. The orchestrator resolves to a
   * `toSymbolId` when possible, otherwise stores the textual name.
   */
  toQualifiedName: string;
  line: number;
  metadata?: Record<string, unknown>;
}

export interface ParsedFile {
  filePath: string;
  language: Language;
  symbols: ParsedSymbol[];
  edges: ParsedEdge[];
  /** SHA256 of the entire file content — used for skip-on-no-change. */
  fileHash: string;
  /**
   * Lines that look like rationale comments (`// WHY:`, `# NOTE:`, JSDoc
   * blocks, Python docstrings). The rationale extractor consumes these.
   */
  rationaleHints: RationaleHint[];
  /** True when the parser hit a syntax error and gave up partway. */
  unparseable?: boolean;
}

export interface RationaleHint {
  /** Line of the FIRST line of the comment block. */
  startLine: number;
  /** Line of the LAST line of the comment block. */
  endLine: number;
  /** Tag classification: `WHY` | `NOTE` | `HACK` | `TODO` | `JSDOC` | `DOCSTRING`. */
  tag: "WHY" | "NOTE" | "HACK" | "TODO" | "JSDOC" | "DOCSTRING";
  /** Cleaned comment text (markers stripped). */
  text: string;
}

export const LANGUAGE_BY_EXT: Record<string, Language> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  go: "go",
  java: "java",
  sas: "sas",
  // Issue #900 — C#/.NET (ADO.NET / Dapper / EF Core lineage). `.csx` C# script
  // files share the same grammar.
  cs: "cs",
  csx: "cs",
};

export function detectLanguage(filePath: string): Language | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? null;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// TypeScript / JavaScript shared parser.
//
// Recognises:
//   - `function foo(...)` / `async function foo(...)`
//   - `export function foo(...)`, `export default function foo(...)`
//   - `class Foo`, `export class Foo`, `interface Foo`, `type Foo`
//   - `const foo = (...) => ...` arrow-function assignments at module scope
//   - JSDoc blocks `/** ... */`
//   - `// WHY:` / `// NOTE:` / `// HACK:` / `// TODO:` adjacent to a symbol
//   - `import ... from '...'` (incl. `import type`)
//   - `(qualifiedName)(...)` direct calls (best-effort — ambiguous calls are
//     dropped rather than guessed)
//
// Limitations: nested classes, computed property names, namespace merging,
// re-exports, and dynamic `import()` are NOT resolved. (V1.)
// ---------------------------------------------------------------------------
function parseTsJs(filePath: string, source: string, language: "ts" | "js"): ParsedFile {
  const lines = source.split(/\r?\n/);
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const rationaleHints: RationaleHint[] = [];

  // Module symbol — every file gets one so that file-level imports have a from.
  const moduleQname = moduleQualifiedName(filePath);
  symbols.push({
    kind: "module",
    name: filePath.split("/").pop() ?? filePath,
    qualifiedName: moduleQname,
    startLine: 1,
    endLine: lines.length,
    contentHash: sha256(source),
  });

  // Definition regexes. The matchers run line-by-line so we can capture
  // accurate line numbers and so single-line declarations work.
  const defRegexes: Array<{ re: RegExp; kind: SymbolKind }> = [
    {
      re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/,
      kind: "function",
    },
    {
      re: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      kind: "class",
    },
    { re: /^\s*(?:export\s+(?:default\s+)?)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { re: /^\s*(?:export\s+(?:default\s+)?)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type" },
    {
      re: /^\s*(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
      kind: "function",
    },
  ];

  // Track per-symbol body bounds so calls can be attributed correctly.
  interface DefRecord {
    name: string;
    kind: SymbolKind;
    start: number;
    end: number;
  }
  const defs: DefRecord[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const { re, kind } of defRegexes) {
      const m = re.exec(line);
      if (m) {
        const name = m[1];
        // Find body end by brace counting starting at this line. For
        // arrow-function assignments without braces this falls back to the
        // same line.
        const end = findBlockEnd(lines, i);
        const qname = buildCodeQualifiedName(moduleQname, name);
        const body = lines.slice(i, end + 1).join("\n");
        symbols.push({
          kind,
          name,
          qualifiedName: qname,
          startLine: i + 1,
          endLine: end + 1,
          contentHash: sha256(body),
        });
        defs.push({ name, kind, start: i, end });
        edges.push({
          kind: "defines",
          fromQualifiedName: moduleQname,
          toQualifiedName: qname,
          line: i + 1,
        });
        break;
      }
    }

    // Imports: `import X from 'mod'` / `import { X } from 'mod'` /
    // `import type { X } from 'mod'`.
    const importMatch = /^\s*import(\s+type)?\s+[^'"]*from\s+['"]([^'"]+)['"]/.exec(line);
    if (importMatch) {
      edges.push({
        kind: "imports",
        fromQualifiedName: moduleQname,
        toQualifiedName: importMatch[2],
        line: i + 1,
        metadata: importMatch[1] ? { typeOnly: true } : undefined,
      });
    }
    const sideEffectImport = /^\s*import\s+['"]([^'"]+)['"]/.exec(line);
    if (sideEffectImport && !importMatch) {
      edges.push({
        kind: "imports",
        fromQualifiedName: moduleQname,
        toQualifiedName: sideEffectImport[1],
        line: i + 1,
      });
    }
  }

  // Pass 2: attribute calls to the enclosing definition.
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  // Reserved/built-in names that produce noise if treated as calls.
  const callBlocklist = new Set([
    "if",
    "for",
    "while",
    "switch",
    "return",
    "function",
    "catch",
    "typeof",
    "new",
    "throw",
    "await",
    "yield",
    "void",
    "in",
    "of",
    "as",
    "is",
    "Array",
    "Object",
    "Promise",
    "String",
    "Number",
    "Boolean",
    "JSON",
    "console",
    "Math",
  ]);
  for (let i = 0; i < lines.length; i += 1) {
    const enclosing = defs.find(
      (d) => i >= d.start && i <= d.end && d.kind !== "interface" && d.kind !== "type",
    );
    const fromQname = enclosing ? buildCodeQualifiedName(moduleQname, enclosing.name) : moduleQname;
    const line = lines[i];
    let cm: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((cm = callRe.exec(line)) !== null) {
      const name = cm[1];
      if (callBlocklist.has(name)) continue;
      // Skip if the match is itself the definition site (e.g. "function foo(").
      if (/(function|class|interface|type)\s+$/.test(line.slice(0, cm.index))) continue;
      edges.push({
        kind: "calls",
        fromQualifiedName: fromQname,
        toQualifiedName: name,
        line: i + 1,
      });
    }
  }

  collectRationaleHintsTsJs(lines, rationaleHints);

  return {
    filePath,
    language,
    symbols,
    edges,
    fileHash: sha256(source),
    rationaleHints,
  };
}

function findBlockEnd(lines: string[], startIdx: number): number {
  const startLine = lines[startIdx];
  // Arrow function without an explicit body block ends on the same line.
  if (startLine.includes("=>") && !/=>\s*\{/.test(startLine)) {
    return startIdx;
  }
  // Find the opening brace on this line or the immediately following line
  // (Egyptian vs Allman style). Looking further than one line risks crossing
  // into a sibling declaration's body.
  let openIdx = -1;
  if (startLine.includes("{")) openIdx = startIdx;
  else if (startIdx + 1 < lines.length && lines[startIdx + 1].includes("{")) {
    openIdx = startIdx + 1;
  }
  if (openIdx === -1) {
    // No block — single-line declaration.
    return startIdx;
  }
  let depth = 0;
  for (let j = openIdx; j < lines.length; j += 1) {
    const line = lines[j];
    for (const c of line) {
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) return j;
      }
    }
  }
  return lines.length - 1;
}

function collectRationaleHintsTsJs(lines: string[], out: RationaleHint[]): void {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // JSDoc block.
    const jsdocStart = /^\s*\/\*\*\s*$/.exec(line);
    if (jsdocStart) {
      let j = i + 1;
      const buf: string[] = [];
      while (j < lines.length && !/^\s*\*\//.test(lines[j])) {
        buf.push(lines[j].replace(/^\s*\*\s?/, ""));
        j += 1;
      }
      out.push({
        startLine: i + 1,
        endLine: j + 1,
        tag: "JSDOC",
        text: buf.join("\n").trim(),
      });
      i = j + 1;
      continue;
    }

    // Single-line marker comment.
    const m = /^\s*\/\/\s*(WHY|NOTE|HACK|TODO):\s*(.*)$/.exec(line);
    if (m) {
      out.push({
        startLine: i + 1,
        endLine: i + 1,
        tag: m[1] as RationaleHint["tag"],
        text: m[2].trim(),
      });
    }
    i += 1;
  }
}

// ---------------------------------------------------------------------------
// Python parser.
//
// Recognises:
//   - `def foo(...)` / `async def foo(...)`
//   - `class Foo`
//   - `import x` / `from x import y`
//   - First string-literal in a function/class body → docstring rationale
//   - `# WHY:` / `# NOTE:` / `# HACK:` / `# TODO:` adjacent to a definition
//
// Limitations: decorator-introduced symbols (e.g. dataclass-as-class) are
// captured at definition time only — no decorator metadata expansion.
// ---------------------------------------------------------------------------
function parsePython(filePath: string, source: string): ParsedFile {
  const lines = source.split(/\r?\n/);
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const rationaleHints: RationaleHint[] = [];
  const moduleQname = moduleQualifiedName(filePath);
  symbols.push({
    kind: "module",
    name: filePath.split("/").pop() ?? filePath,
    qualifiedName: moduleQname,
    startLine: 1,
    endLine: lines.length,
    contentHash: sha256(source),
  });

  const defRe = /^(\s*)(async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/;
  const classRe = /^(\s*)class\s+([A-Za-z_][\w]*)/;
  interface PyDef {
    name: string;
    kind: SymbolKind;
    indent: number;
    start: number;
    end: number;
  }
  const defs: PyDef[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let match: { name: string; kind: SymbolKind; indent: number } | null = null;
    const dm = defRe.exec(line);
    const cm = classRe.exec(line);
    if (dm) match = { name: dm[3], kind: "function", indent: dm[1].length };
    else if (cm) match = { name: cm[2], kind: "class", indent: cm[1].length };

    if (match) {
      const end = findPythonBlockEnd(lines, i, match.indent);
      const qname = buildCodeQualifiedName(moduleQname, match.name);
      const body = lines.slice(i, end + 1).join("\n");
      symbols.push({
        kind: match.kind,
        name: match.name,
        qualifiedName: qname,
        startLine: i + 1,
        endLine: end + 1,
        contentHash: sha256(body),
      });
      defs.push({ name: match.name, kind: match.kind, indent: match.indent, start: i, end });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: i + 1,
      });
      // Detect docstring on the next non-blank line at deeper indent.
      for (let j = i + 1; j <= end && j < lines.length; j += 1) {
        if (lines[j].trim().length === 0) continue;
        const ds = /^\s*("""|''')([\s\S]*?)\1/.exec(lines[j]);
        if (ds) {
          rationaleHints.push({
            startLine: j + 1,
            endLine: j + 1,
            tag: "DOCSTRING",
            text: ds[2].trim(),
          });
        }
        break;
      }
    }

    // Imports.
    const importStmt = /^\s*import\s+([\w.]+)/.exec(line);
    const fromImport = /^\s*from\s+([\w.]+)\s+import\s+/.exec(line);
    if (importStmt) {
      edges.push({
        kind: "imports",
        fromQualifiedName: moduleQname,
        toQualifiedName: importStmt[1],
        line: i + 1,
      });
    }
    if (fromImport) {
      edges.push({
        kind: "imports",
        fromQualifiedName: moduleQname,
        toQualifiedName: fromImport[1],
        line: i + 1,
      });
    }

    // # WHY: etc.
    const marker = /^\s*#\s*(WHY|NOTE|HACK|TODO):\s*(.*)$/.exec(line);
    if (marker) {
      rationaleHints.push({
        startLine: i + 1,
        endLine: i + 1,
        tag: marker[1] as RationaleHint["tag"],
        text: marker[2].trim(),
      });
    }
  }

  // Calls (best-effort).
  const callRe = /\b([A-Za-z_][\w]*)\s*\(/g;
  const callBlocklist = new Set([
    "if",
    "for",
    "while",
    "return",
    "def",
    "class",
    "print",
    "len",
    "range",
    "isinstance",
    "type",
    "str",
    "int",
    "float",
    "list",
    "dict",
    "tuple",
    "set",
    "open",
    "format",
  ]);
  for (let i = 0; i < lines.length; i += 1) {
    const enclosing = [...defs]
      .reverse()
      .find((d) => i > d.start && i <= d.end && d.kind === "function");
    const fromQname = enclosing ? buildCodeQualifiedName(moduleQname, enclosing.name) : moduleQname;
    const line = lines[i];
    let m: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(line)) !== null) {
      if (callBlocklist.has(m[1])) continue;
      if (/(def|class)\s+$/.test(line.slice(0, m.index))) continue;
      edges.push({
        kind: "calls",
        fromQualifiedName: fromQname,
        toQualifiedName: m[1],
        line: i + 1,
      });
    }
  }

  return { filePath, language: "py", symbols, edges, fileHash: sha256(source), rationaleHints };
}

function findPythonBlockEnd(lines: string[], startIdx: number, headerIndent: number): number {
  // Block continues until a non-empty line returns to ≤ headerIndent.
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= headerIndent) return i - 1;
  }
  return lines.length - 1;
}

// ---------------------------------------------------------------------------
// Go parser.
// Recognises: `func Name(...)` / `func (r *T) Name(...)`, `type X struct`,
// `type X interface`, `import "x"`, `// WHY:` / `// NOTE:` markers.
// ---------------------------------------------------------------------------
function parseGo(filePath: string, source: string): ParsedFile {
  const lines = source.split(/\r?\n/);
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const rationaleHints: RationaleHint[] = [];
  const moduleQname = moduleQualifiedName(filePath);
  symbols.push({
    kind: "module",
    name: filePath.split("/").pop() ?? filePath,
    qualifiedName: moduleQname,
    startLine: 1,
    endLine: lines.length,
    contentHash: sha256(source),
  });

  let inImportBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^\s*import\s+\(/.test(line)) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock) {
      if (/^\s*\)/.test(line)) {
        inImportBlock = false;
        continue;
      }
      const im = /"([^"]+)"/.exec(line);
      if (im) {
        edges.push({
          kind: "imports",
          fromQualifiedName: moduleQname,
          toQualifiedName: im[1],
          line: i + 1,
        });
      }
      continue;
    }
    const singleImport = /^\s*import\s+"([^"]+)"/.exec(line);
    if (singleImport) {
      edges.push({
        kind: "imports",
        fromQualifiedName: moduleQname,
        toQualifiedName: singleImport[1],
        line: i + 1,
      });
    }

    const fn = /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/.exec(line);
    if (fn) {
      const end = findBlockEnd(lines, i);
      const qname = buildCodeQualifiedName(moduleQname, fn[1]);
      const body = lines.slice(i, end + 1).join("\n");
      symbols.push({
        kind: "function",
        name: fn[1],
        qualifiedName: qname,
        startLine: i + 1,
        endLine: end + 1,
        contentHash: sha256(body),
      });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: i + 1,
      });
    }

    const typeDecl = /^\s*type\s+([A-Za-z_][\w]*)\s+(struct|interface)/.exec(line);
    if (typeDecl) {
      const kind: SymbolKind = typeDecl[2] === "interface" ? "interface" : "class";
      const end = findBlockEnd(lines, i);
      const qname = buildCodeQualifiedName(moduleQname, typeDecl[1]);
      const body = lines.slice(i, end + 1).join("\n");
      symbols.push({
        kind,
        name: typeDecl[1],
        qualifiedName: qname,
        startLine: i + 1,
        endLine: end + 1,
        contentHash: sha256(body),
      });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: i + 1,
      });
    }

    const marker = /^\s*\/\/\s*(WHY|NOTE|HACK|TODO):\s*(.*)$/.exec(line);
    if (marker) {
      rationaleHints.push({
        startLine: i + 1,
        endLine: i + 1,
        tag: marker[1] as RationaleHint["tag"],
        text: marker[2].trim(),
      });
    }
  }

  return { filePath, language: "go", symbols, edges, fileHash: sha256(source), rationaleHints };
}

// ---------------------------------------------------------------------------
// Java parser.
// Recognises: `class Foo`, `interface Foo`, public/private method decls,
// `import x.y.Z;`, `// WHY:` markers.
// ---------------------------------------------------------------------------
function parseJava(filePath: string, source: string): ParsedFile {
  const lines = source.split(/\r?\n/);
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const rationaleHints: RationaleHint[] = [];
  const moduleQname = moduleQualifiedName(filePath);
  symbols.push({
    kind: "module",
    name: filePath.split("/").pop() ?? filePath,
    qualifiedName: moduleQname,
    startLine: 1,
    endLine: lines.length,
    contentHash: sha256(source),
  });

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const importStmt = /^\s*import\s+([\w.]+(?:\.\*)?)\s*;/.exec(line);
    if (importStmt) {
      edges.push({
        kind: "imports",
        fromQualifiedName: moduleQname,
        toQualifiedName: importStmt[1],
        line: i + 1,
      });
    }

    const classDecl =
      /^\s*(?:public|private|protected|abstract|final|static|\s)*\s*class\s+([A-Z][\w]*)/.exec(
        line,
      );
    if (classDecl) {
      const end = findBlockEnd(lines, i);
      const qname = buildCodeQualifiedName(moduleQname, classDecl[1]);
      symbols.push({
        kind: "class",
        name: classDecl[1],
        qualifiedName: qname,
        startLine: i + 1,
        endLine: end + 1,
        contentHash: sha256(lines.slice(i, end + 1).join("\n")),
      });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: i + 1,
      });
    }

    const interfaceDecl = /^\s*(?:public|private|protected|\s)*\s*interface\s+([A-Z][\w]*)/.exec(
      line,
    );
    if (interfaceDecl) {
      const end = findBlockEnd(lines, i);
      const qname = buildCodeQualifiedName(moduleQname, interfaceDecl[1]);
      symbols.push({
        kind: "interface",
        name: interfaceDecl[1],
        qualifiedName: qname,
        startLine: i + 1,
        endLine: end + 1,
        contentHash: sha256(lines.slice(i, end + 1).join("\n")),
      });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: i + 1,
      });
    }

    // Method decl heuristic: visibility + return type + name + paren.
    const methodDecl =
      /^\s*(?:public|private|protected|static|final|abstract|synchronized|\s)+\s+[\w<>\[\],?\s]+\s+([a-z][\w]*)\s*\(/.exec(
        line,
      );
    if (methodDecl && !classDecl && !interfaceDecl) {
      const qname = buildCodeQualifiedName(moduleQname, methodDecl[1]);
      symbols.push({
        kind: "method",
        name: methodDecl[1],
        qualifiedName: qname,
        startLine: i + 1,
        endLine: findBlockEnd(lines, i) + 1,
        contentHash: sha256(line),
      });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: i + 1,
      });
    }

    const marker = /^\s*\/\/\s*(WHY|NOTE|HACK|TODO):\s*(.*)$/.exec(line);
    if (marker) {
      rationaleHints.push({
        startLine: i + 1,
        endLine: i + 1,
        tag: marker[1] as RationaleHint["tag"],
        text: marker[2].trim(),
      });
    }
  }

  return { filePath, language: "java", symbols, edges, fileHash: sha256(source), rationaleHints };
}

// ---------------------------------------------------------------------------
// SAS parser (Issue #199).
//
// SAS has no mature web-tree-sitter grammar, so this is a regex/scanner-based
// parser returning the standard `ParsedFile` shape. SAS constructs map onto
// the closed `SymbolKind`/`EdgeKind` unions:
//
//   - `%macro foo; ... %mend;`        -> function symbol `foo`
//   - DATA step `data a b; ... run;`   -> function symbol (first output dataset)
//   - PROC step `proc means ...; run;` -> function symbol `proc means`
//   - PROC SQL  `proc sql; ... quit;`  -> function symbol `proc sql`
//   - `libname lib "..."` / `filename` -> type symbol `lib`/`fref`
//   - the program file itself           -> one module symbol (qname = filePath)
//
//   - `%include "other.sas";`           -> imports edge
//   - macro call `%foo(...)` / `%foo;`  -> calls edge to `foo`
//   - dataset lineage per step          -> references edge with
//       `metadata: { lineage: "input" | "output", dataset: "<name>" }`
//
//   - `* stmt comment ;` / `/* block */`-> RationaleHint (NOTE, or WHY/TODO/HACK)
//
// All regexes use bounded quantifiers and negated character classes (no
// catastrophic backtracking). Comment/string masking is a single linear
// character scan — there is no regex applied to untrusted whole-file input
// that can backtrack. OWASP ReDoS review: safe.
// ---------------------------------------------------------------------------

interface SasStatement {
  text: string;
  startLine: number;
  endLine: number;
}

/** Reserved SAS macro statement keywords that are NOT user macro invocations. */
const SAS_MACRO_KEYWORDS = new Set([
  "macro",
  "mend",
  "include",
  "if",
  "then",
  "else",
  "do",
  "end",
  "let",
  "global",
  "local",
  "put",
  "return",
  "abort",
  "goto",
  "sysfunc",
  "sysevalf",
  "sysget",
  "syscall",
  "eval",
  "str",
  "nrstr",
  "upcase",
  "lowcase",
  "scan",
  "substr",
  "index",
  "length",
  "symexist",
  "symdel",
  "symput",
  "symget",
  "window",
  "display",
  "list",
  "to",
  "by",
  "while",
  "until",
]);

/** Classify and store a SAS comment as a rationale hint (markers stripped). */
function addSasRationaleHint(
  raw: string,
  startLine: number,
  endLine: number,
  out: RationaleHint[],
): void {
  let text = raw.trim();
  if (text.length === 0) return;
  let tag: RationaleHint["tag"] = "NOTE";
  // Bounded: a single anchored alternation over a fixed keyword set.
  const marker = /^(WHY|NOTE|HACK|TODO)\b[:\-\s]{0,3}/i.exec(text);
  if (marker) {
    tag = marker[1].toUpperCase() as RationaleHint["tag"];
    text = text.slice(marker[0].length).trim();
  }
  out.push({ startLine, endLine, tag, text });
}

/**
 * Linear single-pass scanner that blanks out SAS comments and string literals
 * (replacing their interior with spaces, preserving newlines and offsets) and
 * collects rationale hints from the comments. Returns the masked source so the
 * symbol/edge regexes never match keywords that live inside comments/strings.
 *
 * Throws on an unterminated block comment — a genuinely malformed file that
 * `parseSas` reports as `unparseable`.
 */
function maskSasComments(source: string, out: RationaleHint[]): string {
  let masked = "";
  let line = 1;
  let i = 0;
  const n = source.length;

  /** True when the masked output so far ends a statement (last non-ws is `;`). */
  const atStatementStart = (): boolean => {
    for (let k = masked.length - 1; k >= 0; k -= 1) {
      const ch = masked[k];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;
      return ch === ";";
    }
    return true; // start of file
  };

  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : "";

    // Block comment: /* ... */
    if (c === "/" && next === "*") {
      const startLine = line;
      let buf = "";
      masked += "  ";
      i += 2;
      let closed = false;
      while (i < n) {
        if (source[i] === "*" && source[i + 1] === "/") {
          masked += "  ";
          i += 2;
          closed = true;
          break;
        }
        if (source[i] === "\n") {
          masked += "\n";
          line += 1;
        } else {
          masked += " ";
        }
        buf += source[i];
        i += 1;
      }
      if (!closed) throw new Error("unterminated SAS block comment");
      addSasRationaleHint(buf, startLine, line, out);
      continue;
    }

    // String literal: '...' or "..." — mask so a `*` inside cannot start a
    // statement comment and keywords inside strings are ignored.
    if (c === "'" || c === '"') {
      const quote = c;
      masked += c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\n") {
          masked += "\n";
          line += 1;
        } else {
          masked += " ";
        }
        i += 1;
      }
      if (i < n) {
        masked += quote;
        i += 1;
      }
      continue;
    }

    // Statement-style comment: `* ... ;` where `*` is the first token of a
    // statement (the previous statement ended with `;` or we're at file start).
    if (c === "*" && atStatementStart()) {
      const startLine = line;
      let buf = "";
      masked += " ";
      i += 1;
      while (i < n && source[i] !== ";") {
        if (source[i] === "\n") {
          masked += "\n";
          line += 1;
        } else {
          masked += " ";
        }
        buf += source[i];
        i += 1;
      }
      if (i < n) {
        masked += " "; // consume the terminating `;`
        i += 1;
      }
      addSasRationaleHint(buf, startLine, line, out);
      continue;
    }

    if (c === "\n") line += 1;
    masked += c;
    i += 1;
  }

  return masked;
}

/** Split masked SAS source into `;`-terminated statements with line numbers. */
function splitSasStatements(masked: string): SasStatement[] {
  const stmts: SasStatement[] = [];
  let line = 1;
  let startLine = 1;
  let buf = "";
  let started = false;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (!started && ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
      started = true;
      startLine = line;
    }
    if (ch === ";") {
      const text = buf.trim();
      if (text.length > 0) stmts.push({ text, startLine, endLine: line });
      buf = "";
      started = false;
    } else {
      buf += ch;
    }
    if (ch === "\n") line += 1;
  }
  const tail = buf.trim();
  if (tail.length > 0) stmts.push({ text: tail, startLine, endLine: line });
  return stmts;
}

/**
 * Extract bare dataset names from a fragment (e.g. `work.out (keep=x) out2`).
 * Strips parenthesised dataset options and `key=value` tokens.
 */
function sasDatasetNames(fragment: string): string[] {
  // Bounded negated-class group removal — no backtracking.
  const cleaned = fragment.replace(/\([^()]{0,500}\)/g, " ");
  const out: string[] = [];
  for (const tok of cleaned.split(/[\s,]+/)) {
    const t = tok.trim();
    if (t.length === 0 || t.includes("=")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(t)) out.push(t);
  }
  return out;
}

/** Emit macro-invocation `calls` edges found in a statement's text. */
function collectSasMacroCalls(st: SasStatement, fromQname: string, edges: ParsedEdge[]): void {
  const re = /%([A-Za-z_][A-Za-z0-9_]{0,63})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(st.text)) !== null) {
    const name = m[1];
    if (SAS_MACRO_KEYWORDS.has(name.toLowerCase())) continue;
    edges.push({
      kind: "calls",
      fromQualifiedName: fromQname,
      toQualifiedName: name,
      line: st.startLine,
    });
  }
}

function parseSasInner(filePath: string, source: string): ParsedFile {
  const lines = source.split(/\r?\n/);
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const rationaleHints: RationaleHint[] = [];
  const moduleQname = moduleQualifiedName(filePath);

  // Every file gets exactly one module symbol.
  symbols.push({
    kind: "module",
    name: filePath.split("/").pop() ?? filePath,
    qualifiedName: moduleQname,
    startLine: 1,
    endLine: lines.length,
    contentHash: sha256(source),
  });

  const masked = maskSasComments(source, rationaleHints);
  const stmts = splitSasStatements(masked);

  const bodyHash = (startLine: number, endLine: number): string =>
    sha256(lines.slice(startLine - 1, endLine).join("\n"));

  let currentMacro: { name: string; qname: string; startLine: number } | null = null;

  const isStepTerminator = (lower: string): boolean =>
    lower === "run" || lower === "quit" || lower.startsWith("run ") || lower.startsWith("quit ");

  let idx = 0;
  while (idx < stmts.length) {
    const st = stmts[idx];
    const text = st.text;
    const lower = text.toLowerCase();

    // %include "path";  -> imports edge. The path lives inside a string
    // literal which `maskSasComments` blanks, so read it from the original
    // source slice for this statement.
    if (/^%include\b/i.test(text)) {
      const raw = lines.slice(st.startLine - 1, st.endLine).join("\n");
      const inc = /%include\s+(['"]?)([^'";\s]{1,512})\1/i.exec(raw);
      if (inc) {
        edges.push({
          kind: "imports",
          fromQualifiedName: currentMacro?.qname ?? moduleQname,
          toQualifiedName: inc[2],
          line: st.startLine,
        });
      }
      idx += 1;
      continue;
    }

    // %macro foo(...)  -> open a macro block
    const macro = /^%macro\s+([A-Za-z_][A-Za-z0-9_]{0,63})/i.exec(text);
    if (macro) {
      currentMacro = {
        name: macro[1],
        qname: buildCodeQualifiedName(moduleQname, macro[1]),
        startLine: st.startLine,
      };
      idx += 1;
      continue;
    }

    // %mend  -> close the macro block and emit its function symbol
    if (/^%mend\b/i.test(text)) {
      if (currentMacro) {
        symbols.push({
          kind: "function",
          name: currentMacro.name,
          qualifiedName: currentMacro.qname,
          startLine: currentMacro.startLine,
          endLine: st.endLine,
          contentHash: bodyHash(currentMacro.startLine, st.endLine),
        });
        edges.push({
          kind: "defines",
          fromQualifiedName: moduleQname,
          toQualifiedName: currentMacro.qname,
          line: currentMacro.startLine,
        });
        currentMacro = null;
      }
      idx += 1;
      continue;
    }

    // DATA step: `data out1 out2; ... run;`
    if (lower === "data" || lower.startsWith("data ")) {
      // Find the step block end. A step ends at its own `run;`/`quit;` (the
      // terminator is part of the step), OR — when it has no explicit
      // terminator — at the LAST statement before the next step opener
      // (`data`/`proc`/`%mend`), i.e. `stmts[j-1]`. Without this `j-1`, a
      // multi-statement step that runs straight into the next step would
      // collapse its body to the opener line and lose its body slice.
      // `Math.max(idx, …)` guards the degenerate case where the next opener is
      // the very next statement (no body): the step then legitimately spans
      // only its own opener statement.
      let end = idx;
      for (let j = idx + 1; j < stmts.length; j += 1) {
        const l = stmts[j].text.toLowerCase();
        if (isStepTerminator(l)) {
          end = j;
          break;
        }
        if (/^(data|proc)\b/.test(l) || /^%mend\b/i.test(stmts[j].text)) {
          end = Math.max(idx, j - 1);
          break;
        }
        end = j;
      }

      const outputs = sasDatasetNames(text.replace(/^data\b/i, ""));
      const name = outputs[0] ?? "data";
      const qname = buildCodeQualifiedName(moduleQname, name);
      symbols.push({
        kind: "function",
        name,
        qualifiedName: qname,
        startLine: st.startLine,
        endLine: stmts[end].endLine,
        contentHash: bodyHash(st.startLine, stmts[end].endLine),
      });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: st.startLine,
      });
      for (const ds of outputs) {
        edges.push({
          kind: "references",
          fromQualifiedName: qname,
          toQualifiedName: ds,
          line: st.startLine,
          metadata: { lineage: "output", dataset: ds },
        });
      }
      // Inputs from set/merge/update/modify statements within the block.
      for (let j = idx; j <= end; j += 1) {
        const sj = stmts[j];
        const inputMatch = /^(set|merge|update|modify)\b([\s\S]{0,2000})$/i.exec(sj.text);
        if (inputMatch) {
          for (const ds of sasDatasetNames(inputMatch[2])) {
            edges.push({
              kind: "references",
              fromQualifiedName: qname,
              toQualifiedName: ds,
              line: sj.startLine,
              metadata: { lineage: "input", dataset: ds },
            });
          }
        }
        collectSasMacroCalls(sj, currentMacro?.qname ?? qname, edges);
      }
      idx = end + 1;
      continue;
    }

    // PROC step: `proc <name> ...; ... run;/quit;`
    const proc = /^proc\s+([A-Za-z_][A-Za-z0-9_]{0,63})/i.exec(text);
    if (proc) {
      // Same body-end rule as the DATA step above: end at this step's own
      // `run;`/`quit;`, else at the last statement before the next step opener
      // (`stmts[j-1]`), clamped to `>= idx`. The `j-1` is what stops a
      // multi-statement PROC (e.g. `proc sql; create table … as select …;`)
      // that is immediately followed by the next step from collapsing to its
      // opener line and reporting an empty body.
      let end = idx;
      for (let j = idx + 1; j < stmts.length; j += 1) {
        const l = stmts[j].text.toLowerCase();
        if (isStepTerminator(l)) {
          end = j;
          break;
        }
        if (/^(data|proc)\b/.test(l) || /^%mend\b/i.test(stmts[j].text)) {
          end = Math.max(idx, j - 1);
          break;
        }
        end = j;
      }

      const procName = `proc ${proc[1].toLowerCase()}`;
      const qname = buildCodeQualifiedName(moduleQname, procName);
      symbols.push({
        kind: "function",
        name: procName,
        qualifiedName: qname,
        startLine: st.startLine,
        endLine: stmts[end].endLine,
        contentHash: bodyHash(st.startLine, stmts[end].endLine),
      });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: st.startLine,
      });

      const seen = new Set<string>();
      const addLineage = (ds: string, lineage: "input" | "output", line: number): void => {
        const key = `${lineage}:${ds}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({
          kind: "references",
          fromQualifiedName: qname,
          toQualifiedName: ds,
          line,
          metadata: { lineage, dataset: ds },
        });
      };

      for (let j = idx; j <= end; j += 1) {
        const sj = stmts[j];
        // `data=NAME` is an INPUT to a PROC; `out=NAME` is an OUTPUT.
        let m: RegExpExecArray | null;
        const dataOpt = /\bdata\s*=\s*([A-Za-z_][A-Za-z0-9_.]{0,127})/gi;
        while ((m = dataOpt.exec(sj.text)) !== null) addLineage(m[1], "input", sj.startLine);
        const outOpt = /\bout\s*=\s*([A-Za-z_][A-Za-z0-9_.]{0,127})/gi;
        while ((m = outOpt.exec(sj.text)) !== null) addLineage(m[1], "output", sj.startLine);
        // PROC SQL lineage.
        const createTable = /\bcreate\s+(?:table|view)\s+([A-Za-z_][A-Za-z0-9_.]{0,127})/gi;
        while ((m = createTable.exec(sj.text)) !== null) addLineage(m[1], "output", sj.startLine);
        const fromClause = /\bfrom\s+([A-Za-z_][A-Za-z0-9_.]{0,127})/gi;
        while ((m = fromClause.exec(sj.text)) !== null) addLineage(m[1], "input", sj.startLine);
        collectSasMacroCalls(sj, currentMacro?.qname ?? qname, edges);
      }
      idx = end + 1;
      continue;
    }

    // libname / filename -> type symbol
    const libref = /^(libname|filename)\s+([A-Za-z_][A-Za-z0-9_]{0,63})/i.exec(text);
    if (libref) {
      const name = libref[2];
      const qname = buildCodeQualifiedName(moduleQname, name);
      symbols.push({
        kind: "type",
        name,
        qualifiedName: qname,
        startLine: st.startLine,
        endLine: st.endLine,
        contentHash: bodyHash(st.startLine, st.endLine),
      });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: st.startLine,
      });
      idx += 1;
      continue;
    }

    // Any other statement: still scan for macro invocations.
    collectSasMacroCalls(st, currentMacro?.qname ?? moduleQname, edges);
    idx += 1;
  }

  return {
    filePath,
    language: "sas",
    symbols,
    edges,
    fileHash: sha256(source),
    rationaleHints,
  };
}

/**
 * Parse a SAS program into the standard `ParsedFile` shape. Robust against
 * malformed input: any internal error degrades to `{ ...empty, unparseable }`
 * rather than throwing (matching the `parseSource` catch contract). Issue #199.
 */
export function parseSas(filePath: string, source: string): ParsedFile {
  try {
    return parseSasInner(filePath, source);
  } catch {
    return {
      filePath,
      language: "sas",
      symbols: [],
      edges: [],
      fileHash: sha256(source),
      rationaleHints: [],
      unparseable: true,
    };
  }
}

// ---------------------------------------------------------------------------
// C# parser (Issue #900) — regex fallback.
//
// The primary path is the `web-tree-sitter` grammar (`parsers-tree-sitter.ts`);
// this deterministic scanner is the fallback used by unit tests that import
// `parseSource` without booting `initCodeGraphParsers()` (mirroring the
// TS/Python/Go/Java fallbacks above). Recognises:
//   - `class Foo` / `struct Foo` / `record Foo` -> class symbol
//   - `interface IFoo` -> interface symbol
//   - `enum E` -> type symbol
//   - method / constructor declarations -> method symbol
//   - `using X.Y;` -> imports edge
//   - `// WHY:` / `// NOTE:` / `// HACK:` / `// TODO:` markers
//
// Nested/generic edge cases are intentionally NOT resolved here — the
// tree-sitter walker handles those in production.
// ---------------------------------------------------------------------------
const CS_KEYWORDS = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "return",
  "using",
  "lock",
  "catch",
  "new",
  "throw",
  "await",
  "yield",
  "get",
  "set",
  "nameof",
  "typeof",
  "sizeof",
  "default",
]);

function parseCSharp(filePath: string, source: string): ParsedFile {
  const lines = source.split(/\r?\n/);
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const rationaleHints: RationaleHint[] = [];
  const moduleQname = moduleQualifiedName(filePath);
  symbols.push({
    kind: "module",
    name: filePath.split("/").pop() ?? filePath,
    qualifiedName: moduleQname,
    startLine: 1,
    endLine: lines.length,
    contentHash: sha256(source),
  });

  const modifiers =
    "(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|virtual|override|async|unsafe|extern|new|\\s)*";
  const typeDeclRe = new RegExp(
    `^\\s*${modifiers}\\b(class|struct|record|interface|enum)\\s+([A-Za-z_]\\w*)`,
  );
  // Method / constructor heuristic: modifiers + return-type + name + `(`.
  const methodRe = new RegExp(`^\\s*${modifiers}\\b[\\w.<>,?\\[\\]]+\\s+([A-Za-z_]\\w*)\\s*\\(`);

  interface CsDef {
    name: string;
    kind: SymbolKind;
    start: number;
    end: number;
  }
  const defs: CsDef[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // using directive -> imports edge (skip `using var x = ...;` / `using (...)`).
    const usingMatch = /^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/.exec(line);
    if (usingMatch && !/=/.test(line)) {
      edges.push({
        kind: "imports",
        fromQualifiedName: moduleQname,
        toQualifiedName: usingMatch[1],
        line: i + 1,
      });
    }

    const typeDecl = typeDeclRe.exec(line);
    if (typeDecl) {
      const csKind = typeDecl[1];
      const name = typeDecl[2];
      const kind: SymbolKind =
        csKind === "interface" ? "interface" : csKind === "enum" ? "type" : "class";
      const end = findBlockEnd(lines, i);
      const qname = buildCodeQualifiedName(moduleQname, name);
      symbols.push({
        kind,
        name,
        qualifiedName: qname,
        startLine: i + 1,
        endLine: end + 1,
        contentHash: sha256(lines.slice(i, end + 1).join("\n")),
      });
      defs.push({ name, kind, start: i, end });
      edges.push({
        kind: "defines",
        fromQualifiedName: moduleQname,
        toQualifiedName: qname,
        line: i + 1,
      });
      continue;
    }

    const methodDecl = methodRe.exec(line);
    if (methodDecl && !/\b(class|struct|record|interface|enum)\b/.test(line)) {
      const name = methodDecl[1];
      if (!CS_KEYWORDS.has(name)) {
        const end = findBlockEnd(lines, i);
        const qname = buildCodeQualifiedName(moduleQname, name);
        symbols.push({
          kind: "method",
          name,
          qualifiedName: qname,
          startLine: i + 1,
          endLine: end + 1,
          contentHash: sha256(lines.slice(i, end + 1).join("\n")),
        });
        edges.push({
          kind: "defines",
          fromQualifiedName: moduleQname,
          toQualifiedName: qname,
          line: i + 1,
        });
      }
    }

    const marker = /^\s*\/\/\s*(WHY|NOTE|HACK|TODO):\s*(.*)$/.exec(line);
    if (marker) {
      rationaleHints.push({
        startLine: i + 1,
        endLine: i + 1,
        tag: marker[1] as RationaleHint["tag"],
        text: marker[2].trim(),
      });
    }
  }

  return { filePath, language: "cs", symbols, edges, fileHash: sha256(source), rationaleHints };
}

// ---------------------------------------------------------------------------
// Top-level dispatcher.
//
// Issue #322 — when `web-tree-sitter` has been initialised (call
// `initCodeGraphParsers()` once at startup; the ingest pipeline does this
// for you), every supported language is parsed via tree-sitter for full
// AST fidelity. Tests that exercise `parseSource` without booting the
// pipeline get the legacy regex parsers — the public contract is identical.
// ---------------------------------------------------------------------------
export function parseSource(filePath: string, source: string, language: Language): ParsedFile {
  try {
    // SAS has no web-tree-sitter grammar — always use the dedicated regex
    // parser. This MUST short-circuit before the `isTreeSitterReady()` branch
    // so SAS is never routed to `parseWithTreeSitter` (which has no SAS
    // backend). Issue #199.
    if (language === "sas") {
      return parseSas(filePath, source);
    }
    if (isTreeSitterReady()) {
      return parseWithTreeSitter(filePath, source, language);
    }
    switch (language) {
      case "ts":
      case "js":
        return parseTsJs(filePath, source, language);
      case "py":
        return parsePython(filePath, source);
      case "go":
        return parseGo(filePath, source);
      case "java":
        return parseJava(filePath, source);
      case "cs":
        return parseCSharp(filePath, source);
    }
  } catch {
    return {
      filePath,
      language,
      symbols: [],
      edges: [],
      fileHash: sha256(source),
      rationaleHints: [],
      unparseable: true,
    };
  }
}
