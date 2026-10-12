/**
 * #1071 — bind a Go call to the function or method it statically reaches, at
 * ingest, from the types the source itself declares.
 *
 * The Go walker (`parsers-tree-sitter-go.ts`) records, per file, what a reader
 * can tell without a type checker: the package clause, the imports and their
 * aliases, each struct's fields, each function's result types, the package-level
 * variables — and, on every call edge, the callee as a small symbolic expression
 * ({@link GoExpr}) in which the function's own locals (`x := NewFoo()`,
 * parameters, the receiver) are already substituted. This module evaluates that
 * expression against the facts of EVERY Go file in the tree, which is the part
 * a single-file parser cannot do: `h.store.SetEntriesStatus()` needs the field
 * `store` (declared in another file of the package) and the methods of
 * `storage.Storage` (declared in another package).
 *
 * The rule is **bind only what the declarations decide**. A call ends in exactly
 * one {@link GoCallVerdict}:
 *
 *  - `bound` — one function or method is the static callee.
 *  - `unbound` — the declarations decide there is NO project function to bind:
 *    the callee is outside the project (`external`: the standard library, a
 *    third-party module, a builtin), it is dispatched at run time (`interface`,
 *    `func-value`), it is a type conversion (`conversion`), or two declarations
 *    claim it (`ambiguous`: build-tagged twins). Nothing is guessed, and a later
 *    name-based resolver must not guess on `external`, `func-value`, `conversion`
 *    or `ambiguous` either — see `impact-analysis/go-call-resolution.ts`.
 *  - `unknown` — the receiver's type could not be inferred (the result of a
 *    third-party generic function, a struct literal type, a file tree-sitter
 *    could not fully parse). The caller falls back to the name-evidence rules in
 *    `call-resolution.ts`, exactly as before this module existed.
 *
 * Deliberately NOT inferred: which concrete type sits behind an interface value,
 * type parameters, method expressions (`T.Method`), and anything whose type is
 * written only in a package outside the tree. Embedded-struct promotion IS
 * resolved, by Go's own shallowest-depth rule, and stops at the first depth that
 * holds an embedded type this module cannot see into.
 *
 * Pure and bounded: no I/O, every recursion is depth-capped, and work per call
 * is proportional to the length of its receiver chain.
 */

/** A Go type as written in source, reduced to what member lookup needs. Pointers are dropped. */
export type GoType =
  | {
      k: "named";
      /** The package qualifier as written (`st` in `st.Storage`); absent for a same-package name. */
      pkg?: string;
      name: string;
      /** Written with type arguments (`Pointer[User]`): its members may mention them. */
      generic?: true;
    }
  /** `[]T`, `[N]T`, `...T`. */
  | { k: "list"; elem: GoType | null }
  | { k: "map"; key: GoType | null; elem: GoType | null }
  | { k: "chan"; elem: GoType | null }
  | { k: "func"; results: Array<GoType | null> };

/**
 * A value expression, symbolic. Function-local names never appear: the walker
 * replaces each with the expression (or declared type) it was bound to.
 */
export type GoExpr =
  /** A value whose type is written in the source: a parameter, `var x T`, `T{}`, `new(T)`, `x.(T)`. */
  | { e: "typed"; type: GoType }
  /** A package-scope identifier or an import alias — decided against the whole tree. */
  | { e: "name"; name: string }
  /** `x.name`: a field, a method, or a member of package `x`. */
  | { e: "sel"; x: GoExpr; name: string }
  /** Result `i` of calling `fn`. */
  | { e: "call"; fn: GoExpr; i: number }
  /** `x[i]`, the value of `range x`, `<-x`. */
  | { e: "elem"; x: GoExpr }
  /** The key of `range x`. */
  | { e: "key"; x: GoExpr }
  /** A function-local name used as a callee: a func value, never a declared function. */
  | { e: "local" }
  /** A type declared inside the function: as a callee, a conversion. */
  | { e: "local-type" }
  | { e: "unknown" };

export const GO_UNKNOWN: GoExpr = { e: "unknown" };
export const GO_LOCAL_TYPE: GoExpr = { e: "local-type" };

