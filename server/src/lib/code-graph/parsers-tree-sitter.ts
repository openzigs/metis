/**
 * Issue #322 — `web-tree-sitter`-backed implementations of the five
 * Code Discovery parsers (TS/JS/Python/Go/Java).
 *
 * Why this exists: the v1 regex parsers in `parsers.ts` carry documented
 * limitations (nested classes, computed property names, methods inside
 * classes, dynamic `import()`, generic arrow functions, multi-token Java
 * return types). Tree-sitter resolves all of those because it parses to a
 * concrete syntax tree rather than line-by-line regex matching.
 *
 * Public contract:
 *   - `await initCodeGraphParsers()` once at process startup (idempotent).
 *     The ingest pipeline calls this on entry to `ingestCodeGraph`.
 *   - `parseWithTreeSitter(filePath, source, language)` is a synchronous
 *     parse against the cached grammars. Returns the same `ParsedFile`
 *     shape the legacy regex parsers produced — `ingest.ts` is unchanged.
 *   - `isTreeSitterReady()` reports init status; the dispatcher in
 *     `parsers.ts` uses it to fall back to the legacy regex parser when
 *     the WASM grammars haven't been loaded (e.g. unit tests that import
 *     `parseSource` without booting the ingest pipeline).
 *
 * Loading model: WASM grammar files are resolved via `require.resolve`
 * against the `tree-sitter-*` packages installed in `server/node_modules`.
 * Vitest's Node 20+ runtime supports `WebAssembly.instantiate` natively,
 * no special vite/vitest config is needed.
 *
 * NOTE on web-tree-sitter version: pinned to 0.24.4 to match the wrapper
 * image (`images/mcp-wrappers/code-graph-runner-sse/package.json`). The
 * 0.25.x line introduced a different Module loader API that requires
 * adapter shims in Node — we explicitly stay on 0.24.x.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { buildCodeQualifiedName, moduleQualifiedName } from "./qualified-name.js";
import type {
  EdgeKind,
  Language,
  ParsedEdge,
  ParsedFile,
  ParsedSymbol,
  RationaleHint,
  SymbolKind,
} from "./parsers.js";

// `web-tree-sitter` 0.24 ships a CJS-only entry point. We use createRequire
// rather than top-level import so vitest's ESM transform doesn't try to
// re-process the emscripten loader.
const require = createRequire(import.meta.url);
type Tree = { rootNode: SyntaxNode };
type SyntaxNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childCount: number;
  childForFieldName: (name: string) => SyntaxNode | null;
  parent: SyntaxNode | null;
};
interface ParserCtor {
  new (): {
    setLanguage: (lang: unknown) => void;
    parse: (source: string) => Tree;
  };
  init: () => Promise<void>;
  Language: { load: (path: string) => Promise<unknown> };
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

interface LoadedParser {
  parser: { parse: (source: string) => Tree };
}

let parsers: Map<Language, LoadedParser> | null = null;
let initPromise: Promise<void> | null = null;

/** Idempotent — returns the existing init promise if one is in flight. */
export async function initCodeGraphParsers(): Promise<void> {
  if (parsers) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const Parser: ParserCtor = require("web-tree-sitter");
    await Parser.init();
    // SAS has no tree-sitter grammar — it is handled by the regex `parseSas`
    // path in parsers.ts before tree-sitter is consulted, so it is absent here.
    const grammarPaths: Partial<Record<Language, string>> = {
      ts: require.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm"),
      js: require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm"),
      py: require.resolve("tree-sitter-python/tree-sitter-python.wasm"),
      go: require.resolve("tree-sitter-go/tree-sitter-go.wasm"),
      java: require.resolve("tree-sitter-java/tree-sitter-java.wasm"),
      // Issue #900 — C#/.NET. The package publishes its prebuilt grammar as
      // `tree-sitter-c_sharp.wasm` (underscore), not `-c-sharp`.
      cs: require.resolve("tree-sitter-c-sharp/tree-sitter-c_sharp.wasm"),
    };
    const next = new Map<Language, LoadedParser>();
    for (const [lang, path] of Object.entries(grammarPaths) as Array<[Language, string]>) {
      const grammar = await Parser.Language.load(path);
      const p = new Parser();
      p.setLanguage(grammar);
      next.set(lang, { parser: p as { parse: (source: string) => Tree } });
    }
    parsers = next;
  })();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

export function isTreeSitterReady(): boolean {
  return parsers !== null;
}

/** Test seam — drop the loaded parsers so a subsequent init call re-runs. */
export function __resetCodeGraphParsersForTests(): void {
  parsers = null;
  initPromise = null;
}

/** Synchronous parse — fails if `initCodeGraphParsers` hasn't completed. */
export function parseWithTreeSitter(
  filePath: string,
  source: string,
  language: Language,
): ParsedFile {
  if (!parsers) {
    throw new Error("parseWithTreeSitter called before initCodeGraphParsers()");
  }
  const loaded = parsers.get(language);
  if (!loaded) {
    throw new Error(`No tree-sitter grammar loaded for language=${language}`);
  }
  let tree: Tree;
  try {
    tree = loaded.parser.parse(source);
  } catch {
    return unparseable(filePath, language, source);
  }
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const moduleQname = moduleQualifiedName(filePath);
  symbols.push({
    kind: "module",
    name: filePath.split("/").pop() ?? filePath,
    qualifiedName: moduleQname,
    startLine: 1,
    endLine: source.split(/\r?\n/).length,
    contentHash: sha256(source),
  });

  switch (language) {
    case "ts":
    case "js":
      walkTsJs(tree.rootNode, source, moduleQname, symbols, edges);
      break;
    case "py":
      walkPython(tree.rootNode, source, moduleQname, symbols, edges);
      break;
    case "go":
      walkGo(tree.rootNode, source, moduleQname, symbols, edges);
      break;
    case "java":
      walkJava(tree.rootNode, source, moduleQname, symbols, edges);
      break;
    case "cs":
      walkCSharp(tree.rootNode, source, moduleQname, symbols, edges);
      break;
  }
  // Rationale hints are comment-text scanning — orthogonal to grammar and
  // cheaper to keep regex-based.
  const rationaleHints = collectRationaleHints(source, language);

  return {
    filePath,
    language,
    symbols,
    edges,
    fileHash: sha256(source),
    rationaleHints,
  };
}

