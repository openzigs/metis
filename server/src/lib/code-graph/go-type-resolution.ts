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
 *    the callee is outside the project (`external`), it is dispatched at run
 *    time (`interface`, `func-value`), it is a type conversion (`conversion`),
 *    or two declarations claim it (`ambiguous`: build-tagged twins). Nothing is
 *    guessed, and a later name-based resolver must not guess on `external`,
 *    `func-value`, `conversion` or `ambiguous` either — see
 *    `impact-analysis/go-call-resolution.ts`.
 *  - `unknown` — nothing was decided: the receiver's type could not be inferred
 *    (the result of a third-party generic function, a struct literal type), or
 *    the package a name belongs to could not be determined. The caller falls
 *    back to the name-evidence rules in `call-resolution.ts`, exactly as before
 *    this module existed.
 *
 * **`external` is recorded only when the callee is positively known to be
 * outside the project** — because every later reader treats it as decided and
 * never binds the call. Positive means one of:
 *
 *  - a predeclared identifier (`len`, `string`);
 *  - an import path that is the standard library (`go-stdlib.ts`) or lies
 *    outside every `go.mod` module of the tree, and a member of a value whose
 *    type such a package declares;
 *  - a name that the one package Go's scoping lets it mean does not declare,
 *    when EVERY Go file of that package's directory was read: a bare `f()` can
 *    only be the caller's own package (or a dot import, or a builtin), and
 *    `storage.F()` only package `storage`.
 *
 * Everything short of that is `unknown`: an import path inside a project
 * module whose directory holds no determinable package (two library package
 * clauses, no parsed file); a name its package does not declare when a file of
 * that directory could not be parsed ({@link GoResolverOptions.incompleteDirs});
 * a tree with no `go.mod` where an import path only ends like a directory
 * name; and two imports that would bind the same local name.
 *
 * One `external` is weaker than the rest and is kept deliberately: a method
 * called on a value of a THIRD-PARTY type. For a concrete type that is exact;
 * if the type is an interface the implementation may be a project type, and
 * this module cannot tell the two apart without reading the dependency. It does
 * tell them apart for the standard library, where the interfaces are listed
 * (`http.Handler`, `io.Writer`): a call through one is `interface`.
 *
 * Build constraints, as far as a reader needs them to name a directory's
 * package: a file tagged `//go:build ignore` (or `// +build ignore`) is not
 * part of its directory's package — it is resolved as a single-file package of
 * its own — and a `package main` beside one library package is never what an
 * import of that directory means. `_test` packages are a separate package.
 * Other constraints are not evaluated: twins behind them stay `ambiguous`.
 *
 * Deliberately NOT inferred: which concrete type sits behind an interface value,
 * type parameters, method expressions (`T.Method`), and anything whose type is
 * written only in a package outside the tree. Embedded-struct promotion IS
 * resolved, by Go's own shallowest-depth rule, and stops at the first depth that
 * holds an embedded type this module cannot see into.
 *
 * Pure and bounded: no I/O. One call's evaluation carries ONE depth counter
 * through every re-entry (a selection, a call result, a package variable's
 * initialiser), so a cycle of package variables ends at {@link MAX_EVAL_DEPTH}
 * like any other chain. An expression is a chain — every node has one operand —
 * so that depth is also the number of steps. Type lookups (aliases, defined
 * types, embeddings) are a separate, self-contained recursion capped at
 * {@link MAX_DEPTH}, entered from an evaluation but never re-entering it.
 */
import { GO_STDLIB_PACKAGES, isGoStdlibInterface } from "./go-stdlib.js";

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
  /**
   * The file opens with `//go:build ignore` (or `// +build ignore`): the go
   * tool never compiles it into its directory's package.
   */
  buildIgnored?: true;
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
 *
 * `external` covers a function of a package outside the project, a builtin, and
 * a method of a value whose type such a package declares. The last includes a
 * call through a THIRD-PARTY interface, which a project type may implement:
 * that edge is deliberately not guessed. Standard-library interfaces
 * (`http.Handler`, `io.Writer`) are told apart and recorded `interface`.
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