export interface GoImportFact {
  path: string;
  /** Explicit alias; absent when the package's own name applies. `.` and `_` are kept as written. */
  alias?: string;
}

export interface GoFieldFact {
  /** Field name; for an embedded field, the type's own name (Go's rule). */
  name: string;
  type: GoType | null;
  embedded?: true;
}

export interface GoTypeFact {
  name: string;
  /** `struct` carries {@link fields}; `interface` dispatches at run time; `alias` and `defined` carry {@link target}. */
  form: "struct" | "interface" | "alias" | "defined";
  fields?: GoFieldFact[];
  /** `type A = B` (alias) or `type A B` (defined): the right-hand side. */
  target?: GoType | null;
  /** Method names of an interface, so a call through one is told from a missing method. */
  methods?: string[];
}

export interface GoFuncFact {
  name: string;
  /** Receiver base type name for a method. */
  receiver?: string;
  /** The symbol this declaration was recorded as. */
  qualifiedName: string;
  results: Array<GoType | null>;
}

export interface GoVarFact {
  name: string;
  type?: GoType | null;
  value?: GoExpr;
}

/** What one Go file declares. Never persisted: rebuilt from source on every ingest that resolves Go calls. */
export interface GoFileFacts {
  /** The package clause. */
  package: string;
  imports: GoImportFact[];
  types: GoTypeFact[];
  funcs: GoFuncFact[];
  vars: GoVarFact[];
}

/** A `go.mod`: the directory it sits in (`""` at the root) and its `module` path. */
export interface GoModule {
  dir: string;
  path: string;
}

export type GoBinding = "package" | "same-package" | "receiver-type";
export type GoUnboundReason = "external" | "interface" | "func-value" | "conversion" | "ambiguous";

export type GoCallVerdict =
  | { kind: "bound"; qualifiedName: string; via: GoBinding }
  | { kind: "unbound"; reason: GoUnboundReason }
  | { kind: "unknown" };

/**
 * `CodeEdge.metadata` key recording how ingest decided a Go `calls` edge. On a
 * bound edge: a {@link GoBinding}, or {@link GO_RESOLUTION_NAME}. On an unbound
 * one: the {@link GoUnboundReason} for which the declarations rule a project
 * callee out. Absent when nothing was decided (the receiver's type could not be
 * inferred and no name evidence bound it) and on every graph ingested before
 * #1071.
 */
export const GO_RESOLUTION_KEY = "goResolution";

/** Bound by the name-evidence rules of `call-resolution.ts`, not by type. */
export const GO_RESOLUTION_NAME = "name";

export type GoResolution = GoBinding | GoUnboundReason | typeof GO_RESOLUTION_NAME;

/** The exact `CodeEdge.metadata` string for a resolution — one key, so it can be matched as a string. */
export function goResolutionMetadata(resolution: GoResolution): string {
  return JSON.stringify({ [GO_RESOLUTION_KEY]: resolution });
}

/**
 * The verdicts by which ingest DECIDED an unresolved call has no project
 * callee. `interface` is not one: which implementation runs is open, so a
 * consumer that prefers a probable callee to none may still look for it by name.
 */
const GO_DECIDED_UNBOUND: readonly GoUnboundReason[] = [
  "external",
  "func-value",
  "conversion",
  "ambiguous",
];

/** The `metadata` strings of {@link GO_DECIDED_UNBOUND}, for a `notIn` filter. */
export const GO_DECIDED_UNBOUND_METADATA: readonly string[] =
  GO_DECIDED_UNBOUND.map(goResolutionMetadata);

/**
 * True when an unresolved `calls` edge is still open to a name-based reading:
 * ingest recorded no verdict for it, or one that defers to run time. Every
 * after-the-fact reader of unresolved calls must apply this (or
 * {@link goUndecidedCallWhere}), so that none of them contradicts ingest.
 */
export function isGoFallbackCandidate(metadata: string | null | undefined): boolean {
  return !metadata || !GO_DECIDED_UNBOUND_METADATA.includes(metadata);
}

/**
 * The Prisma `where` fragment for {@link isGoFallbackCandidate}. Spelled with an
 * explicit `null` arm: in SQL `metadata NOT IN (…)` is not true for a NULL.
 */