function unparseable(filePath: string, language: Language, source: string): ParsedFile {
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

/**
 * A string/template literal located in source — Epic #294 (#305). `text` is the
 * literal's INNER content (quotes stripped); for a template/interpolated string
 * any `${...}` / `%s` substitutions are preserved verbatim so the SQL-lineage
 * sidecar can flag the dynamic parts `uncertain`. `line` is 1-based.
 */
export interface StringLiteral {
  text: string;
  line: number;
  /** True when the literal contains an interpolation/substitution (dynamic SQL). */
  dynamic: boolean;
}

// Top-level string-literal node types per grammar (probed empirically).
const STRING_NODE_TYPES: Partial<Record<Language, Set<string>>> = {
  ts: new Set(["string", "template_string"]),
  js: new Set(["string", "template_string"]),
  py: new Set(["string"]),
  go: new Set(["interpreted_string_literal", "raw_string_literal"]),
  // Issue #888 — Java has no template-literal grammar; a `string_literal` is
  // always a compile-time constant, so `dynamic` naturally stays false for a
  // bare literal (Java's "dynamic SQL" is expressed via `+` concatenation /
  // `StringBuilder.append(...)` chains, handled separately — Issue #889).
  java: new Set(["string_literal"]),
  // Issue #900 — C#/.NET (ADO.NET / Dapper embedded SQL). Covers regular
  // (`"..."`), verbatim (`@"..."`), raw (`"""..."""`), and interpolated
  // (`$"...{x}..."`) string forms; an interpolated string carries an
  // `interpolation` child so `findStringLiterals` naturally flags it `dynamic`.
  cs: new Set([
    "string_literal",
    "verbatim_string_literal",
    "raw_string_literal",
    "interpolated_string_expression",
  ]),
};

/** Strip one layer of surrounding quotes/backticks from a literal's raw text. */
function stripQuotes(raw: string): string {
  let s = raw;
  // Python triple-quoted strings first.
  for (const q of ['"""', "'''"]) {
    if (s.startsWith(q) && s.endsWith(q) && s.length >= 2 * q.length) {
      return s.slice(q.length, -q.length);
    }
  }
  // C# verbatim / interpolated prefixes (`@"..."`, `$"..."`, `$@"..."`) —
  // Issue #900. Stripped before the letter-prefix rule so the surrounding
  // quotes are then removed normally.
  s = s.replace(/^[@$]{1,2}(?=["'`])/, "");
  // Optional language prefix (e.g. Python r"...", f"...", b"...").
  s = s.replace(/^[a-zA-Z]{1,2}(?=["'`])/, "");
  const first = s[0];
  if ((first === '"' || first === "'" || first === "`") && s.endsWith(first)) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Locate string + template literals in a source file via tree-sitter — Epic #294
 * (#305). Returns the inner text + line + a `dynamic` flag (true when the literal
 * interpolates). Used by the embedded-SQL extractor to find candidate SQL strings
 * in TS/JS/Python/Go before handing them to the sql-lineage sidecar.
 *
 * Returns `[]` (never throws) when tree-sitter isn't initialized, the grammar is
 * missing, or the file fails to parse — callers degrade gracefully.
 */
export function findStringLiterals(source: string, language: Language): StringLiteral[] {
  const types = STRING_NODE_TYPES[language];
  if (!parsers || !types) return [];
  const loaded = parsers.get(language);
  if (!loaded) return [];
  let tree: Tree;
  try {
    tree = loaded.parser.parse(source);
  } catch {
    return [];
  }
  const out: StringLiteral[] = [];
  walk(tree.rootNode, (n) => {
    if (!types.has(n.type)) return;
    const raw = n.text;
    // A template/interpolated literal interpolates when it has a substitution
    // child (`template_substitution` / `interpolation`), or carries `${`/`%(`.
    const dynamic =
      n.namedChildren.some((c) => /substitution|interpolation/i.test(c.type)) ||
      /\$\{|%\(|%s\b|\?\?/.test(raw);
    out.push({ text: stripQuotes(raw), line: n.startPosition.row + 1, dynamic });
    // Do not descend into a string node's children (avoids double-counting the
    // fragment/content child nodes).
    return "skip";
  });
  return out;
}

// ---------------------------------------------------------------------------
// Java string-concatenation SQL assembly — Issue #889 (epic #880).
//
// Java raw JDBC SQL is frequently built by concatenating string CONSTANTS with
// `+` (`"SELECT ... " + "FROM foo " + "WHERE ..."`) or by chaining
// `StringBuilder`/`StringBuffer` `.append("literal")` calls. To recover table
// lineage the statically-known pieces must be joined into ONE SQL string BEFORE
// it is handed to the sqlglot sidecar. When a non-constant operand (a variable
// or a method call) is mixed in, the identifier is unknowable statically, so the
// candidate is flagged `dynamic` — the extractor then records it as
// unresolved/dynamic rather than shipping a truncated string to the parser
// (Issue #889 acceptance: "marked unresolved/dynamic rather than mis-parsed").
//
// This deliberately supersedes the plain per-literal scan for Java (#888): a
// lone `string_literal` is just a one-operand chain, so every Java SQL candidate
// — lone, `+`-joined, or `StringBuilder`-assembled — flows through this single
// function, and the consumed-node set prevents a fragment from being emitted
// twice (once as part of an assembly and once as a bare literal).
// ---------------------------------------------------------------------------

const JAVA_STRING_BUILDER_TYPES = new Set(["StringBuilder", "StringBuffer"]);

/** One operand of a Java string-building expression. */
interface JavaSqlPart {
  /** The literal text (quotes stripped) for a constant, else the empty string. */
  text: string;
  /** True only for a compile-time string literal; false for any dynamic operand. */
  literal: boolean;
}

/**
 * Flatten a Java expression that produces a string into its ordered operands.
 * A `+` binary expression recurses left-then-right (Java `+` is left-associative,
 * so this yields source order); a parenthesized expression unwraps; a bare string
 * literal is one constant part; anything else (identifier, method call, numeric
 * literal, …) is a single NON-literal part.
 */
function flattenJavaStringExpr(node: SyntaxNode): JavaSqlPart[] {
  switch (node.type) {
    case "string_literal":
      return [{ text: stripQuotes(node.text), literal: true }];
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner ? flattenJavaStringExpr(inner) : [{ text: "", literal: false }];
    }
    case "binary_expression": {
      const op = node.childForFieldName("operator");
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (op?.text === "+" && left && right) {
        return [...flattenJavaStringExpr(left), ...flattenJavaStringExpr(right)];
      }
      return [{ text: "", literal: false }];
    }
    default:
      return [{ text: "", literal: false }];
  }
}

/** Assemble ordered parts into one candidate string + a dynamic flag. */
function assembleJavaParts(parts: JavaSqlPart[]): { text: string; dynamic: boolean } {
  return {
    text: parts.map((p) => p.text).join(""),
    dynamic: parts.some((p) => !p.literal),
  };
}

/** Nearest enclosing `block` for scoping a StringBuilder's append search. */
function enclosingJavaBlock(node: SyntaxNode): SyntaxNode | null {
  let p = node.parent;
  while (p && p.type !== "block") p = p.parent;
  return p;
}

/**
 * Unwind a (possibly fluent) `x.append(a).append(b)` invocation to the base
 * receiver identifier, e.g. `sb`. Returns null when the receiver is not a plain
 * identifier (field access, another call, etc.).
 */
function javaAppendRootIdentifier(mi: SyntaxNode): string | null {
  let obj = mi.childForFieldName("object");
  while (obj && obj.type === "method_invocation") {
    obj = obj.childForFieldName("object");
  }
  return obj && obj.type === "identifier" ? obj.text : null;
}

/** Record every string/concat node in a subtree so a later pass won't re-emit it. */
function markJavaConsumed(node: SyntaxNode, consumed: Set<number>): void {
  walk(node, (n) => {
    if (
      n.type === "string_literal" ||
      n.type === "binary_expression" ||
      n.type === "parenthesized_expression"
    ) {
      consumed.add(n.startIndex);
    }
  });
}

/**
 * Locate Java SQL candidates, assembling `+`-concatenated string constants and
 * simple `StringBuilder`/`StringBuffer` `.append(...)` chains into single strings
 * — Issue #889. Returns the same {@link StringLiteral} shape the sidecar path
 * consumes (`text` + 1-based `line` + `dynamic`). A candidate that mixes in a
 * non-constant operand is flagged `dynamic: true`.
 *
 * Returns `[]` (never throws) when tree-sitter isn't initialized, the Java
 * grammar is missing, or the file fails to parse — callers degrade gracefully.
 */
export function findJavaConcatSqlCandidates(source: string): StringLiteral[] {
  if (!parsers) return [];
  const loaded = parsers.get("java");
  if (!loaded) return [];
  let tree: Tree;
  try {
    tree = loaded.parser.parse(source);
  } catch {
    return [];
  }

  const out: StringLiteral[] = [];
  // startIndex of nodes already folded into a StringBuilder/`+` assembly, so the
  // bare-literal / `+`-chain passes below don't double-count them.
  const consumed = new Set<number>();

  // Pass 1 — StringBuilder / StringBuffer `.append(...)` assembly.
  walk(tree.rootNode, (n) => {
    if (n.type !== "local_variable_declaration") return;
    const typeNode = n.childForFieldName("type");
    if (!typeNode || !JAVA_STRING_BUILDER_TYPES.has(typeNode.text)) return;
    for (const declarator of n.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const nameNode = declarator.childForFieldName("name");
      if (!nameNode) continue;
      const varName = nameNode.text;
      const parts: JavaSqlPart[] = [];

      // A `new StringBuilder("SELECT ...")` seed argument, if present.
      const init = declarator.childForFieldName("value");
      let ctorArg: SyntaxNode | undefined;
      if (init && init.type === "object_creation_expression") {
        ctorArg = init.childForFieldName("arguments")?.namedChildren[0];
        if (ctorArg) parts.push(...flattenJavaStringExpr(ctorArg));
      }

      // Collect `.append(arg)` calls on this variable within the enclosing block,
      // ordered by the ARGUMENT's position (fluent chains share the invocation's
      // start offset, so ordering on the invocation would be ambiguous).
      const scope = enclosingJavaBlock(n) ?? tree.rootNode;
      const appends: { arg: SyntaxNode }[] = [];
      walk(scope, (m) => {
        if (m.type !== "method_invocation") return;
        if (m.childForFieldName("name")?.text !== "append") return;
        if (javaAppendRootIdentifier(m) !== varName) return;
        const arg = m.childForFieldName("arguments")?.namedChildren[0];
        if (arg) appends.push({ arg });
      });
      appends.sort((a, b) => a.arg.startIndex - b.arg.startIndex);
      for (const a of appends) {
        parts.push(...flattenJavaStringExpr(a.arg));
        markJavaConsumed(a.arg, consumed);
      }
      if (ctorArg) markJavaConsumed(ctorArg, consumed);

      if (parts.length > 0) {
        const { text, dynamic } = assembleJavaParts(parts);
        out.push({ text, line: nameNode.startPosition.row + 1, dynamic });
      }
    }
  });

  // Pass 2 — `+` concatenation chains and lone string literals. Processing the
  // OUTERMOST `+` node first (pre-order) and skipping its subtree means each
  // chain is assembled exactly once and its fragments are never re-emitted.
  walk(tree.rootNode, (n) => {
    if (n.type === "string_literal") {
      if (consumed.has(n.startIndex)) return "skip";
      out.push({ text: stripQuotes(n.text), line: n.startPosition.row + 1, dynamic: false });
      return "skip";
    }
    if (n.type === "binary_expression") {
      if (consumed.has(n.startIndex)) return "skip";
      if (n.childForFieldName("operator")?.text !== "+") return undefined;
      const parts = flattenJavaStringExpr(n);
      // A `+` expression with no string literal at all (e.g. numeric `a + b`) is
      // not a SQL candidate — leave it for normal descent.
      if (!parts.some((p) => p.literal)) return undefined;
      const { text, dynamic } = assembleJavaParts(parts);
      out.push({ text, line: n.startPosition.row + 1, dynamic });
      return "skip";
    }
    return undefined;
  });

  return out;
}

/** Helper — return the AST node body slice as a stable hash input. */
function bodyHash(source: string, node: SyntaxNode): string {
  return sha256(source.slice(node.startIndex, node.endIndex));
}

/** Helper — emit a `defines` edge from module to a symbol. */
function emitDefines(edges: ParsedEdge[], moduleQname: string, symbol: ParsedSymbol): void {
  edges.push({
    kind: "defines",
    fromQualifiedName: moduleQname,
    toQualifiedName: symbol.qualifiedName,
    line: symbol.startLine,
  });
}

/** Walk a node + all descendants invoking `visit`. */
function walk(node: SyntaxNode, visit: (n: SyntaxNode) => void | "skip"): void {
  const r = visit(node);
  if (r === "skip") return;
  for (const c of node.namedChildren) walk(c, visit);
}

// ---------------------------------------------------------------------------
// TS / JS walker
// Resolves: nested classes, methods inside classes, computed property names,
// re-exports, dynamic imports, generic arrow functions.
// ---------------------------------------------------------------------------
function walkTsJs(
  root: SyntaxNode,
  source: string,
  moduleQname: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[],
): void {
  // qualifier stack — nested classes contribute to method qualified names.
  type Frame = { name: string; node: SyntaxNode };
  const declStack: Frame[] = [];

  // Depth-first walk + push/pop discipline means the top of declStack at any
  // visit point IS the immediately enclosing decl. No need to walk
  // node.parent — that allocates fresh wrappers per call and was previously
  // O(depth × refs) per file, which dominated runtime on large TSX files
  // (#383 perf fix).
  const enclosingDefQname = (_node: SyntaxNode): string =>
    declStack.length ? declStack[declStack.length - 1].name : moduleQname;

  const recordSymbol = (node: SyntaxNode, name: string, kind: SymbolKind): ParsedSymbol => {
    const parentQ = declStack.length ? declStack[declStack.length - 1].name : moduleQname;
    const qname = buildCodeQualifiedName(parentQ, name);
    const symbol: ParsedSymbol = {
      kind,
      name,
      qualifiedName: qname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      contentHash: bodyHash(source, node),
    };
    symbols.push(symbol);
    emitDefines(edges, parentQ, symbol);
    return symbol;
  };

  const nameOf = (node: SyntaxNode): string | null => {
    const id = node.childForFieldName("name");
    if (id) return id.text;
    return null;
  };

  const visit = (n: SyntaxNode): void | "skip" => {
    switch (n.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = nameOf(n);
        if (name) {
          const sym = recordSymbol(n, name, "function");
          declStack.push({ name: sym.qualifiedName, node: n });
          for (const c of n.namedChildren) walk(c, visit);
          declStack.pop();
          return "skip";
        }
        break;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = nameOf(n);
        if (name) {
          const sym = recordSymbol(n, name, "class");
          declStack.push({ name: sym.qualifiedName, node: n });
          // Skip the class's own name child so the type_identifier walker
          // doesn't emit a self-reference. childForFieldName returns a fresh
          // wrapper on every call — compare by startIndex, not identity.
          // Heritage clauses (extends/implements) are NOT skipped — they are
          // real references to other types.
          const nameNode = n.childForFieldName("name");
          const nameStart = nameNode?.startIndex ?? -1;
          for (const c of n.namedChildren) {
            if (c.startIndex === nameStart) continue;
            walk(c, visit);
          }
          declStack.pop();
          return "skip";
        }
        break;
      }
      case "interface_declaration": {
        const name = nameOf(n);
        if (name) recordSymbol(n, name, "interface");
        return "skip";
      }
      case "type_alias_declaration": {
        const name = nameOf(n);
        if (name) recordSymbol(n, name, "type");
        return "skip";
      }
      case "method_definition":
      case "method_signature": {
        // Inside a class — record as method, qualified by enclosing class.
        const nameNode = n.childForFieldName("name");
        const nameStart = nameNode?.startIndex ?? -1;
        let methodSym: ParsedSymbol | undefined;
        if (nameNode) {
          // computed property names: tree-sitter exposes them as
          // `computed_property_name` whose text includes the brackets.
          const methodName = nameNode.text.replace(/^\[|\]$/g, "");
          methodSym = recordSymbol(n, methodName, "method");
        }
        // Descend into the body so calls/references inside the method get
        // visited. Without this, the entire ~6k method-body call-graph for
        // a class-heavy codebase is silently dropped (#383). Push the method
        // qname onto the stack so enclosingDefQname returns it for nested
        // calls/refs.
        if (methodSym) declStack.push({ name: methodSym.qualifiedName, node: n });
        for (const c of n.namedChildren) {
          if (c.startIndex === nameStart) continue;
          walk(c, visit);
        }
        if (methodSym) declStack.pop();
        return "skip";
      }
      case "lexical_declaration":
      case "variable_declaration": {
        // `const foo = (...) => ...` — record arrow-fn as function.
        for (const decl of n.namedChildren) {
          if (decl.type !== "variable_declarator") continue;
          const nameNode = decl.childForFieldName("name");
          const valueNode = decl.childForFieldName("value");
          if (!nameNode || !valueNode) continue;
          if (valueNode.type === "arrow_function" || valueNode.type === "function_expression") {
            recordSymbol(decl, nameNode.text, "function");
          }
        }
        return; // continue walking nested calls
      }
      case "import_statement": {
        // Static import. `import_clause` may include `import type`.
        const sourceNode = n.childForFieldName("source");
        if (sourceNode) {
          const src = sourceNode.text.replace(/^['"`]|['"`]$/g, "");
          // Detect `import type` by inspecting the raw text — the AST exposes
          // it as `type` keyword in the import_clause.
          const typeOnly = /^\s*import\s+type\b/.test(source.slice(n.startIndex, n.endIndex));
          edges.push({
            kind: "imports",
            fromQualifiedName: moduleQname,
            toQualifiedName: src,
            line: n.startPosition.row + 1,
            metadata: typeOnly ? { typeOnly: true } : undefined,
          });
        }
        return "skip";
      }
      case "export_statement": {
        // `export ... from '...'` — re-export edge (resolves the v1 limitation).
        const sourceNode = n.childForFieldName("source");
        if (sourceNode) {
          const src = sourceNode.text.replace(/^['"`]|['"`]$/g, "");
          edges.push({
            kind: "imports",
            fromQualifiedName: moduleQname,
            toQualifiedName: src,
            line: n.startPosition.row + 1,
            metadata: { reExport: true },
          });
        }
        // continue walking — the export may wrap a class/function declaration.
        return;
      }
      case "call_expression": {
        const fn = n.childForFieldName("function");
        if (fn) {
          // `import(...)` dynamic import → record as imports edge with the
          // literal target when the arg is a string literal.
          if (fn.type === "import") {
            const args = n.childForFieldName("arguments");
            const firstArg = args?.namedChildren?.[0];
            if (firstArg && firstArg.type === "string") {
              const src = firstArg.text.replace(/^['"`]|['"`]$/g, "");
              edges.push({
                kind: "imports",
                fromQualifiedName: moduleQname,
                toQualifiedName: src,
                line: n.startPosition.row + 1,
                metadata: { dynamic: true },
              });
            }
            return; // continue
          }
          // Plain identifier or member expression — record the call.
          let callee: string | null = null;
          if (fn.type === "identifier") callee = fn.text;
          else if (fn.type === "member_expression") {
            const prop = fn.childForFieldName("property");
            if (prop) callee = prop.text;
          } else if (fn.type === "super") callee = "super";
          if (callee) {
            edges.push({
              kind: "calls",
              fromQualifiedName: enclosingDefQname(n),
              toQualifiedName: callee,
              line: n.startPosition.row + 1,
            });
          }
        }
        return; // continue walking arguments for nested calls.
      }
      case "new_expression": {
        // `new Foo(...)` — emit a `references` edge to the constructor name.
        // Tree-sitter exposes the constructor as the first named child
        // (typically `identifier` or `member_expression`).
        const ctor = n.childForFieldName("constructor") ?? n.namedChildren[0];
        let target: string | null = null;
        if (ctor) {
          if (ctor.type === "identifier") target = ctor.text;
          else if (ctor.type === "member_expression") {
            const prop = ctor.childForFieldName("property");
            if (prop) target = prop.text;
          }
        }
        if (target) {
          edges.push({
            kind: "references",
            fromQualifiedName: enclosingDefQname(n),
            toQualifiedName: target,
            line: n.startPosition.row + 1,
            metadata: { via: "new" },
          });
        }
        return; // continue walking arguments
      }
      case "decorator": {
        // `@Foo` or `@Foo(...)` — emit a `references` edge to the decorator
        // name. When the body is a call, the call_expression child will
        // separately emit a `calls` edge — that's intentional (decorators
        // are both a reference and an invocation when parameterised).
        const child = n.namedChildren[0];
        let target: string | null = null;
        if (child) {
          if (child.type === "identifier") target = child.text;
          else if (child.type === "member_expression") {
            const prop = child.childForFieldName("property");
            if (prop) target = prop.text;
          } else if (child.type === "call_expression") {
            // Let the call walker handle it; still emit a reference to the
            // decorator's leading identifier.
            const fn = child.childForFieldName("function");
            if (fn?.type === "identifier") target = fn.text;
            else if (fn?.type === "member_expression") {
              const prop = fn.childForFieldName("property");
              if (prop) target = prop.text;
            }
          }
        }
        if (target) {
          edges.push({
            kind: "references",
            fromQualifiedName: enclosingDefQname(n),
            toQualifiedName: target,
            line: n.startPosition.row + 1,
            metadata: { via: "decorator" },
          });
        }
        return; // continue — let the inner call_expression also fire.
      }
      case "jsx_opening_element":
      case "jsx_self_closing_element": {
        // `<MyButton ... />` — references the component when it's PascalCase.
        // Lowercase tags (`<div>`) are intrinsic HTML, not symbol references.
        const nameNode = n.childForFieldName("name") ?? n.namedChildren[0];
        if (nameNode) {
          let target: string | null = null;
          if (nameNode.type === "identifier") target = nameNode.text;
          else if (nameNode.type === "member_expression") {
            // <Foo.Bar /> — reference Bar (e.g. compound component).
            const prop = nameNode.childForFieldName("property");
            if (prop) target = prop.text;
          }
          if (target && /^[A-Z]/.test(target)) {
            edges.push({
              kind: "references",
              fromQualifiedName: enclosingDefQname(n),
              toQualifiedName: target,
              line: n.startPosition.row + 1,
              metadata: { via: "jsx" },
            });
          }
        }
        return;
      }
      case "type_identifier": {
        // Type references (annotations, generics, extends/implements clauses).
        // We only reach this branch for type_identifier nodes that weren't
        // skipped by the class/interface/type_alias declaration handlers
        // (those return "skip" before we descend into their `name` field).
        const target = n.text;
        edges.push({
          kind: "references",
          fromQualifiedName: enclosingDefQname(n),
          toQualifiedName: target,
          line: n.startPosition.row + 1,
          metadata: { via: "type" },
        });
        return;
      }
    }
  };

  walk(root, visit);
}

// ---------------------------------------------------------------------------
// Python walker
// Resolves: decorator-introduced symbols (records the original kind + a
// metadata.decorators list).
// ---------------------------------------------------------------------------
function walkPython(
  root: SyntaxNode,
  source: string,
  moduleQname: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[],
): void {
  type Frame = { name: string; node: SyntaxNode };
  const declStack: Frame[] = [];

  // See walkTsJs comment — stack-top access is O(1) and correct for DFS.
  const enclosingDefQname = (_node: SyntaxNode): string =>
    declStack.length ? declStack[declStack.length - 1].name : moduleQname;

  const recordSymbol = (node: SyntaxNode, name: string, kind: SymbolKind): ParsedSymbol => {
    const parentQ = declStack.length ? declStack[declStack.length - 1].name : moduleQname;
    const qname = buildCodeQualifiedName(parentQ, name);
    const sym: ParsedSymbol = {
      kind,
      name,
      qualifiedName: qname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      contentHash: bodyHash(source, node),
    };
    symbols.push(sym);
    emitDefines(edges, parentQ, sym);
    return sym;
  };

  const visit = (n: SyntaxNode): void | "skip" => {
    switch (n.type) {
      case "function_definition": {
        const id = n.childForFieldName("name");
        if (id) {
          const sym = recordSymbol(n, id.text, "function");
          declStack.push({ name: sym.qualifiedName, node: n });
          for (const c of n.namedChildren) walk(c, visit);
          declStack.pop();
          return "skip";
        }
        break;
      }
      case "class_definition": {
        const id = n.childForFieldName("name");
        if (id) {
          const sym = recordSymbol(n, id.text, "class");
          declStack.push({ name: sym.qualifiedName, node: n });
          for (const c of n.namedChildren) walk(c, visit);
          declStack.pop();
          return "skip";
        }
        break;
      }
      case "decorated_definition": {
        // The actual function/class is the last named child; let the recursive
        // walk handle it. Decorator children fall through to the `decorator`
        // case below for `references` emission.
        return; // continue
      }
      case "decorator": {
        // `@foo` / `@foo.bar` / `@foo(arg)` — emit a `references` edge to the
        // decorator name. When the decorator wraps a call, the call walker
        // also fires (a parameterised decorator IS both a reference and a
        // call, mirroring the TS behaviour).
        const child = n.namedChildren[0];
        let target: string | null = null;
        if (child) {
          if (child.type === "identifier") target = child.text;
          else if (child.type === "attribute") {
            const attr = child.childForFieldName("attribute");
            if (attr) target = attr.text;
          } else if (child.type === "call") {
            const fn = child.childForFieldName("function");
            if (fn?.type === "identifier") target = fn.text;
            else if (fn?.type === "attribute") {
              const attr = fn.childForFieldName("attribute");
              if (attr) target = attr.text;
            }
          }
        }
        if (target) {
          edges.push({
            kind: "references",
            fromQualifiedName: enclosingDefQname(n),
            toQualifiedName: target,
            line: n.startPosition.row + 1,
            metadata: { via: "decorator" },
          });
        }
        return; // continue — let the inner call also fire.
      }
      case "import_statement": {
        // `import x.y.z` / `import x as y, w`
        for (const c of n.namedChildren) {
          if (c.type === "dotted_name") {
            edges.push({
              kind: "imports",
              fromQualifiedName: moduleQname,
              toQualifiedName: c.text,
              line: n.startPosition.row + 1,
            });
          } else if (c.type === "aliased_import") {
            const real = c.childForFieldName("name");
            if (real) {
              edges.push({
                kind: "imports",
                fromQualifiedName: moduleQname,
                toQualifiedName: real.text,
                line: n.startPosition.row + 1,
              });
            }
          }
        }
        return "skip";
      }
      case "import_from_statement": {
        const mod = n.childForFieldName("module_name");
        if (mod) {
          edges.push({
            kind: "imports",
            fromQualifiedName: moduleQname,
            toQualifiedName: mod.text,
            line: n.startPosition.row + 1,
          });
        }
        return "skip";
      }
      case "call": {
        const fn = n.childForFieldName("function");
        if (fn) {
          let callee: string | null = null;
          if (fn.type === "identifier") callee = fn.text;
          else if (fn.type === "attribute") {
            const attr = fn.childForFieldName("attribute");
            if (attr) callee = attr.text;
          }
          if (callee) {
            edges.push({
              kind: "calls",
              fromQualifiedName: enclosingDefQname(n),
              toQualifiedName: callee,
              line: n.startPosition.row + 1,
            });
          }
        }
        return; // continue
      }
    }
  };
  walk(root, visit);
}

// ---------------------------------------------------------------------------
// Go walker
// TODO(#383): Go currently emits `calls` edges only. `references` for
// composite literals (`Foo{...}`), type assertions, and unqualified type
// usages would round out parity with TS/JS/Python/Java but are deferred —
// the value-add is small for the metis codebase footprint.
// ---------------------------------------------------------------------------
function walkGo(
  root: SyntaxNode,
  source: string,
  moduleQname: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[],
): void {
  type Frame = { name: string; node: SyntaxNode };
  const declStack: Frame[] = [];

  // See walkTsJs comment — stack-top access is O(1) and correct for DFS.
  const enclosingDefQname = (_node: SyntaxNode): string =>
    declStack.length ? declStack[declStack.length - 1].name : moduleQname;

  const recordSymbol = (node: SyntaxNode, name: string, kind: SymbolKind): ParsedSymbol => {
    const qname = buildCodeQualifiedName(moduleQname, name);
    const sym: ParsedSymbol = {
      kind,
      name,
      qualifiedName: qname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      contentHash: bodyHash(source, node),
    };
    symbols.push(sym);
    emitDefines(edges, moduleQname, sym);
    return sym;
  };

  const visit = (n: SyntaxNode): void | "skip" => {
    switch (n.type) {
      case "function_declaration":
      case "method_declaration": {
        const id = n.childForFieldName("name");
        if (id) {
          const sym = recordSymbol(n, id.text, "function");
          declStack.push({ name: sym.qualifiedName, node: n });
          for (const c of n.namedChildren) walk(c, visit);
          declStack.pop();
          return "skip";
        }
        break;
      }
      case "type_declaration": {
        for (const spec of n.namedChildren) {
          if (spec.type !== "type_spec") continue;
          const id = spec.childForFieldName("name");
          const t = spec.childForFieldName("type");
          if (!id) continue;
          const kind: SymbolKind =
            t?.type === "interface_type"
              ? "interface"
              : t?.type === "struct_type"
                ? "class"
                : "type";
          recordSymbol(spec, id.text, kind);
        }
        return "skip";
      }
      case "import_declaration": {
        // Two shapes: `import "x"` and `import (...)`.
        for (const c of n.namedChildren) {
          collectGoImports(c, moduleQname, edges);
        }
        return "skip";
      }
      case "call_expression": {
        const fn = n.childForFieldName("function");
        if (fn) {
          let callee: string | null = null;
          if (fn.type === "identifier") callee = fn.text;
          else if (fn.type === "selector_expression") {
            const field = fn.childForFieldName("field");
            if (field) callee = field.text;
          }
          if (callee) {
            edges.push({
              kind: "calls",
              fromQualifiedName: enclosingDefQname(n),
              toQualifiedName: callee,
              line: n.startPosition.row + 1,
            });
          }
        }
        return;
      }
    }
  };
  walk(root, visit);
}

function collectGoImports(node: SyntaxNode, moduleQname: string, edges: ParsedEdge[]): void {
  if (node.type === "import_spec") {
    const path = node.childForFieldName("path");
    if (path) {
      const target = path.text.replace(/^"|"$/g, "");
      edges.push({
        kind: "imports",
        fromQualifiedName: moduleQname,
        toQualifiedName: target,
        line: node.startPosition.row + 1,
      });
    }
    return;
  }
  if (node.type === "import_spec_list") {
    for (const c of node.namedChildren) collectGoImports(c, moduleQname, edges);
  }
}

// ---------------------------------------------------------------------------
// Java walker
// Resolves: methods inside classes, multi-token return types, nested classes.
// ---------------------------------------------------------------------------
function walkJava(
  root: SyntaxNode,
  source: string,
  moduleQname: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[],
): void {
  type Frame = { name: string; node: SyntaxNode };
  const declStack: Frame[] = [];

  // See walkTsJs comment — stack-top access is O(1) and correct for DFS.
  const enclosingDefQname = (_node: SyntaxNode): string =>
    declStack.length ? declStack[declStack.length - 1].name : moduleQname;

  const recordSymbol = (node: SyntaxNode, name: string, kind: SymbolKind): ParsedSymbol => {
    const parentQ = declStack.length ? declStack[declStack.length - 1].name : moduleQname;
    const qname = buildCodeQualifiedName(parentQ, name);
    const sym: ParsedSymbol = {
      kind,
      name,
      qualifiedName: qname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      contentHash: bodyHash(source, node),
    };
    symbols.push(sym);
    emitDefines(edges, parentQ, sym);
    return sym;
  };

  const visit = (n: SyntaxNode): void | "skip" => {
    switch (n.type) {
      case "class_declaration": {
        const id = n.childForFieldName("name");
        const idStart = id?.startIndex ?? -1;
        if (id) {
          const sym = recordSymbol(n, id.text, "class");
          declStack.push({ name: sym.qualifiedName, node: n });
          for (const c of n.namedChildren) {
            if (c.startIndex === idStart) continue;
            walk(c, visit);
          }
          declStack.pop();
          return "skip";
        }
        break;
      }
      case "interface_declaration": {
        const id = n.childForFieldName("name");
        const idStart = id?.startIndex ?? -1;
        if (id) {
          const sym = recordSymbol(n, id.text, "interface");
          declStack.push({ name: sym.qualifiedName, node: n });
          for (const c of n.namedChildren) {
            if (c.startIndex === idStart) continue;
            walk(c, visit);
          }
          declStack.pop();
          return "skip";
        }
        break;
      }
      case "method_declaration": {
        const id = n.childForFieldName("name");
        const idStart = id?.startIndex ?? -1;
        let methodSym: ParsedSymbol | undefined;
        if (id) methodSym = recordSymbol(n, id.text, "method");
        // Descend so annotations on the method, parameter type references,
        // and method-body calls all get visited (#383).
        if (methodSym) declStack.push({ name: methodSym.qualifiedName, node: n });
        for (const c of n.namedChildren) {
          if (c.startIndex === idStart) continue;
          walk(c, visit);
        }
        if (methodSym) declStack.pop();
        return "skip";
      }
      case "import_declaration": {
        // Children include the dotted name and optionally `*`.
        // Tree-sitter-java exposes the qualified path as a `scoped_identifier`
        // followed (optionally) by an asterisk under the import_declaration.
        const text = n.text.trim();
        const m = /^import\s+(?:static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)\s*;?$/.exec(text);
        if (m) {
          edges.push({
            kind: "imports",
            fromQualifiedName: moduleQname,
            toQualifiedName: m[1],
            line: n.startPosition.row + 1,
          });
        }
        return "skip";
      }
      case "method_invocation": {
        const id = n.childForFieldName("name");
        if (id) {
          edges.push({
            kind: "calls",
            fromQualifiedName: enclosingDefQname(n),
            toQualifiedName: id.text,
            line: n.startPosition.row + 1,
          });
        }
        return;
      }
      case "object_creation_expression": {
        // `new Foo(...)` — emit a `references` edge to the constructor type.
        // tree-sitter-java doesn't reliably expose the constructor type via a
        // field name; fall back to the first named child (which is always the
        // type — `new` is unnamed and `argument_list` is last).
        const t = n.childForFieldName("type") ?? n.namedChildren[0];
        if (t) {
          // The type child is typically a `type_identifier` or
          // `scoped_type_identifier` — extract the right-most segment.
          let target: string | null = null;
          if (t.type === "type_identifier") target = t.text;
          else if (t.type === "generic_type") {
            const inner = t.childForFieldName("type") ?? t.namedChildren[0];
            if (inner) target = inner.text;
          } else if (t.type === "scoped_type_identifier") {
            const last = t.namedChildren[t.namedChildren.length - 1];
            if (last) target = last.text;
          } else {
            target = t.text;
          }
          if (target) {
            edges.push({
              kind: "references",
              fromQualifiedName: enclosingDefQname(n),
              toQualifiedName: target,
              line: n.startPosition.row + 1,
              metadata: { via: "new" },
            });
          }
        }
        return;
      }
      case "annotation":
      case "marker_annotation": {
        // `@Override` / `@SuppressWarnings("x")` — emit a reference to the
        // annotation type.
        const nameNode = n.childForFieldName("name") ?? n.namedChildren[0];
        if (nameNode) {
          // scoped_identifier → take last segment.
          let target: string | null = null;
          if (nameNode.type === "identifier") target = nameNode.text;
          else if (nameNode.type === "scoped_identifier") {
            const last = nameNode.namedChildren[nameNode.namedChildren.length - 1];
            if (last) target = last.text;
          }
          if (target) {
            edges.push({
              kind: "references",
              fromQualifiedName: enclosingDefQname(n),
              toQualifiedName: target,
              line: n.startPosition.row + 1,
              metadata: { via: "decorator" },
            });
          }
        }
        return;
      }
    }
  };
  walk(root, visit);
}

// ---------------------------------------------------------------------------
// C# walker — Issue #900 (Epic #883).
//
// Records classes/structs/records (as `class`), interfaces, enums (as `type`),
// methods + constructors (as `method`), and properties (as `method`, so an EF
// `DbSet<T>` property is captured as a member symbol). Emits `imports` for
// `using` directives, `calls` for invocations, and `references` for
// `new`/attribute usages — mirroring the Java walker's parity. Namespace,
// class, struct, record, and interface bodies contribute to nested qualified
// names via the shared decl stack.
// ---------------------------------------------------------------------------
function walkCSharp(
  root: SyntaxNode,
  source: string,
  moduleQname: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[],
): void {
  type Frame = { name: string; node: SyntaxNode };
  const declStack: Frame[] = [];

  const enclosingDefQname = (_node: SyntaxNode): string =>
    declStack.length ? declStack[declStack.length - 1].name : moduleQname;

  const recordSymbol = (node: SyntaxNode, name: string, kind: SymbolKind): ParsedSymbol => {
    const parentQ = declStack.length ? declStack[declStack.length - 1].name : moduleQname;
    const qname = buildCodeQualifiedName(parentQ, name);
    const sym: ParsedSymbol = {
      kind,
      name,
      qualifiedName: qname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      contentHash: bodyHash(source, node),
    };
    symbols.push(sym);
    emitDefines(edges, parentQ, sym);
    return sym;
  };

  // A container declaration whose body scopes nested symbols' qualified names.
  const container = (n: SyntaxNode, kind: SymbolKind): "skip" => {
    const id = n.childForFieldName("name");
    const idStart = id?.startIndex ?? -1;
    if (id) {
      const sym = recordSymbol(n, id.text, kind);
      declStack.push({ name: sym.qualifiedName, node: n });
      for (const c of n.namedChildren) {
        if (c.startIndex === idStart) continue;
        walk(c, visit);
      }
      declStack.pop();
    } else {
      for (const c of n.namedChildren) walk(c, visit);
    }
    return "skip";
  };

  const memberCallee = (fn: SyntaxNode): string | null => {
    if (fn.type === "identifier") return fn.text;
    if (fn.type === "generic_name") {
      const id = fn.namedChildren.find((c) => c.type === "identifier");
      return id ? id.text : null;
    }
    if (fn.type === "member_access_expression") {
      const nameNode =
        fn.childForFieldName("name") ?? fn.namedChildren[fn.namedChildren.length - 1];
      if (nameNode) return memberCallee(nameNode);
    }
    return null;
  };

  const visit = (n: SyntaxNode): void | "skip" => {
    switch (n.type) {
      // `namespace N { ... }` and `namespace N;` (file-scoped) both scope names
      // but are NOT symbols themselves — descend, tracking the qualifier.
      case "namespace_declaration":
      case "file_scoped_namespace_declaration": {
        for (const c of n.namedChildren) walk(c, visit);
        return "skip";
      }
      case "class_declaration":
      case "struct_declaration":
      case "record_declaration":
      case "record_struct_declaration":
        return container(n, "class");
      case "interface_declaration":
        return container(n, "interface");
      case "enum_declaration": {
        const id = n.childForFieldName("name");
        if (id) recordSymbol(n, id.text, "type");
        return "skip";
      }
      case "method_declaration":
      case "constructor_declaration":
      case "destructor_declaration":
      case "operator_declaration": {
        const id = n.childForFieldName("name");
        const idStart = id?.startIndex ?? -1;
        let methodSym: ParsedSymbol | undefined;
        if (id) methodSym = recordSymbol(n, id.text, "method");
        if (methodSym) declStack.push({ name: methodSym.qualifiedName, node: n });
        for (const c of n.namedChildren) {
          if (c.startIndex === idStart) continue;
          walk(c, visit);
        }
        if (methodSym) declStack.pop();
        return "skip";
      }
      case "property_declaration": {
        // Members like EF's `public DbSet<Customer> Customers { get; set; }`.
        const id = n.childForFieldName("name");
        if (id) recordSymbol(n, id.text, "method");
        // Descend so an initialiser expression's calls/refs are still visited.
        return;
      }
      case "using_directive": {
        // `using System.Data;` / `using static X.Y;`. A resource-`using`
        // statement (`using var x = ...`) is a `using_statement`, not this
        // node, so it is naturally excluded.
        const name = n.childForFieldName("name") ?? n.namedChildren[n.namedChildren.length - 1];
        if (name && (name.type === "qualified_name" || name.type === "identifier")) {
          edges.push({
            kind: "imports",
            fromQualifiedName: moduleQname,
            toQualifiedName: name.text,
            line: n.startPosition.row + 1,
          });
        }
        return "skip";
      }
      case "invocation_expression": {
        const fn = n.childForFieldName("function") ?? n.namedChildren[0];
        if (fn) {
          const callee = memberCallee(fn);
          if (callee) {
            edges.push({
              kind: "calls",
              fromQualifiedName: enclosingDefQname(n),
              toQualifiedName: callee,
              line: n.startPosition.row + 1,
            });
          }
        }
        return; // continue walking arguments for nested calls.
      }
      case "object_creation_expression": {
        // `new Foo(...)` / `new Foo<T>(...)` — emit a `references` edge.
        const t = n.childForFieldName("type") ?? n.namedChildren[0];
        let target: string | null = null;
        if (t) {
          if (t.type === "identifier") target = t.text;
          else if (t.type === "generic_name") {
            const id = t.namedChildren.find((c) => c.type === "identifier");
            if (id) target = id.text;
          } else if (t.type === "qualified_name") {
            const last = t.namedChildren[t.namedChildren.length - 1];
            if (last) target = last.text;
          }
        }
        if (target) {
          edges.push({
            kind: "references",
            fromQualifiedName: enclosingDefQname(n),
            toQualifiedName: target,
            line: n.startPosition.row + 1,
            metadata: { via: "new" },
          });
        }
        return; // continue walking arguments
      }
    }
  };
  walk(root, visit);
}

// ---------------------------------------------------------------------------
// Rationale-hint scanner — comment-text only, no syntax dependency.
// ---------------------------------------------------------------------------
function collectRationaleHints(source: string, language: Language): RationaleHint[] {
  const lines = source.split(/\r?\n/);
  const out: RationaleHint[] = [];
  if (
    language === "ts" ||
    language === "js" ||
    language === "go" ||
    language === "java" ||
    language === "cs"
  ) {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
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
  } else if (language === "py") {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const m = /^\s*#\s*(WHY|NOTE|HACK|TODO):\s*(.*)$/.exec(line);
      if (m) {
        out.push({
          startLine: i + 1,
          endLine: i + 1,
          tag: m[1] as RationaleHint["tag"],
          text: m[2].trim(),
        });
      }
      // Docstring detection: triple-quoted single-line literal at the start of
      // a function/class body. Cheap heuristic — find a deeper-indented
      // triple-quote string after a `def`/`class`.
      const ds = /^\s+("""|''')(.*?)\1\s*$/.exec(line);
      if (ds && i > 0 && /^\s*(def|class)\s+/.test(lines[i - 1])) {
        out.push({
          startLine: i + 1,
          endLine: i + 1,
          tag: "DOCSTRING",
          text: ds[2].trim(),
        });
      }
    }
  }
  // Suppress the unused-source warning — node text already extracted above.
  void source;
  // Ensure EdgeKind reference stays (avoids a phantom unused import warning).
  void (null as unknown as EdgeKind);
  return out;
}
