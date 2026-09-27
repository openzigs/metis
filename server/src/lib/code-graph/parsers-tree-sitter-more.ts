/**
 * Issue #161 — tree-sitter walkers for Scala, Rust, C and C++.
 *
 * Each walker turns a `web-tree-sitter` syntax tree into the code graph's
 * `ParsedSymbol` / `ParsedEdge` shape, exactly as the walkers in
 * `parsers-tree-sitter.ts` do for the other languages (which loads the
 * grammars and dispatches here):
 *
 *   - Scala (`tree-sitter-scala`): `class` / `case class` / `object` (class),
 *     `trait` (interface), `enum` (type); `def` as a function at top level and a
 *     method inside a type; `import` paths (selectors expanded); calls, and
 *     `new X(...)` as a constructor reference.
 *   - Rust (`tree-sitter-rust`): `struct` / `union` (class), `enum` / `type`
 *     (type), `trait` (interface); `fn` as a function, or a method when inside
 *     an `impl` or `trait` block, qualified by the implemented type
 *     (`file::Order::total`) so `Order::total()` resolves; `use` paths (use lists
 *     expanded); calls, and a struct literal `Order { .. }` as a constructor
 *     reference. Inline `mod` blocks are transparent.
 *   - C and C++ (`tree-sitter-c`, `tree-sitter-cpp`; one walker, the C++ grammar
 *     is a superset of C's node types): `struct` / `union` / `class` with a body
 *     (class), `enum` with a body (type); function DEFINITIONS (prototypes are
 *     not symbols, so a call binds to the body, not to a header declaration),
 *     as a method inside a class body or when defined out of line
 *     (`void Order::place()` → `file::Order::place`); `#include` (a quoted
 *     include is recorded relative to the including file, `./x.h`, so the
 *     ingest resolves it to the project file); calls, and `new X` as a
 *     constructor reference. Namespaces, `extern "C"` blocks and templates are
 *     transparent.
 *
 * A `defines` edge whose parent is not a symbol of this file (a Rust `impl` for
 * a type declared elsewhere, a C++ method defined out of line) is re-anchored
 * on the module, because the ingest drops an edge whose source symbol does not
 * exist.
 */
import { createHash } from "node:crypto";
import { COMPLEX_RECEIVER, isGlobalReceiver } from "./call-resolution.js";
import { buildCodeQualifiedName } from "./qualified-name.js";
import type { ParsedEdge, ParsedSymbol, SymbolKind } from "./parsers.js";

/** The subset of a `web-tree-sitter` node the walkers read. */
export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName: (name: string) => SyntaxNode | null;
  childrenForFieldName?: (name: string) => SyntaxNode[];
  parent: SyntaxNode | null;
}

type Visit = (n: SyntaxNode) => void | "skip";

function walk(node: SyntaxNode, visit: Visit): void {
  if (visit(node) === "skip") return;
  for (const c of node.namedChildren) walk(c, visit);
}

/** A declaration scope. `synthetic` scopes (a Rust `impl`) are not symbols. */
interface Frame {
  name: string;
  isType: boolean;
  synthetic?: boolean;
}

/** Shared symbol/edge bookkeeping for one file. */
class Builder {
  readonly stack: Frame[] = [];

  constructor(
    private readonly source: string,
    readonly moduleQname: string,
    private readonly symbols: ParsedSymbol[],
    readonly edges: ParsedEdge[],
  ) {}