export function goUndecidedCallWhere(): {
  OR: [{ metadata: null }, { metadata: { notIn: string[] } }];
} {
  return { OR: [{ metadata: null }, { metadata: { notIn: [...GO_DECIDED_UNBOUND_METADATA] } }] };
}

export interface GoResolverFile {
  filePath: string;
  facts: GoFileFacts;
  isTest: boolean;
}

export interface GoResolver {
  /** Decide the callee of one call made in `filePath`. */
  resolveCall(filePath: string, callee: GoExpr): GoCallVerdict;
}

/** Longest chain of aliases, defined types or embeddings followed. */
const MAX_DEPTH = 12;

/**
 * Longest callee expression evaluated — a fluent chain is two links per call.
 * The walker caps what it emits at the same length (`MAX_EXPR_DEPTH`).
 */
const MAX_EVAL_DEPTH = 64;

/**
 * Predeclared identifiers. A bare call to one that the package does not itself
 * declare is a builtin or a conversion to a basic type — never a project symbol.
 */
const GO_UNIVERSE: ReadonlySet<string> = new Set([
  "append",
  "cap",
  "clear",
  "close",
  "complex",
  "copy",
  "delete",
  "imag",
  "len",
  "make",
  "max",
  "min",
  "new",
  "panic",
  "print",
  "println",
  "real",
  "recover",
  "any",
  "bool",
  "byte",
  "comparable",
  "complex64",
  "complex128",
  "error",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "rune",
  "string",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
  "true",
  "false",
  "nil",
  "iota",
]);

/** Predeclared types that are interfaces: a method on one is dispatched at run time. */
const GO_UNIVERSE_INTERFACES: ReadonlySet<string> = new Set(["error", "any", "comparable"]);

/** The directory of a repo-relative path (`""` at the root). */
export function goDir(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? "" : filePath.slice(0, i);
}