export interface GoResolverOptions {
  /**
   * Directories holding a Go file whose declarations are NOT among the files
   * given (it could not be read or parsed). A name such a directory's package
   * does not declare may be declared in that file, so it is never ruled out.
   */
  incompleteDirs?: ReadonlySet<string>;
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

/**
 * What an import path names. `external` only on positive evidence that it is
 * outside the project; `unknown` when it may be a project package this module
 * could not pin down.
 */
type ImportTarget = { t: "project"; pkg: Pkg } | { t: "external"; path: string } | { t: "unknown" };

const UNKNOWN_IMPORT: ImportTarget = { t: "unknown" };

/** True when `dir` is `root` or lies below it (`""` is the tree root). */
function isUnderDir(dir: string, root: string): boolean {
  return root === "" || dir === root || dir.startsWith(`${root}/`);
}

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
  /**
   * A method reached through an interface. `outside`: the interface is declared
   * outside the tree, so what the method RETURNS is a type declared there too.
   */
  | { v: "interface-method"; outside?: true }
  | { v: "ambiguous" }
  /**
   * A name the package that would have to declare it does not. `decided` when
   * every file of that package was read, so no project declaration is missing.
   */
  | { v: "undeclared"; decided: boolean }
  | { v: "unknown" };

const UNKNOWN: Val = { v: "unknown" };
const EXTERNAL: Val = { v: "external" };

/** A named type resolved against the tree. */
type Named =
  | { n: "project"; pkg: Pkg; name: string; viewer: FileCtx }
  | { n: "external" }
  /** `outside`: an interface of a package outside the tree (`http.ResponseWriter`). */
  | { n: "interface"; outside?: true }
  | { n: "unknown" };

/**
 * Build a resolver over every Go file of the tree.
 *
 * @param modules the tree's `go.mod` files. Go code no module covers (a tree
 *   with none, or a directory outside all of them) is matched to an import path
 *   by spelling alone, and only where that is unambiguous.
 */
export function createGoResolver(
  files: readonly GoResolverFile[],
  modules: readonly GoModule[],
  options: GoResolverOptions = {},
): GoResolver {
  const incompleteDirs = options.incompleteDirs ?? new Set<string>();
  const pkgs = new Map<string, Pkg>();
  /**
   * Directory → the packages the go tool builds there (normally one, plus an
   * external `_test` one). A `//go:build ignore` file is in none of them.
   */
  const pkgsByDir = new Map<string, Pkg[]>();
  /** Every directory holding a Go file, build-ignored ones included. */
  const goDirs = new Set<string>();
  const ctxByFile = new Map<string, FileCtx>();

  const add = <T>(map: Map<string, Decl<T>[]>, key: string, decl: Decl<T>): void => {
    const list = map.get(key);
    if (list) list.push(decl);
    else map.set(key, [decl]);
  };

  for (const f of files) {
    const dir = goDir(f.filePath);
    goDirs.add(dir);
    // A build-ignored file is a single-file package of its own (`go run gen.go`):
    // its calls resolve against its own declarations and never the directory's.
    const key = f.facts.buildIgnored
      ? `${dir}\u0000${f.facts.package}\u0000${f.filePath}`
      : `${dir}\u0000${f.facts.package}`;
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
      if (!f.facts.buildIgnored) {
        const list = pkgsByDir.get(dir);
        if (list) list.push(pkg);
        else pkgsByDir.set(dir, [pkg]);
      }
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

  /**
   * The package an importer sees in `dir`. An external `_test` package is never
   * importable and neither is `package main`, so a generator or example
   * (`package main`) beside one library package leaves that package. Anything
   * else — two library packages, none — is undetermined.
   */
  const importablePkg = (dir: string): Pkg | null => {
    const list = (pkgsByDir.get(dir) ?? []).filter(
      (p) => !p.name.endsWith("_test") && p.name !== "main",
    );
    return list.length === 1 ? list[0] : null;
  };

  /** A project directory an import path was matched to: its package, or undetermined. */
  const inDir = (dir: string): ImportTarget => {
    const pkg = importablePkg(dir);
    return pkg ? { t: "project", pkg } : UNKNOWN_IMPORT;
  };

  /** Directories holding Go code that no `go.mod` of the tree covers. */
  const orphanDirs = [...goDirs].filter((d) => !sortedModules.some((m) => isUnderDir(d, m.dir)));

  /**
   * An import path with no module to place it: matched to the tree by its
   * spelling alone, which decides only when the evidence is unambiguous.
   *
   *  - a directory whose path ENDS in the whole import path (a GOPATH layout:
   *    `src/github.com/org/app/store` for `github.com/org/app/store`);
   *  - a directory of two or more segments that the import path ends in
   *    (`internal/storage` for `example.org/app/internal/storage`).
   *
   * One segment is not evidence: `github.com/pkg/errors` ends in `errors`, and
   * so does the project's own `errors/`. With nothing matched the path is
   * outside the tree — unless Go code sits at the tree root, whose import path
   * is the unknown module path itself.
   */
  const bySpelling = (importPath: string): ImportTarget => {
    const holding = orphanDirs.filter(
      (d) => d !== "" && (d === importPath || d.endsWith(`/${importPath}`)),
    );
    let suffix: string | null = null;
    for (const d of orphanDirs) {
      if (d === "" || d === importPath || !importPath.endsWith(`/${d}`)) continue;
      if (suffix === null || d.length > suffix.length) suffix = d;
    }
    if (holding.length === 1 && suffix === null) return inDir(holding[0]);
    if (holding.length === 0 && suffix !== null) {
      return suffix.includes("/") ? inDir(suffix) : UNKNOWN_IMPORT;
    }
    if (holding.length > 0 || suffix !== null) return UNKNOWN_IMPORT;
    const rootImportable = (pkgsByDir.get("") ?? []).some(
      (p) => !p.name.endsWith("_test") && p.name !== "main",
    );
    return orphanDirs.includes("") && rootImportable
      ? UNKNOWN_IMPORT
      : { t: "external", path: importPath };
  };

  /** What an import path names: a project package, a package outside the tree, or neither known. */
  const resolveImport = (importPath: string): ImportTarget => {
    // The standard library is never a project directory, whatever the tree holds.
    if (GO_STDLIB_PACKAGES.has(importPath)) return { t: "external", path: importPath };
    for (const m of sortedModules) {
      const exact = importPath === m.path;
      if (!exact && !importPath.startsWith(`${m.path}/`)) continue;
      const rel = exact ? "" : importPath.slice(m.path.length + 1);
      const dir = exact ? m.dir : m.dir ? `${m.dir}/${rel}` : rel;
      // Inside a project module: a directory the walk holds no package for
      // (ignored, unparsed, generated at build time) is not thereby external.
      return inDir(dir);
    }
    if (orphanDirs.length === 0) return { t: "external", path: importPath };
    return bySpelling(importPath);
  };

  const importsOf = (ctx: FileCtx): Map<string, ImportTarget> => {
    if (ctx.imports) return ctx.imports;
    const out = new Map<string, ImportTarget>();
    for (const imp of ctx.facts.imports) {
      if (imp.alias === "_" || imp.alias === ".") continue;
      const target = resolveImport(imp.path);
      const name =
        imp.alias ?? (target.t === "project" ? target.pkg.name : goDefaultImportName(imp.path));
      if (!name) continue;
      const had = out.get(name);
      if (!had) {
        out.set(name, target);
        continue;
      }
      // Go allows one import per name, so two here means a default name was
      // guessed wrong for a package outside the tree. Which import the name
      // really is cannot be told — unless both are external anyway.
      if (had.t === "project" && target.t === "project" && had.pkg === target.pkg) continue;
      if (had.t === "external" && target.t === "external") continue;
      out.set(name, UNKNOWN_IMPORT);
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
      if (!target || target.t === "unknown") return { n: "unknown" };
      if (target.t === "external") {
        // A generic type from outside the tree can hand back project types
        // (`atomic.Pointer[User]`), so its members are not known to be external.
        if (type.generic) return { n: "unknown" };
        // `http.Handler`, `io.Writer`: whatever implements it runs, often a project type.
        if (isGoStdlibInterface(target.path, type.name)) return { n: "interface", outside: true };
        return { n: "external" };
      }
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

  /** The declaration behind a resolved type. `resolveNamed` already refused twins, so there is one. */
  const typeDecl = (named: Extract<Named, { n: "project" }>): Decl<GoTypeFact> | null =>
    visible(named.pkg.types, named.name, named.viewer)?.[0] ?? null;

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

  const packageMember = (
    target: ImportTarget,
    name: string,
    viewer: FileCtx,
    depth: number,
  ): Val => {
    if (target.t === "unknown") return UNKNOWN;
    if (target.t === "external") return { v: "external-func" };
    return (
      scopeMember(target.pkg, name, viewer, "package", depth) ?? {
        v: "undeclared",
        decided: !incompleteDirs.has(target.pkg.dir),
      }
    );
  };

  /**
   * A package-scope name: a function, a variable or constant, or a type.
   * `depth` is the evaluation's own counter — a variable's initialiser is
   * evaluated one level deeper, never from the top.
   */
  const scopeMember = (
    pkg: Pkg,
    name: string,
    viewer: FileCtx,
    via: GoBinding,
    depth: number,
  ): Val | null => {
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
      return fact.value ? evaluate(fact.value, file, depth + 1) : UNKNOWN;
    }
    if (visible(pkg.types, name, viewer)) {
      const file = viewer.pkg === pkg ? viewer : (pkg.types.get(name)?.[0]?.file ?? viewer);
      return { v: "type", type: { k: "named", name }, file };
    }
    return null;
  };

  const select = (x: Val, name: string, file: FileCtx, depth: number): Val => {
    switch (x.v) {
      case "package":
        return packageMember(x.target, name, file, depth);
      case "value": {
        if (x.type.k !== "named") return UNKNOWN;
        const named = resolveNamed(x.type, x.file, 0);
        if (named.n === "external") return EXTERNAL;
        if (named.n === "interface") {
          return named.outside
            ? { v: "interface-method", outside: true }
            : { v: "interface-method" };
        }
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
      case "interface-method":
        // `w.Header()` on an `http.ResponseWriter`: the standard library cannot
        // name a project type, so the result's type is declared outside the tree.
        return fn.outside ? EXTERNAL : UNKNOWN;
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
        const own = scopeMember(file.pkg, expr.name, file, "same-package", depth);
        if (own) return own;
        // A dot import puts another package's names in this file's scope.
        for (const imp of file.facts.imports) {
          if (imp.alias !== ".") continue;
          const target = resolveImport(imp.path);
          const hit =
            target.t === "project"
              ? scopeMember(target.pkg, expr.name, file, "package", depth)
              : null;
          if (hit) return hit;
        }
        // Nothing in scope declares it. That is decisive only when the caller's
        // whole package was read and no dot import could have brought it in.
        return {
          v: "undeclared",
          decided:
            !file.facts.imports.some((i) => i.alias === ".") &&
            (file.facts.buildIgnored === true || !incompleteDirs.has(file.dir)),
        };
      }
      case "sel":
        return select(evaluate(expr.x, file, depth + 1), expr.name, file, depth);
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
        case "undeclared":
          // A bare predeclared name nothing in scope shadows is a builtin or a
          // conversion to a basic type. Otherwise the name is ruled out only
          // when the package that would declare it was read in full.
          if (callee.e === "name" && GO_UNIVERSE.has(callee.name)) return unbound("external");
          return val.decided ? unbound("external") : { kind: "unknown" };
        case "unknown":
          // A bare call to a package-level VARIABLE whose type could not be
          // told (twin declarations, an unmodelled initialiser) is still a call
          // through a function value, never to a function of that name.
          if (callee.e === "name" && visible(file.pkg.vars, callee.name, file)) {
            return unbound("func-value");
          }
          return { kind: "unknown" };
      }
    },
  };
}