  top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Nearest enclosing symbol a call or reference is made from. */
  from(): string {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      if (!this.stack[k].synthetic) return this.stack[k].name;
    }
    return this.moduleQname;
  }

  record(node: SyntaxNode, name: string, kind: SymbolKind, parentQ?: string): ParsedSymbol {
    const parent = parentQ ?? this.top()?.name ?? this.moduleQname;
    const sym: ParsedSymbol = {
      kind,
      name,
      qualifiedName: buildCodeQualifiedName(parent, name),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      contentHash: createHash("sha256")
        .update(this.source.slice(node.startIndex, node.endIndex))
        .digest("hex"),
    };
    this.symbols.push(sym);
    this.edges.push({
      kind: "defines",
      fromQualifiedName: parent,
      toQualifiedName: sym.qualifiedName,
      line: sym.startLine,
    });
    return sym;
  }

  /** Walk `n`'s children inside `frame` (when given), skipping the child at `skipStart`. */
  descend(n: SyntaxNode, frame: Frame | null, visit: Visit, skipStart = -1): "skip" {
    if (frame) this.stack.push(frame);
    for (const c of n.namedChildren) {
      if (c.startIndex === skipStart) continue;
      walk(c, visit);
    }
    if (frame) this.stack.pop();
    return "skip";
  }

  call(name: string, line: number, receiver?: string): void {
    this.edges.push({
      kind: "calls",
      fromQualifiedName: this.from(),
      toQualifiedName: name,
      line,
      ...(receiver !== undefined ? { receiver } : {}),
    });
  }

  construct(typeName: string, line: number): void {
    this.edges.push({
      kind: "references",
      fromQualifiedName: this.from(),
      toQualifiedName: typeName,
      line,
      metadata: { via: "new" },
    });
  }

  imports(target: string, line: number): void {
    this.edges.push({
      kind: "imports",
      fromQualifiedName: this.moduleQname,
      toQualifiedName: target,
      line,
    });
  }

  /** Re-anchor `defines` edges whose parent is not a symbol of this file on the module. */
  finish(): void {
    const known = new Set(this.symbols.map((s) => s.qualifiedName));
    known.add(this.moduleQname);
    for (const e of this.edges) {
      if (e.kind === "defines" && !known.has(e.fromQualifiedName)) {
        e.fromQualifiedName = this.moduleQname;
      }
    }
  }
}

/**
 * The receiver recorded for a path call `a::b::name()`: the path's root when
 * that root is a standard-library namespace (`std::mem::swap` → `std`, so the
 * call is never bound to a project `swap`), otherwise its last segment.
 */
function pathReceiver(path: string, language: "rs" | "cpp"): string {
  const root = path.split("::", 1)[0].trim();
  return isGlobalReceiver(root, language) ? root : lastSegment(path);
}