/** Read the `module` path out of a `go.mod`. Linear: one pass over the lines. */
export function parseGoModulePath(source: string): string | null {
  for (const raw of source.split("\n", 2000)) {
    const line = raw.trim();
    if (!line.startsWith("module")) continue;
    const rest = line.slice("module".length);
    if (rest.length === 0 || (rest[0] !== " " && rest[0] !== "\t")) continue;
    let value = rest.trim();
    const comment = value.indexOf("//");
    if (comment !== -1) value = value.slice(0, comment).trim();
    if (value.startsWith('"') || value.startsWith("`")) value = value.slice(1, -1);
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * The name an import binds when it carries no alias, guessed from its path for a
 * package outside the tree: the last segment, past a major-version directory
 * (`chi/v5` → `chi`) and a `gopkg.in` version suffix (`yaml.v3` → `yaml`).
 */
export function goDefaultImportName(importPath: string): string {
  const segs = importPath.split("/");
  let last = segs[segs.length - 1] ?? "";
  if (segs.length > 1 && isMajorVersion(last)) last = segs[segs.length - 2] ?? last;
  const dot = last.indexOf(".v");
  if (dot > 0 && isMajorVersion(last.slice(dot + 1))) last = last.slice(0, dot);
  return last;
}

function isMajorVersion(seg: string): boolean {
  if (seg.length < 2 || seg[0] !== "v") return false;
  for (let i = 1; i < seg.length; i += 1) {
    const c = seg.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

interface FileCtx {
  filePath: string;
  dir: string;
  pkg: Pkg;
  isTest: boolean;
  facts: GoFileFacts;
  /** Lazily built: local import name → target. */
  imports?: Map<string, ImportTarget>;
}

/** A package: one directory and one package-clause name (`foo` and `foo_test` are two). */
interface Pkg {
  dir: string;
  name: string;
  types: Map<string, Decl<GoTypeFact>[]>;
  funcs: Map<string, Decl<GoFuncFact>[]>;
  /** Keyed `Type.method`. */
  methods: Map<string, Decl<GoFuncFact>[]>;
  vars: Map<string, Decl<GoVarFact>[]>;
}

interface Decl<T> {
  fact: T;
  file: FileCtx;
}

type ImportTarget = { external: true } | { external: false; pkg: Pkg };

/** What an expression evaluates to. */
type Val =
  /** A value of a type written in `file`'s scope. */
  | { v: "value"; type: GoType; file: FileCtx }
  | { v: "package"; target: ImportTarget }
  | { v: "func"; decl: Decl<GoFuncFact>; via: GoBinding }
  /** A type name used as an expression: the callee of a conversion. */
  | { v: "type"; type: GoType; file: FileCtx }
  /** A value of a type declared outside the tree: everything selected from it is external too. */
  | { v: "external" }
  /** A function declared outside the tree: an external callee whose result type is not known. */
  | { v: "external-func" }
  | { v: "interface-method" }
  | { v: "ambiguous" }
  | { v: "unknown" };

const UNKNOWN: Val = { v: "unknown" };
const EXTERNAL: Val = { v: "external" };

/** A named type resolved against the tree. */
type Named =
  | { n: "project"; pkg: Pkg; name: string; viewer: FileCtx }
  | { n: "external" }
  | { n: "interface" }
  | { n: "unknown" };

/**
 * Build a resolver over every Go file of the tree.
 *
 * @param modules the tree's `go.mod` files. With none, an import path is matched
 *   to the longest directory it ends in — the only evidence a tree without a
 *   module file offers.
 */
export function createGoResolver(
  files: readonly GoResolverFile[],
  modules: readonly GoModule[],
): GoResolver {
  const pkgs = new Map<string, Pkg>();
  /** Directory → its packages (normally one, plus an external `_test` one). */
  const pkgsByDir = new Map<string, Pkg[]>();
  const ctxByFile = new Map<string, FileCtx>();

  const add = <T>(map: Map<string, Decl<T>[]>, key: string, decl: Decl<T>): void => {
    const list = map.get(key);
    if (list) list.push(decl);
    else map.set(key, [decl]);
  };

  for (const f of files) {
    const dir = goDir(f.filePath);
    const key = `${dir}\u0000${f.facts.package}`;
    let pkg = pkgs.get(key);
    if (!pkg) {
      pkg = {
        dir,
        name: f.facts.package,
        types: new Map(),
        funcs: new Map(),
        methods: new Map(),
        vars: new Map(),
      };
      pkgs.set(key, pkg);
      const list = pkgsByDir.get(dir);
      if (list) list.push(pkg);
      else pkgsByDir.set(dir, [pkg]);
    }
    const ctx: FileCtx = { filePath: f.filePath, dir, pkg, isTest: f.isTest, facts: f.facts };
    ctxByFile.set(f.filePath, ctx);
    for (const t of f.facts.types) add(pkg.types, t.name, { fact: t, file: ctx });
    for (const fn of f.facts.funcs) {
      if (fn.receiver) add(pkg.methods, `${fn.receiver}.${fn.name}`, { fact: fn, file: ctx });
      else add(pkg.funcs, fn.name, { fact: fn, file: ctx });
    }
    for (const v of f.facts.vars) add(pkg.vars, v.name, { fact: v, file: ctx });
  }

  const sortedModules = [...modules].sort((a, b) => b.path.length - a.path.length);

  /** The directory an import path names inside the tree, or null for a package outside it. */
  const importDir = (importPath: string): string | null => {
    if (sortedModules.length > 0) {
      for (const m of sortedModules) {
        if (importPath === m.path) return pkgsByDir.has(m.dir) ? m.dir : null;
        if (importPath.startsWith(`${m.path}/`)) {
          const rel = importPath.slice(m.path.length + 1);
          const dir = m.dir ? `${m.dir}/${rel}` : rel;
          return pkgsByDir.has(dir) ? dir : null;
        }
      }
      return null;
    }
    let best: string | null = null;
    for (const dir of pkgsByDir.keys()) {
      if (dir.length === 0) continue;
      if (importPath !== dir && !importPath.endsWith(`/${dir}`)) continue;
      if (best === null || dir.length > best.length) best = dir;
    }
    return best;
  };

  /** The package an importer sees in `dir`: the one that is not an external test package. */
  const importablePkg = (dir: string): Pkg | null => {
    const list = (pkgsByDir.get(dir) ?? []).filter((p) => !p.name.endsWith("_test"));
    return list.length === 1 ? list[0] : null;
  };

  const importsOf = (ctx: FileCtx): Map<string, ImportTarget> => {
    if (ctx.imports) return ctx.imports;
    const out = new Map<string, ImportTarget>();
    for (const imp of ctx.facts.imports) {
      if (imp.alias === "_" || imp.alias === ".") continue;
      const dir = importDir(imp.path);
      const pkg = dir === null ? null : importablePkg(dir);
      const target: ImportTarget = pkg ? { external: false, pkg } : { external: true };
      const name = imp.alias ?? (pkg ? pkg.name : goDefaultImportName(imp.path));
      if (name && !out.has(name)) out.set(name, target);
    }
    ctx.imports = out;
    return out;
  };

  /** Declarations of `key` a viewer may reach: a non-test file never sees a `_test.go` one. */
  const visible = <T>(
    map: Map<string, Decl<T>[]>,
    key: string,
    viewer: FileCtx,
  ): Decl<T>[] | undefined => {
    const all = map.get(key);
    if (!all) return undefined;
    if (viewer.isTest) return all;
    const out = all.filter((d) => !d.file.isTest);
    return out.length > 0 ? out : undefined;
  };

  /** Resolve a written type to the declaration it names. */
  const resolveNamed = (type: GoType, file: FileCtx, depth: number): Named => {
    if (type.k !== "named" || depth > MAX_DEPTH) return { n: "unknown" };
    let pkg = file.pkg;
    if (type.pkg !== undefined) {
      const target = importsOf(file).get(type.pkg);
      if (!target) return { n: "unknown" };
      // A generic type from outside the tree can hand back project types
      // (`atomic.Pointer[User]`), so its members are not known to be external.
      if (target.external) return type.generic ? { n: "unknown" } : { n: "external" };
      pkg = target.pkg;
    }
    const decls = visible(pkg.types, type.name, file);
    if (!decls) {
      if (type.pkg !== undefined) return { n: "unknown" };
      if (GO_UNIVERSE_INTERFACES.has(type.name)) return { n: "interface" };
      return GO_UNIVERSE.has(type.name) ? { n: "external" } : { n: "unknown" };
    }
    if (decls.length > 1) return { n: "unknown" };
    const decl = decls[0];
    if (decl.fact.form === "alias") {
      return decl.fact.target
        ? resolveNamed(decl.fact.target, decl.file, depth + 1)
        : { n: "unknown" };
    }
    return { n: "project", pkg, name: type.name, viewer: file };
  };

  const typeDecl = (named: Extract<Named, { n: "project" }>): Decl<GoTypeFact> | null => {
    const decls = visible(named.pkg.types, named.name, named.viewer);
    return decls && decls.length === 1 ? decls[0] : null;
  };

  /** The struct fields a type has, following `type A B` to B's struct. */
  const structOf = (
    named: Extract<Named, { n: "project" }>,
    depth: number,
  ): { fields: GoFieldFact[]; file: FileCtx } | "external" | null => {
    const decl = typeDecl(named);
    if (!decl || depth > MAX_DEPTH) return null;
    if (decl.fact.form === "struct") return { fields: decl.fact.fields ?? [], file: decl.file };
    if (decl.fact.form !== "defined" || !decl.fact.target) return null;
    const under = resolveNamed(decl.fact.target, decl.file, depth + 1);
    if (under.n === "external") return "external";
    return under.n === "project" ? structOf(under, depth + 1) : null;
  };

  /** A composite type behind a value: the type itself, or what a defined type is defined as. */
  const underlying = (
    type: GoType,
    file: FileCtx,
    depth: number,
  ): { type: GoType; file: FileCtx } | "external" | null => {
    if (type.k !== "named") return { type, file };
    if (depth > MAX_DEPTH) return null;
    const named = resolveNamed(type, file, depth);
    if (named.n === "external") return "external";
    if (named.n !== "project") return null;
    const decl = typeDecl(named);
    if (!decl || decl.fact.form !== "defined" || !decl.fact.target) return null;
    return underlying(decl.fact.target, decl.file, depth + 1);
  };

  /** Own member of a project type: a field, then a method. */
  const ownMember = (named: Extract<Named, { n: "project" }>, name: string): Val | null => {
    const struct = structOf(named, 0);
    if (struct && struct !== "external") {
      const field = struct.fields.find((f) => f.name === name);
      if (field) {
        return field.type ? { v: "value", type: field.type, file: struct.file } : UNKNOWN;
      }
    }
    const methods = visible(named.pkg.methods, `${named.name}.${name}`, named.viewer);
    if (methods) {
      return methods.length === 1
        ? { v: "func", decl: methods[0], via: "receiver-type" }
        : { v: "ambiguous" };
    }
    const decl = typeDecl(named);
    if (decl?.fact.form === "interface") {
      // An interface's own methods and those of the interfaces it embeds are
      // all dispatched at run time; which one is not worth telling apart.
      return { v: "interface-method" };
    }
    // A defined type over a type outside the tree keeps that type's fields.
    if (struct === "external") return EXTERNAL;
    return null;
  };

  /**
   * `x.name` on a value of a project type: its own member, else the member
   * promoted from the shallowest embedded type that has it.
   */
  const member = (start: Extract<Named, { n: "project" }>, name: string): Val => {
    let level: Array<Extract<Named, { n: "project" }>> = [start];
    const seen = new Set<string>();
    for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth += 1) {
      const hits: Val[] = [];
      for (const named of level) {
        const hit = ownMember(named, name);
        if (hit) hits.push(hit);
      }
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return { v: "ambiguous" };
      const next: Array<Extract<Named, { n: "project" }>> = [];
      for (const named of level) {
        const struct = structOf(named, 0);
        if (!struct || struct === "external") continue;
        for (const field of struct.fields) {
          if (!field.embedded) continue;
          // An embedded type this module cannot see into may declare `name` at
          // this depth, which would win over anything deeper.
          if (!field.type) return UNKNOWN;
          const embedded = resolveNamed(field.type, struct.file, 0);
          if (embedded.n !== "project") return UNKNOWN;
          const key = `${embedded.pkg.dir}\u0000${embedded.pkg.name}\u0000${embedded.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(embedded);
        }
      }
      level = next;
    }
    return UNKNOWN;
  };

  const packageMember = (target: ImportTarget, name: string, viewer: FileCtx): Val => {
    if (target.external) return { v: "external-func" };
    return scopeMember(target.pkg, name, viewer, "package") ?? EXTERNAL;
  };

  /** A package-scope name: a function, a variable or constant, or a type. */
  const scopeMember = (pkg: Pkg, name: string, viewer: FileCtx, via: GoBinding): Val | null => {
    const funcs = visible(pkg.funcs, name, viewer);
    if (funcs) {
      if (funcs.length === 1) return { v: "func", decl: funcs[0], via };
      // Twins behind build tags: prefer the caller's own file, else refuse.
      const own = funcs.filter((d) => d.file === viewer);
      return own.length === 1 ? { v: "func", decl: own[0], via } : { v: "ambiguous" };
    }
    const vars = visible(pkg.vars, name, viewer);
    if (vars) {
      if (vars.length !== 1) return UNKNOWN;
      const { fact, file } = vars[0];
      if (fact.type) return { v: "value", type: fact.type, file };
      return fact.value ? evaluate(fact.value, file, 1) : UNKNOWN;
    }
    if (visible(pkg.types, name, viewer)) {
      const file = viewer.pkg === pkg ? viewer : (pkg.types.get(name)?.[0]?.file ?? viewer);
      return { v: "type", type: { k: "named", name }, file };
    }
    return null;
  };

  const select = (x: Val, name: string, file: FileCtx): Val => {
    switch (x.v) {
      case "package":
        return packageMember(x.target, name, file);
      case "value": {
        if (x.type.k !== "named") return UNKNOWN;
        const named = resolveNamed(x.type, x.file, 0);
        if (named.n === "external") return EXTERNAL;
        if (named.n === "interface") return { v: "interface-method" };
        return named.n === "project" ? member(named, name) : UNKNOWN;
      }
      case "external":
      case "external-func":
        // A member of a value from outside the tree. `external-func` reaches
        // here only as `pkg.Var.name`, a package-level variable of that package.
        return EXTERNAL;
      default:
        return UNKNOWN;
    }
  };

  const resultOf = (fn: Val, i: number): Val => {
    switch (fn.v) {
      case "func": {
        const result = fn.decl.fact.results[i];
        return result ? { v: "value", type: result, file: fn.decl.file } : UNKNOWN;
      }
      case "type":
        return i === 0 ? { v: "value", type: fn.type, file: fn.file } : UNKNOWN;
      case "value": {
        const under = underlying(fn.type, fn.file, 0);
        if (under === "external") return EXTERNAL;
        if (!under || under.type.k !== "func") return UNKNOWN;
        const result = under.type.results[i];
        return result ? { v: "value", type: result, file: under.file } : UNKNOWN;
      }
      case "external":
        // A method of a non-generic type from outside the tree returns types
        // declared outside it.
        return EXTERNAL;
      default:
        return UNKNOWN;
    }
  };

  const elementOf = (x: Val, which: "elem" | "key"): Val => {
    if (x.v === "external") return EXTERNAL;
    if (x.v !== "value") return UNKNOWN;
    const under = underlying(x.type, x.file, 0);
    if (under === "external") return EXTERNAL;
    if (!under) return UNKNOWN;
    const t = under.type;
    let inner: GoType | null = null;
    if (which === "key") inner = t.k === "map" ? t.key : null;
    else if (t.k === "list" || t.k === "map" || t.k === "chan") inner = t.elem;
    return inner ? { v: "value", type: inner, file: under.file } : UNKNOWN;
  };

  function evaluate(expr: GoExpr, file: FileCtx, depth: number): Val {
    if (depth > MAX_EVAL_DEPTH) return UNKNOWN;
    switch (expr.e) {
      case "typed":
        return { v: "value", type: expr.type, file };
      case "name": {
        const imported = importsOf(file).get(expr.name);
        if (imported) return { v: "package", target: imported };
        const own = scopeMember(file.pkg, expr.name, file, "same-package");
        if (own) return own;
        // A dot import puts another package's names in this file's scope.
        for (const imp of file.facts.imports) {
          if (imp.alias !== ".") continue;
          const dir = importDir(imp.path);
          const pkg = dir === null ? null : importablePkg(dir);
          const hit = pkg ? scopeMember(pkg, expr.name, file, "package") : null;
          if (hit) return hit;
        }
        return UNKNOWN;
      }
      case "sel":
        return select(evaluate(expr.x, file, depth + 1), expr.name, file);
      case "call":
        return resultOf(evaluate(expr.fn, file, depth + 1), expr.i);
      case "elem":
        return elementOf(evaluate(expr.x, file, depth + 1), "elem");
      case "key":
        return elementOf(evaluate(expr.x, file, depth + 1), "key");
      default:
        return UNKNOWN;
    }
  }

  const unbound = (reason: GoUnboundReason): GoCallVerdict => ({ kind: "unbound", reason });

  return {
    resolveCall(filePath: string, callee: GoExpr): GoCallVerdict {
      const file = ctxByFile.get(filePath);
      if (!file) return { kind: "unknown" };
      if (callee.e === "local") return unbound("func-value");
      if (callee.e === "local-type") return unbound("conversion");
      if (callee.e !== "name" && callee.e !== "sel") return { kind: "unknown" };
      const val = evaluate(callee, file, 0);
      switch (val.v) {
        case "func":
          return { kind: "bound", qualifiedName: val.decl.fact.qualifiedName, via: val.via };
        case "external":
        case "external-func":
          return unbound("external");
        case "interface-method":
          return unbound("interface");
        case "ambiguous":
          return unbound("ambiguous");
        case "type":
          return unbound("conversion");
        case "value":
          // A variable or field holding a function.
          return unbound("func-value");
        case "package":
          return { kind: "unknown" };
        case "unknown":
          // A bare name that is no local, no package-scope declaration and no
          // dot-imported one can only be predeclared. Anything else was declared
          // in a file the walk did not see, so there is nothing to bind it to.
          if (callee.e === "name") {
            const dotImports = file.facts.imports.some((i) => i.alias === ".");
            if (GO_UNIVERSE.has(callee.name) || !dotImports) return unbound("external");
          }
          return { kind: "unknown" };
      }
    },
  };
}