/** Last `.`/`::`-separated segment of a type or path, generics stripped. */
function lastSegment(text: string): string {
  const noGenerics = text.split(/[<[(]/, 1)[0];
  const parts = noGenerics.split(/::|\./);
  return (parts[parts.length - 1] ?? "").trim();
}

// ---------------------------------------------------------------------------
// Scala
// ---------------------------------------------------------------------------

/** `import a.b.{C, D => E}` / `import a.b._` / `import a.b.*` → one path per selector. */
function scalaImportPaths(n: SyntaxNode): string[] {
  const prefix: string[] = [];
  const out: string[] = [];
  for (const c of n.namedChildren) {
    if (c.type === "identifier") prefix.push(c.text);
    else if (c.type === "namespace_wildcard") out.push([...prefix, c.text].join("."));
    else if (c.type === "namespace_selectors") {
      for (const s of c.namedChildren) {
        if (s.type === "identifier") out.push([...prefix, s.text].join("."));
        else if (s.type === "namespace_wildcard") out.push([...prefix, s.text].join("."));
        else {
          // `D => E` / `D as E`: the imported name is the first identifier.
          const name = s.childForFieldName("name") ?? s.namedChildren[0];
          if (name) out.push([...prefix, name.text].join("."));
        }
      }
    } else if (c.type !== "comment") {
      prefix.push(c.text);
    }
  }
  if (out.length === 0 && prefix.length > 0) out.push(prefix.join("."));
  return out;
}

export function walkScala(
  root: SyntaxNode,
  source: string,
  moduleQname: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[],
): void {
  const b = new Builder(source, moduleQname, symbols, edges);
  const visit: Visit = (n) => {
    switch (n.type) {
      case "class_definition":
      case "object_definition":
      case "trait_definition":
      case "enum_definition": {
        const id = n.childForFieldName("name");
        if (!id) return;
        const kind: SymbolKind =
          n.type === "trait_definition"
            ? "interface"
            : n.type === "enum_definition"
              ? "type"
              : "class";
        const sym = b.record(n, id.text, kind);
        return b.descend(n, { name: sym.qualifiedName, isType: true }, visit, id.startIndex);
      }
      case "function_definition":
      case "function_declaration": {
        const id = n.childForFieldName("name");
        if (!id) return;
        const sym = b.record(n, id.text, b.top()?.isType ? "method" : "function");
        return b.descend(n, { name: sym.qualifiedName, isType: false }, visit, id.startIndex);
      }
      case "import_declaration": {
        for (const p of scalaImportPaths(n)) b.imports(p, n.startPosition.row + 1);
        return "skip";
      }
      case "call_expression": {
        let fn = n.childForFieldName("function");
        if (fn?.type === "generic_function") fn = fn.childForFieldName("function");
        if (!fn) return;
        const line = n.startPosition.row + 1;
        if (fn.type === "identifier") b.call(fn.text, line);
        else if (fn.type === "field_expression") {
          const field = fn.childForFieldName("field");
          const value = fn.childForFieldName("value");
          if (field) {
            b.call(field.text, line, value?.type === "identifier" ? value.text : COMPLEX_RECEIVER);
          }
        }
        return;
      }
      case "instance_expression": {
        // `new Invoice(id)` — the constructed type is the first named child.
        const t = n.namedChildren.find((c) => c.type !== "arguments" && c.type !== "template_body");
        const name = t ? lastSegment(t.text) : "";
        if (name) b.construct(name, n.startPosition.row + 1);
        return;
      }
    }
    return undefined;
  };
  walk(root, visit);
  b.finish();
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

/** Most nested `use` lists expanded (`use a::{b::{c, d}}`); deeper ones stay whole. */
const MAX_USE_DEPTH = 8;

/** `use a::b::{C, D as E}` → `a::b::C`, `a::b::D`. */
function rustUsePaths(n: SyntaxNode, prefix: string, out: string[], depth: number): void {
  const join = (tail: string): string => (prefix ? `${prefix}::${tail}` : tail);
  switch (n.type) {
    case "scoped_use_list": {
      const path = n.childForFieldName("path");
      const list = n.childForFieldName("list");
      const next = path ? join(path.text) : prefix;
      if (list && depth < MAX_USE_DEPTH) rustUsePaths(list, next, out, depth + 1);
      else out.push(join(n.text));
      return;
    }
    case "use_list": {
      for (const c of n.namedChildren) rustUsePaths(c, prefix, out, depth + 1);
      return;
    }
    case "use_as_clause": {
      const path = n.childForFieldName("path");
      if (path) out.push(join(path.text));
      return;
    }
    case "use_wildcard":
    default:
      out.push(join(n.text));
  }
}

/** The implemented type's simple name: `impl<T> Repo for Store<T>` → `Store`. */
function rustImplTypeName(n: SyntaxNode): string {
  const t = n.childForFieldName("type");
  return t ? lastSegment(t.text) : "";
}

export function walkRust(
  root: SyntaxNode,
  source: string,
  moduleQname: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[],
): void {
  const b = new Builder(source, moduleQname, symbols, edges);
  const visit: Visit = (n) => {
    switch (n.type) {
      case "struct_item":
      case "union_item":
      case "enum_item":
      case "type_item": {
        const id = n.childForFieldName("name");
        if (!id) return;
        b.record(
          n,
          id.text,
          n.type === "struct_item" || n.type === "union_item" ? "class" : "type",
        );
        return "skip";
      }
      case "trait_item": {
        const id = n.childForFieldName("name");
        if (!id) return;
        const sym = b.record(n, id.text, "interface");
        return b.descend(n, { name: sym.qualifiedName, isType: true }, visit, id.startIndex);
      }
      case "impl_item": {
        const typeName = rustImplTypeName(n);
        if (!typeName) return;
        const body = n.childForFieldName("body");
        if (!body) return "skip";
        b.stack.push({
          name: buildCodeQualifiedName(moduleQname, typeName),
          isType: true,
          synthetic: true,
        });
        walk(body, visit);
        b.stack.pop();
        return "skip";
      }
      case "function_item":
      case "function_signature_item": {
        const id = n.childForFieldName("name");
        if (!id) return;
        const sym = b.record(n, id.text, b.top()?.isType ? "method" : "function");
        return b.descend(n, { name: sym.qualifiedName, isType: false }, visit, id.startIndex);
      }
      case "use_declaration": {
        const arg = n.childForFieldName("argument");
        if (!arg) return "skip";
        const paths: string[] = [];
        rustUsePaths(arg, "", paths, 0);
        for (const p of paths) b.imports(p, n.startPosition.row + 1);
        return "skip";
      }
      case "call_expression": {
        let fn = n.childForFieldName("function");
        if (fn?.type === "generic_function") fn = fn.childForFieldName("function");
        if (!fn) return;
        const line = n.startPosition.row + 1;
        if (fn.type === "identifier") b.call(fn.text, line);
        else if (fn.type === "field_expression") {
          const field = fn.childForFieldName("field");
          const value = fn.childForFieldName("value");
          if (field) {
            const receiver =
              value?.type === "self" || value?.type === "identifier"
                ? value.text
                : COMPLEX_RECEIVER;
            b.call(field.text, line, receiver);
          }
        } else if (fn.type === "scoped_identifier") {
          // `Invoice::create(1)` / `billing::charge()` / `crate::a::B::new()`.
          const name = fn.childForFieldName("name");
          const path = fn.childForFieldName("path");
          if (name) {
            const scope = path ? pathReceiver(path.text, "rs") : "";
            b.call(name.text, line, /^\w+$/.test(scope) ? scope : COMPLEX_RECEIVER);
          }
        }
        return;
      }
      case "struct_expression": {
        const name = n.childForFieldName("name");
        const typeName = name ? lastSegment(name.text) : "";
        if (typeName && typeName !== "Self") b.construct(typeName, n.startPosition.row + 1);
        return;
      }
    }
    return undefined;
  };
  walk(root, visit);
  b.finish();
}

// ---------------------------------------------------------------------------
// C / C++
// ---------------------------------------------------------------------------

/** Most declarator wrappers (`*`, `&`, parentheses) unwrapped to reach the function declarator. */
const MAX_DECLARATOR_DEPTH = 16;

/** The function declarator inside a definition's (possibly pointer/reference-wrapped) declarator. */
function functionDeclarator(n: SyntaxNode): SyntaxNode | null {
  let d = n.childForFieldName("declarator");
  for (let k = 0; d && k < MAX_DECLARATOR_DEPTH; k++) {
    if (d.type === "function_declarator") return d;
    d = d.childForFieldName("declarator") ?? d.namedChildren[0] ?? null;
  }
  return null;
}

/** `{ scope, name }` of a function's declared name; `scope` is set for `A::B::f`. */
function cFunctionName(decl: SyntaxNode): { scope: string; name: string } | null {
  let id = decl.childForFieldName("declarator");
  let scope = "";
  for (let k = 0; id && k < MAX_DECLARATOR_DEPTH; k++) {
    if (id.type === "qualified_identifier") {
      const s = id.childForFieldName("scope");
      if (s) scope = lastSegment(s.text);
      id = id.childForFieldName("name");
      continue;
    }
    if (id.type === "template_function") {
      id = id.childForFieldName("name");
      continue;
    }
    if (
      id.type === "identifier" ||
      id.type === "field_identifier" ||
      id.type === "destructor_name" ||
      id.type === "operator_name"
    ) {
      return { scope, name: id.text };
    }
    return null;
  }
  return null;
}

export function walkCFamily(
  root: SyntaxNode,
  source: string,
  moduleQname: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[],
): void {
  const b = new Builder(source, moduleQname, symbols, edges);
  const visit: Visit = (n) => {
    switch (n.type) {
      case "class_specifier":
      case "struct_specifier":
      case "union_specifier":
      case "enum_specifier": {
        const body = n.childForFieldName("body");
        if (!body) return "skip"; // a use of the type (`struct order *o`), not its declaration
        let name = n.childForFieldName("name")?.text ?? "";
        if (!name && n.parent?.type === "type_definition") {
          // `typedef struct { ... } point_t;`
          name = n.parent.childForFieldName("declarator")?.text ?? "";
        }
        if (!name) return b.descend(n, null, visit);
        const sym = b.record(n, lastSegment(name), n.type === "enum_specifier" ? "type" : "class");
        return b.descend(n, { name: sym.qualifiedName, isType: true }, visit);
      }
      case "function_definition": {
        const decl = functionDeclarator(n);
        const fn = decl ? cFunctionName(decl) : null;
        if (!fn) return;
        const sym = fn.scope
          ? b.record(n, fn.name, "method", buildCodeQualifiedName(moduleQname, fn.scope))
          : b.record(n, fn.name, b.top()?.isType ? "method" : "function");
        const body = n.childForFieldName("body");
        b.stack.push({ name: sym.qualifiedName, isType: false });
        if (body) walk(body, visit);
        b.stack.pop();
        return "skip";
      }
      case "preproc_include": {
        const path = n.childForFieldName("path");
        if (!path) return "skip";
        const line = n.startPosition.row + 1;
        if (path.type === "system_lib_string") b.imports(path.text.replace(/^<|>$/g, ""), line);
        else {
          const target = path.text.replace(/^"|"$/g, "");
          // A quoted include is searched relative to the including file first.
          b.imports(
            target.startsWith(".") || target.startsWith("/") ? target : `./${target}`,
            line,
          );
        }
        return "skip";
      }
      case "call_expression": {
        let fn = n.childForFieldName("function");
        if (fn?.type === "template_function") fn = fn.childForFieldName("name");
        if (!fn) return;
        const line = n.startPosition.row + 1;
        if (fn.type === "identifier") b.call(fn.text, line);
        else if (fn.type === "field_expression") {
          const field = fn.childForFieldName("field");
          const arg = fn.childForFieldName("argument");
          if (field) {
            const receiver =
              arg?.type === "identifier" || arg?.type === "this" ? arg.text : COMPLEX_RECEIVER;
            b.call(lastSegment(field.text), line, receiver);
          }
        } else if (fn.type === "qualified_identifier") {
          // `Invoice::create(1)` / `std::sort(...)`. A longer path
          // (`billing::Invoice::create`, `std::ranges::sort`) nests one
          // qualified_identifier per `::`, so descend to the leaf name.
          const scope = fn.childForFieldName("scope");
          let name = fn.childForFieldName("name");
          while (name?.type === "qualified_identifier") name = name.childForFieldName("name");
          if (name?.type === "template_function") name = name.childForFieldName("name");
          if (name && name.type === "identifier") {
            const path = fn.text.slice(0, fn.text.lastIndexOf("::"));
            b.call(name.text, line, scope ? pathReceiver(path, "cpp") : COMPLEX_RECEIVER);
          }
        }
        return;
      }
      case "new_expression": {
        const t = n.childForFieldName("type");
        const name = t ? lastSegment(t.text) : "";
        if (name) b.construct(name, n.startPosition.row + 1);
        return;
      }
    }
    return undefined;
  };
  walk(root, visit);
  b.finish();
}
