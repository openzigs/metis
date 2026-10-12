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
 *    the callee is outside the project (`external`, `external-assumed`), it is
 *    dispatched at run time (`interface`, `func-value`), it is a type
 *    conversion (`conversion`), or two declarations claim it (`ambiguous`:
 *    build-tagged twins). Nothing is guessed, and a later name-based resolver
 *    must not guess on any of these but `interface` either — see
 *    `impact-analysis/go-call-resolution.ts`.
 *  - `unknown` — nothing was decided: the receiver's type could not be inferred
 *    (the result of a third-party generic function, a struct literal type), or
 *    the package a name belongs to could not be determined. The caller falls
 *    back to the name-evidence rules in `call-resolution.ts`, exactly as before
 *    this module existed.
 *
 * ## `external` on positive evidence; `external-assumed` where the receiver is external but its type is unexamined
 *
 * Every later reader treats both as decided and never binds the call, so each
 * says exactly what is known.
 *
 * **`external`** — the callee is positively known to be declared outside the
 * project. One of:
 *
 *  - a predeclared identifier (`len`, `string`);
 *  - a function of a package whose import path is the standard library
 *    (`go-stdlib.ts`) or lies outside every `go.mod` module of the tree;
 *  - a method called on a value whose type the SOURCE NAMES and which is a
 *    standard-library type that is not an interface (`db *sql.DB`,
 *    `r *http.Request`) — unless the type only PROMOTES that method from an
 *    interface it embeds (`sec.ReadAt()` on an `*elf.Section`), which is
 *    dispatched and so `interface`. The generated lists are complete for their
 *    Go release in both respects: every exported interface, and for every
 *    concrete type every such promoted method;
 *  - a name that the one package Go's scoping lets it mean does not declare,
 *    when EVERY Go file of that package's directory was read: a bare `f()` can
 *    only be the caller's own package (or a dot import, or a builtin), and
 *    `storage.F()` only package `storage`.
 *
 * **`external-assumed`** — the receiver is a value from outside the project,
 * but its own type was never examined, so whether the method is a concrete one
 * or is dispatched through an interface a project type implements is not known:
 *
 *  - a method on a value of a THIRD-PARTY type (`q queue.Consumer`): the
 *    dependency is not read, and the type may be an interface;
 *  - a member of a member, or of a call result, of an external value
 *    (`r.URL.Query()`, `w.Header().Set()`, `rows.Close()` after
 *    `rows, _ := db.Query()`), and an element of one.
 *
 * It is kept DECIDED on purpose: opened to the name fallback, four such calls
 * of four bound to the wrong function on the Miniflux sample. Where the member
 * in between is KNOWN to be a standard-library interface the call is not
 * assumed at all but `interface`: `resp.Body.Close()`,
 * `srv.Handler.ServeHTTP()`, `r.Context().Done()`, `io.Discard.Write()`.
 *
 * Everything short of evidence is `unknown`: an import path inside a project
 * module whose directory holds no determinable package (two library package
 * clauses, no parsed file); a name its package does not declare when a file of
 * that directory was not read — unparseable, unreadable, or hidden by the
 * ignore rules ({@link GoResolverOptions.incompleteDirs}); a type name its
 * project package does not declare; an import path that two `go.mod` files of
 * the tree both claim, from a file in neither; a tree with no `go.mod` where an
 * import path only ends like a directory name; and two imports that would bind
 * the same local name.
 *
 * An import is resolved from the importing file's OWN module first (the
 * nearest `go.mod` above it), then by the most specific module path, as Go
 * does. So in a monorepo of services that are each `module app`,
 * `app/storage` means the importer's own `storage/`.
 *
 * Build constraints, as far as a reader needs them to name a directory's
 * package: a file tagged `//go:build ignore` (or `// +build ignore`) is not
 * part of its directory's package — it is resolved as a single-file package of
 * its own, and beside ANOTHER ignored file not even that is known in full
 * (`go run gen.go gen_helpers.go`) — and a `package main` beside one library
 * package is never what an import of that directory means. `_test` packages
 * are a separate package. Other constraints are not evaluated: twins behind
 * them stay `ambiguous`, whether they are two functions, a function and a
 * variable or type of one name, or a field and a method of one name.
 *
 * Deliberately NOT inferred: which concrete type sits behind an interface value,
 * type parameters, method expressions (`T.Method`), and anything whose type is
 * written only in a package outside the tree. Embedded-struct promotion IS
 * resolved, by Go's own shallowest-depth rule, and stops at the first depth that
 * holds an embedded type this module cannot see into.
 *
 * ## Four rules the Go type checker corrected
 *
 * The verdicts of this module are compared, call by call, with what go/types
 * says about a corpus that compiles (`tests/fixtures/go-oracle/`,
 * `tests/lib/code-graph/go-oracle-corpus.test.ts`). Where they disagreed the
 * resolver was wrong:
 *
 *  - An embedded project INTERFACE holds the methods it declares and embeds —
 *    the walker records both — and no others. A name exactly one member of a
 *    promotion depth declares is that member's; two declaring it are
 *    `ambiguous`. Only a type whose members are NOT known in full (an interface
 *    embedding `io.Closer` or a union; a defined type over a dependency's
 *    struct) answers to any name, and beside one a sibling's member is
 *    undecided, not a decided tie.
 *  - A method declared in a `_test.go` file exists for the tests of ITS
 *    directory — the package's own test files and its `_test` package — at any
 *    depth of promotion, and for nobody else: the tests of another package are
 *    built against this one as it ships.
 *  - A function read out of a package VARIABLE (`var run = serve`) is called
 *    through the value: `func-value`, never a binding. Its result is still the
 *    function's.
 *  - An INDEXED callee (`Make[int](x)`, `handlers[i]()`) is decided by what is
 *    indexed: a generic function is the callee, a type converts, a value has an
 *    element called.
 *
 * ## Bounded work
 *
 * Pure: no I/O. Bounded in DEPTH and in WORK, which are different things — a
 * depth cap with a `seen` set still let one call look through every embedded
 * field of every type it could reach, and every call do it again.
 *
 *  - Depth. One call's evaluation carries ONE depth counter through every
 *    re-entry (a selection, a call result, a package variable's initialiser),
 *    so a cycle of package variables ends at {@link MAX_EVAL_DEPTH} like any
 *    other chain. An expression is a chain — every node has one operand — so
 *    that depth is also its number of steps. Type lookups (aliases, defined
 *    types, embeddings) are a separate recursion capped at {@link MAX_DEPTH}.
 *  - Work. Whatever depends only on the DECLARATIONS is worked out once per
 *    resolver and kept: what a type name means in a file, a type's struct, its
 *    whole member set (own and promoted), what an import path names, which
 *    declarations a viewer may see. A call then costs its own length, and the
 *    whole tree costs declarations plus calls. Nothing kept depends on the
 *    order calls arrive in.
 *  - Placing. Finding a directory's module, an import's most specific module,
 *    and — with no `go.mod` — the directory an import path is spelled like,
 *    each cost the LENGTH of that path, through indices built once: scanning
 *    the modules or the directories instead made one call cost imports ×
 *    directories (PR #1104, review cycle 3). A file's import block is read
 *    whole, or — longer than {@link GO_CALL_STEP_BUDGET} imports — not at all.
 *  - Budgets. What is left is counted: {@link GO_CALL_STEP_BUDGET} steps for
 *    one call, {@link GO_TYPE_STEP_BUDGET} for one type's member set. Past
 *    either the answer is `unknown` with `why: "budget"` — counted by the
 *    caller, never a guess. Ingest adds a ceiling on the whole step
 *    (`GO_BINDING_MAX_MS` in `ingest.ts`).
 */
import {
  GO_STDLIB_PACKAGES,
  goStdlibInterfaceMember,
  isGoStdlibFuncVar,
  isGoStdlibInterface,
  isGoStdlibInterfaceVar,
} from "./go-stdlib.js";

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
  /**
   * `x[…]` as a CALLEE (`f[T](a, b)`, `handlers[i]()`): either `x` given a type
   * argument — a generic function is called, a generic type converts — or an
   * element of `x` is called. The grammar cannot tell which; what `x` is does.
   */
  | { e: "indexed"; x: GoExpr }
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
  /** Method names an interface declares itself, so a call through one is told from a missing method. */
  methods?: string[];
  /**
   * The interfaces an interface embeds, whose methods are its own too. Null
   * for an element that is not one named type (a union, `~int`): the method
   * set is then not known in full.
   */
  embeds?: Array<GoType | null>;
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
export type GoUnboundReason =
  "external" | "external-assumed" | "interface" | "func-value" | "conversion" | "ambiguous";

export type GoCallVerdict =
  | { kind: "bound"; qualifiedName: string; via: GoBinding }
  | { kind: "unbound"; reason: GoUnboundReason }
  /**
   * `why: "budget"` — undecided because resolving it would have cost more than
   * {@link GO_CALL_STEP_BUDGET} or {@link GO_TYPE_STEP_BUDGET} allow, not
   * because the source leaves it open. The caller counts these.
   */
  | { kind: "unknown"; why?: "budget" };

/**
 * `CodeEdge.metadata` key recording how ingest decided a Go `calls` edge. On a
 * bound edge: a {@link GoBinding}, or {@link GO_RESOLUTION_NAME}. On an unbound
 * one: the {@link GoUnboundReason} for which the declarations rule a project
 * callee out. Absent when nothing was decided (the receiver's type could not be
 * inferred and no name evidence bound it) and on every graph ingested before
 * #1071.
 *
 * `name` also labels a call the type resolver could not finish — it threw, ran
 * out of budget, or came up after the ingest's time ceiling — that the name
 * rules then bound: such a call is undecided BY TYPE, not unbound. That
 * happens only for a file the ingest re-parsed; in an unchanged file a call
 * left unresolved keeps the row it had (`ingest.ts`).
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
 * `external` is a callee PROVEN to be declared outside the project: a function
 * of a package outside it, a builtin, a method of a standard-library type that
 * is not an interface. `external-assumed` is the weaker claim, said as such: a
 * member or result of an external value whose own type was not examined, and a
 * method on a third-party type — either may in truth be dispatched through an
 * interface a project type implements. It is decided all the same, on purpose:
 * that edge is not guessed. Standard-library interfaces (`http.Handler`,
 * `io.Writer`), reached directly or through a standard-library member
 * (`resp.Body`), are told apart and recorded `interface`.
 */
const GO_DECIDED_UNBOUND: readonly GoUnboundReason[] = [
  "external",
  "external-assumed",
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
   * given: it could not be read or parsed, or the ingest's ignore rules hide
   * it. A name such a directory's package does not declare may be declared in
   * that file, so it is never ruled out.
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
 * Most steps ONE `resolveCall` may take: a step is one node of the callee
 * expression evaluated, or one dot import consulted for a bare name. Lookups
 * into the declarations are not steps — each is worked out once per resolver
 * and kept. A real call takes its own length (a few steps, {@link MAX_EVAL_DEPTH}
 * at most per chain); past the budget the call is left undecided
 * (`{ kind: "unknown", why: "budget" }`), never guessed.
 */
export const GO_CALL_STEP_BUDGET = 10_000;

/**
 * Most steps working out ONE type's member set may take: a step is one field,
 * one method or one embedded type visited while following promotion. That is
 * work proportional to the declarations the type reaches, done once per type —
 * not once per call, which is what made a file of K types each embedding K
 * others cost calls × fields (PR #1104, review cycle 2). A type whose member
 * set is larger than this (no hand-written Go comes near it) has NO member
 * decided: every call selecting from it is `{ kind: "unknown", why: "budget" }`,
 * at the cost of one lookup.
 */
export const GO_TYPE_STEP_BUDGET = 100_000;

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
  /** Lazily built: what each dot import of the file names, in source order. */
  dotImports?: ImportTarget[];
  /** Type names written in this file, resolved once each ({@link NamedMemo}), by spelling. */
  named: Map<string, NamedMemo>;
  /** What a defined type written in this file is underneath, resolved once each, by spelling. */
  underlying: Map<string, Underlying>;
}

/** The declarations of one name, split ONCE by who may see them. */
interface Decls<T> {
  all: Decl<T>[];
  /** Those outside `_test.go` files: all that a non-test file can reach. */
  nonTest: Decl<T>[];
  /** Lazily built, for twins only: the declarations by declaring file. */
  byFile?: Map<FileCtx, Decl<T>[]>;
}

/** A package: one directory and one package-clause name (`foo` and `foo_test` are two). */
interface Pkg {
  id: number;
  dir: string;
  name: string;
  types: Map<string, Decls<GoTypeFact>>;
  funcs: Map<string, Decls<GoFuncFact>>;
  /** Receiver type name → method name → declarations. */
  methods: Map<string, Map<string, Decls<GoFuncFact>>>;
  vars: Map<string, Decls<GoVarFact>>;
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

/** What an expression evaluates to. */
type Val =
  /** A value of a type written in `file`'s scope. */
  | { v: "value"; type: GoType; file: FileCtx }
  | { v: "package"; target: ImportTarget }
  /**
   * A declared function or method. `held`: read out of a package VARIABLE
   * (`var run = serve`), so calling it calls whatever the variable holds now —
   * a func value, never a binding. The same flag means the same on the other
   * callable values below.
   */
  | { v: "func"; decl: Decl<GoFuncFact>; via: GoBinding; held?: true }
  /** A type name used as an expression: the callee of a conversion. */
  | { v: "type"; type: GoType; file: FileCtx }
  /**
   * A member of a value whose type is declared outside the tree. Without
   * `assumed` that is PROVEN to be declared outside it too: the type is a
   * standard-library type that is not an interface, so its methods are its
   * own. `assumed`: the receiver is external but its type was never examined
   * (a third-party type, or the member or result of another external value),
   * so whether this is a concrete method or one dispatched through an
   * interface is not known. `interfaceResults`: a standard-library method, and
   * the positions of its results that are standard-library interfaces.
   */
  | { v: "external"; assumed?: true; interfaceResults?: readonly number[]; held?: true }
  /** A function or variable of a package outside the tree; a function's result type is not known. */
  | { v: "external-func"; path: string; name: string; held?: true }
  /** A value of a standard-library INTERFACE type, reached through a standard-library member (`resp.Body`). */
  | { v: "outside-interface" }
  /**
   * A method reached through an interface. `outside`: the interface is declared
   * outside the tree, so what the method RETURNS is a type declared there too.
   */
  | { v: "interface-method"; outside?: true; held?: true }
  | { v: "ambiguous" }
  /**
   * A name the package that would have to declare it does not. `decided` when
   * every file of that package was read, so no project declaration is missing.
   */
  | { v: "undeclared"; decided: boolean }
  | { v: "unknown" };

const UNKNOWN: Val = { v: "unknown" };
const EXTERNAL: Val = { v: "external" };
const EXTERNAL_ASSUMED: Val = { v: "external", assumed: true };
const INTERFACE_METHOD: Val = { v: "interface-method" };
const OUTSIDE_INTERFACE_METHOD: Val = { v: "interface-method", outside: true };
const AMBIGUOUS: Val = { v: "ambiguous" };

type ProjectNamed = { n: "project"; pkg: Pkg; name: string; viewer: FileCtx };

/** A named type resolved against the tree. */
type Named =
  | ProjectNamed
  /** A type declared outside the tree; `path` is its import path, absent for a predeclared type (`int`). */
  | { n: "external"; path?: string; name?: string }
  /** `outside`: an interface of a package outside the tree (`http.ResponseWriter`). */
  | { n: "interface"; outside?: true }
  | { n: "unknown" };

const UNKNOWN_NAMED: Named = { n: "unknown" };

/**
 * A type name resolved from the file it is written in, kept for every later
 * mention. `hops` is how many aliases were followed to reach it: a mention that
 * is itself reached `depth` links into a chain stands only while
 * `depth + hops` is within {@link MAX_DEPTH}.
 */
interface NamedMemo {
  named: Named;
  hops: number;
}

type StructInfo = {
  fields: GoFieldFact[];
  file: FileCtx;
  byName: Map<string, GoFieldFact>;
};

/** What a composite type is underneath: the type itself, or what a defined type is defined as. */
type Underlying = { type: GoType; file: FileCtx } | "external" | null;

/** One project type's own declaration, read once: its struct (through `type A B`) and its methods. */
interface TypeInfo {
  decl: Decl<GoTypeFact> | null;
  struct: StructInfo | "external" | null;
  methods: Map<string, Decls<GoFuncFact>> | undefined;
}

/**
 * Every member one project type has — its own and the promoted ones — worked
 * out ONCE, by Go's shallowest-depth rule. `rest` is what any name not listed
 * selects: unknown where promotion ran into a type this module cannot see into
 * (or ran out), an interface method where the type is an interface.
 */
interface MemberTable {
  /** Members as a file that is NOT a test of any package involved sees them. */
  names: Map<string, Val>;
  /** The promotion depth each name of {@link names} was decided at. */
  depths: Map<string, number>;
  rest: Val;
  /**
   * The types the search went through, by the directory of their package:
   * where a method declared in a `_test.go` file could add a member for a
   * caller that is a test of that directory ({@link MemberTable.views}).
   */
  byDir: Map<string, Array<{ named: ProjectNamed; depth: number }>>;
  /** The depth the search ended at because types there answer to ANY name, and which types. */
  wildcardLevel: { depth: number; holders: string[] } | null;
  /** Building it passed {@link GO_TYPE_STEP_BUDGET}: nothing about the type's members is decided. */
  overBudget?: true;
  /**
   * Test directory → the members that differ for a caller built with that
   * directory's `_test.go` files, worked out on first use. `null`: over budget.
   */
  views?: Map<string, Map<string, Val> | null>;
}

/** An interface's whole method set: its own names and those of the interfaces it embeds. */
interface InterfaceNames {
  names: ReadonlySet<string>;
  /** Not known in full: it embeds something this module cannot read as a project interface. */
  open: boolean;
}

/** One segment of the index of directories no `go.mod` covers, read from the END of their paths. */
interface DirSuffixNode {
  kids: Map<string, DirSuffixNode>;
  /** How many directories end in the segments leading here, and one of them. */
  count: number;
  first: string;
  /** The directory that IS exactly these segments, if there is one. */
  dir: string | null;
}

/** Thrown, and caught in `resolveCall`, when one call passes {@link GO_CALL_STEP_BUDGET}. */
const CALL_OVER_BUDGET = Symbol("go-call-over-budget");

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
  /** Directory → how many `//go:build ignore` files it holds. */
  const ignoredInDir = new Map<string, number>();
  const ctxByFile = new Map<string, FileCtx>();

  const add = <T>(map: Map<string, Decls<T>>, key: string, decl: Decl<T>): void => {
    let decls = map.get(key);
    if (!decls) {
      decls = { all: [], nonTest: [] };
      map.set(key, decls);
    }
    decls.all.push(decl);
    if (!decl.file.isTest) decls.nonTest.push(decl);
  };

  for (const f of files) {
    const dir = goDir(f.filePath);
    goDirs.add(dir);
    if (f.facts.buildIgnored) ignoredInDir.set(dir, (ignoredInDir.get(dir) ?? 0) + 1);
    // A build-ignored file is a single-file package of its own (`go run gen.go`):
    // its calls resolve against its own declarations and never the directory's.
    const key = f.facts.buildIgnored
      ? `${dir}\u0000${f.facts.package}\u0000${f.filePath}`
      : `${dir}\u0000${f.facts.package}`;
    let pkg = pkgs.get(key);
    if (!pkg) {
      pkg = {
        id: pkgs.size,
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
    const ctx: FileCtx = {
      filePath: f.filePath,
      dir,
      pkg,
      isTest: f.isTest,
      facts: f.facts,
      named: new Map(),
      underlying: new Map(),
    };
    ctxByFile.set(f.filePath, ctx);
    for (const t of f.facts.types) add(pkg.types, t.name, { fact: t, file: ctx });
    for (const fn of f.facts.funcs) {
      if (fn.receiver) {
        let ofType = pkg.methods.get(fn.receiver);
        if (!ofType) {
          ofType = new Map();
          pkg.methods.set(fn.receiver, ofType);
        }
        add(ofType, fn.name, { fact: fn, file: ctx });
      } else add(pkg.funcs, fn.name, { fact: fn, file: ctx });
    }
    for (const v of f.facts.vars) add(pkg.vars, v.name, { fact: v, file: ctx });
  }

  // The `go.mod` files, by where they sit and by what they declare — so that
  // placing a directory or an import path costs the length of that path, never
  // the number of modules (a tree of 24,000 `go.mod` files took 1.2 s to build
  // a resolver for and 7.7 s to resolve, PR #1104 review cycle 3).
  const moduleAtDir = new Map<string, GoModule>();
  const modulesByPath = new Map<string, GoModule[]>();
  for (const m of modules) {
    if (!moduleAtDir.has(m.dir)) moduleAtDir.set(m.dir, m);
    const same = modulesByPath.get(m.path);
    if (same) same.push(m);
    else modulesByPath.set(m.path, [m]);
  }

  /** Directory → the `go.mod` nearest above it (the module the directory belongs to), or null. */
  const moduleOfDir = new Map<string, GoModule | null>();
  const moduleOf = (dir: string): GoModule | null => {
    const known = moduleOfDir.get(dir);
    if (known !== undefined) return known;
    let best: GoModule | null = null;
    // Walk UP the directory's own path: the first `go.mod` met is the nearest.
    for (let cur = dir; ; cur = goDir(cur)) {
      const at = moduleAtDir.get(cur);
      if (at) {
        best = at;
        break;
      }
      if (cur === "") break;
    }
    moduleOfDir.set(dir, best);
    return best;
  };

  /** The directory `importPath` names inside module `m`, or null when the path is not in it. */
  const dirInModule = (m: GoModule, importPath: string): string | null => {
    if (importPath === m.path) return m.dir;
    if (!importPath.startsWith(`${m.path}/`)) return null;
    const rel = importPath.slice(m.path.length + 1);
    return m.dir ? `${m.dir}/${rel}` : rel;
  };

  // ── Bounded work ─────────────────────────────────────────────────────────
  //
  // Everything a call looks up that depends only on the DECLARATIONS — what a
  // type name means in a file, a type's struct, its full member set, what an
  // import path names — is worked out once and kept, so a call costs its own
  // length and never the size of the package it lands in. What is left per
  // call is counted, and capped.

  /**
   * The directory whose `_test.go` files the call being resolved is built
   * with — the caller's own, when the caller is a test file — or null. It
   * decides which METHODS a type has for this call ({@link member}): a method
   * declared in `export_test.go` exists for that package's tests and for
   * nobody else, at whatever depth of promotion it sits.
   */
  let view: string | null = null;
  /** Steps the call being resolved has taken. */
  let callSteps = 0;
  /** The call being resolved met a type whose members could not be worked out in budget. */
  let budgetHit = false;
  const step = (): void => {
    callSteps += 1;
    if (callSteps > GO_CALL_STEP_BUDGET) throw CALL_OVER_BUDGET;
  };

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
  const orphanDirs = new Set([...goDirs].filter((d) => moduleOf(d) === null));

  /**
   * Those directories indexed by the END of their paths, one segment per
   * level, built on first use. An import path is then matched by walking its
   * own segments from the last one — a cost of its length, whatever the
   * number of directories. (Filtering the whole list for every import of a
   * file made one call cost imports × directories: 23 s on a 40,001-file tree,
   * outside every budget — PR #1104 review cycle 3.) Whole SEGMENTS are
   * compared, never letters: `mystore` does not end in `store`.
   */
  let orphanSuffixes: DirSuffixNode | null = null;
  const orphanSuffixIndex = (): DirSuffixNode => {
    if (orphanSuffixes) return orphanSuffixes;
    const root: DirSuffixNode = { kids: new Map(), count: 0, first: "", dir: null };
    for (const d of orphanDirs) {
      if (d === "") continue;
      const segs = d.split("/");
      let node = root;
      for (let i = segs.length - 1; i >= 0; i -= 1) {
        let next = node.kids.get(segs[i]);
        if (!next) {
          next = { kids: new Map(), count: 0, first: d, dir: null };
          node.kids.set(segs[i], next);
        }
        next.count += 1;
        node = next;
      }
      node.dir = d;
    }
    orphanSuffixes = root;
    return root;
  };

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
    const segs = importPath.split("/");
    // `suffix`: the longest directory the import path ENDS in (a proper tail
    // of it). `holding`: the directories that end in the WHOLE import path.
    let suffix: string | null = null;
    let node: DirSuffixNode | undefined = orphanSuffixIndex();
    for (let i = segs.length - 1; i >= 0 && node; i -= 1) {
      node = node.kids.get(segs[i]);
      if (node?.dir && i > 0) suffix = node.dir;
    }
    const holding = node ? node.count : 0;
    if (holding === 1 && suffix === null) return inDir(node!.first);
    if (holding === 0 && suffix !== null) {
      return suffix.includes("/") ? inDir(suffix) : UNKNOWN_IMPORT;
    }
    if (holding > 0 || suffix !== null) return UNKNOWN_IMPORT;
    const rootImportable = (pkgsByDir.get("") ?? []).some(
      (p) => !p.name.endsWith("_test") && p.name !== "main",
    );
    return orphanDirs.has("") && rootImportable
      ? UNKNOWN_IMPORT
      : { t: "external", path: importPath };
  };

  /**
   * Importing module and import path → what the path names, decided once.
   * Placing a path costs its own length ({@link moduleOf}, the module-path
   * index, {@link orphanSuffixIndex}); what a file may ask for is capped by
   * {@link importsReadable}.
   */
  const importTargets = new Map<GoModule | null, Map<string, ImportTarget>>();

  /**
   * What an import path names FROM `importer`: a project package, a package
   * outside the tree, or neither known.
   */
  const resolveImport = (importPath: string, importer: FileCtx): ImportTarget => {
    const own = moduleOf(importer.dir);
    let ofModule = importTargets.get(own);
    if (!ofModule) {
      ofModule = new Map();
      importTargets.set(own, ofModule);
    }
    const known = ofModule.get(importPath);
    if (known) return known;
    const target = resolveImportOnce(importPath, own);
    ofModule.set(importPath, target);
    return target;
  };

  const resolveImportOnce = (importPath: string, own: GoModule | null): ImportTarget => {
    // The standard library is never a project directory, whatever the tree holds.
    if (GO_STDLIB_PACKAGES.has(importPath)) return { t: "external", path: importPath };
    // The importing file's own module first: a path inside it means the
    // directory that module holds — whatever another `go.mod` of the tree calls
    // itself. (Unless that directory holds no Go: then the general rule below
    // decides, and may find a more specific module elsewhere.)
    if (own) {
      const dir = dirInModule(own, importPath);
      if (dir !== null && goDirs.has(dir)) return inDir(dir);
    }
    // Otherwise the most specific module path wins, as in Go: the longest
    // leading run of the import path's segments that a `go.mod` declares.
    let best: GoModule[] = [];
    for (let end = importPath.length; end > 0; end = importPath.lastIndexOf("/", end - 1)) {
      const declaring = modulesByPath.get(importPath.slice(0, end));
      if (declaring) {
        best = declaring;
        break;
      }
    }
    if (best.length > 0) {
      // Two `go.mod` files declaring one module path (a monorepo of services
      // that are each `module app`): only the importer's own could settle
      // which, and it was tried above.
      if (best.length > 1) return UNKNOWN_IMPORT;
      // Inside a project module: a directory the walk holds no package for
      // (ignored, unparsed, generated at build time) is not thereby external.
      return inDir(dirInModule(best[0], importPath)!);
    }
    if (orphanDirs.size === 0) return { t: "external", path: importPath };
    return bySpelling(importPath);
  };

  /**
   * Whether a file's import block is read at all. Its imports are resolved
   * together, the first time a call needs one — work the size of the block,
   * done inside that call. A block longer than one call's whole step budget
   * is not read: the file's imports then name nothing, for every call alike
   * and whatever order calls arrive in, and a call that needed them is
   * undecided (`why: "budget"`). No hand-written file comes near it.
   */
  const importsReadable = (ctx: FileCtx): boolean =>
    ctx.facts.imports.length <= GO_CALL_STEP_BUDGET;

  /** Local import name → target, for a file whose imports are read ({@link importsReadable}); else null. */
  const importsOf = (ctx: FileCtx): Map<string, ImportTarget> | null => {
    if (ctx.imports) return ctx.imports;
    if (!importsReadable(ctx)) return null;
    const out = new Map<string, ImportTarget>();
    for (const imp of ctx.facts.imports) {
      if (imp.alias === "_" || imp.alias === ".") continue;
      const target = resolveImport(imp.path, ctx);
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

  /**
   * What the dot imports of a file name, each target ONCE: a dot import puts
   * that package's names in the file's scope, and importing it again adds
   * nothing. (A bare name is looked up in every entry, so 10,000 dot imports
   * of one package made each call spend its whole step budget — PR #1104
   * review cycle 3.) Packages that are not the project's keep one entry
   * between them: none can supply a project function, but one is enough to
   * say a name MAY have come from outside.
   */
  const dotImportsOf = (ctx: FileCtx): ImportTarget[] | null => {
    if (ctx.dotImports) return ctx.dotImports;
    if (!importsReadable(ctx)) return null;
    const out: ImportTarget[] = [];
    const seen = new Set<Pkg>();
    let outside = false;
    for (const imp of ctx.facts.imports) {
      if (imp.alias !== ".") continue;
      const target = resolveImport(imp.path, ctx);
      if (target.t === "project") {
        if (seen.has(target.pkg)) continue;
        seen.add(target.pkg);
      } else {
        if (outside) continue;
        outside = true;
      }
      out.push(target);
    }
    ctx.dotImports = out;
    return out;
  };

  /**
   * Whether `viewer` is built together with the `_test.go` files of the
   * package in `dir`: only a test file of that SAME directory is. The tests of
   * one package are compiled against every other package as it ships, so a
   * test in `a/` sees nothing `b/export_test.go` declares.
   */
  const seesTests = (viewer: FileCtx, dir: string): boolean => viewer.isTest && viewer.dir === dir;

  /** Declarations of `key` in the package of `dir` that a viewer may reach ({@link seesTests}). */
  const visible = <T>(
    map: Map<string, Decls<T>> | undefined,
    key: string,
    viewer: FileCtx,
    dir: string,
  ): Decl<T>[] | undefined => {
    const decls = map?.get(key);
    if (!decls) return undefined;
    const out = seesTests(viewer, dir) ? decls.all : decls.nonTest;
    return out.length > 0 ? out : undefined;
  };

  /** The declarations of a name made in `file` itself: how a caller picks its own twin. */
  const declaredIn = <T>(decls: Decls<T>, file: FileCtx): Decl<T>[] => {
    if (!decls.byFile) {
      decls.byFile = new Map();
      for (const d of decls.all) {
        const list = decls.byFile.get(d.file);
        if (list) list.push(d);
        else decls.byFile.set(d.file, [d]);
      }
    }
    return decls.byFile.get(file) ?? [];
  };

  const namedKey = (type: Extract<GoType, { k: "named" }>): string =>
    `${type.pkg ?? ""}\u0000${type.name}${type.generic ? "\u0000g" : ""}`;

  /** One link of {@link resolveNamed}: the declaration a written type names, or the alias to follow. */
  const namedOnce = (
    type: Extract<GoType, { k: "named" }>,
    file: FileCtx,
  ): Named | { alias: GoType | null | undefined; file: FileCtx } => {
    let pkg = file.pkg;
    if (type.pkg !== undefined) {
      const target = importsOf(file)?.get(type.pkg);
      if (!target || target.t === "unknown") return UNKNOWN_NAMED;
      if (target.t === "external") {
        // A generic type from outside the tree can hand back project types
        // (`atomic.Pointer[User]`), so its members are not known to be external.
        if (type.generic) return UNKNOWN_NAMED;
        // `http.Handler`, `io.Writer`: whatever implements it runs, often a project type.
        if (isGoStdlibInterface(target.path, type.name)) return { n: "interface", outside: true };
        return { n: "external", path: target.path, name: type.name };
      }
      pkg = target.pkg;
    }
    const decls = visible(pkg.types, type.name, file, pkg.dir);
    if (!decls) {
      if (type.pkg !== undefined) return UNKNOWN_NAMED;
      if (GO_UNIVERSE_INTERFACES.has(type.name)) return { n: "interface" };
      return GO_UNIVERSE.has(type.name) ? { n: "external" } : UNKNOWN_NAMED;
    }
    if (decls.length > 1) return UNKNOWN_NAMED;
    const decl = decls[0];
    if (decl.fact.form === "alias") return { alias: decl.fact.target, file: decl.file };
    return { n: "project", pkg, name: type.name, viewer: file };
  };

  /** A type name as written in `file`, resolved once: aliases followed to the declaration. */
  const namedMemo = (type: Extract<GoType, { k: "named" }>, file: FileCtx): NamedMemo => {
    const key = namedKey(type);
    const known = file.named.get(key);
    if (known) return known;
    let memo: NamedMemo = { named: UNKNOWN_NAMED, hops: 0 };
    let cur: GoType | null | undefined = type;
    let at = file;
    for (let hops = 0; hops <= MAX_DEPTH; hops += 1) {
      if (!cur || cur.k !== "named") break;
      const one = namedOnce(cur, at);
      if (!("alias" in one)) {
        memo = { named: one, hops };
        break;
      }
      cur = one.alias;
      at = one.file;
    }
    file.named.set(key, memo);
    return memo;
  };

  /**
   * Resolve a written type to the declaration it names. `depth` is where in a
   * chain of aliases, defined types or embeddings the mention sits.
   */
  const resolveNamed = (type: GoType, file: FileCtx, depth: number): Named => {
    if (type.k !== "named" || depth > MAX_DEPTH) return UNKNOWN_NAMED;
    const memo = namedMemo(type, file);
    return depth + memo.hops > MAX_DEPTH ? UNKNOWN_NAMED : memo.named;
  };

  /** The declaration behind a resolved type. `resolveNamed` already refused twins, so there is one. */
  const typeDecl = (named: ProjectNamed): Decl<GoTypeFact> | null =>
    visible(named.pkg.types, named.name, named.viewer, named.pkg.dir)?.[0] ?? null;

  const structInfo = (fields: GoFieldFact[], file: FileCtx): StructInfo => {
    const byName = new Map<string, GoFieldFact>();
    // The first field of a name is the one a selector reaches.
    for (const f of fields) if (!byName.has(f.name)) byName.set(f.name, f);
    return { fields, file, byName };
  };

  /** The struct fields a type has, following `type A B` to B's struct. */
  const structAt = (named: ProjectNamed, depth: number): StructInfo | "external" | null => {
    const decl = typeDecl(named);
    if (!decl || depth > MAX_DEPTH) return null;
    if (decl.fact.form === "struct") return structInfo(decl.fact.fields ?? [], decl.file);
    if (decl.fact.form !== "defined" || !decl.fact.target) return null;
    const under = resolveNamed(decl.fact.target, decl.file, depth + 1);
    if (under.n === "external") return "external";
    return under.n === "project" ? structAt(under, depth + 1) : null;
  };

  /** Package id and type name: one declared type, whoever looks. */
  const typeId = (named: ProjectNamed): string => `${named.pkg.id}\u0000${named.name}`;

  /** Package id, type name and who is looking → what the type declares, read once. */
  const typeInfos = new Map<string, TypeInfo>();
  const typeKey = (named: ProjectNamed): string =>
    `${typeId(named)}\u0000${seesTests(named.viewer, named.pkg.dir) ? 1 : 0}`;

  const typeInfo = (named: ProjectNamed): TypeInfo => {
    const key = typeKey(named);
    let info = typeInfos.get(key);
    if (!info) {
      info = {
        decl: typeDecl(named),
        struct: structAt(named, 0),
        methods: named.pkg.methods.get(named.name),
      };
      typeInfos.set(key, info);
    }
    return info;
  };

  const underlyingAt = (type: GoType, file: FileCtx, depth: number): Underlying => {
    if (type.k !== "named") return { type, file };
    if (depth > MAX_DEPTH) return null;
    const named = resolveNamed(type, file, depth);
    if (named.n === "external") return "external";
    if (named.n !== "project") return null;
    const decl = typeDecl(named);
    if (!decl || decl.fact.form !== "defined" || !decl.fact.target) return null;
    return underlyingAt(decl.fact.target, decl.file, depth + 1);
  };

  /** A composite type behind a value: the type itself, or what a defined type is defined as. */
  const underlying = (type: GoType, file: FileCtx): Underlying => {
    if (type.k !== "named") return { type, file };
    const key = namedKey(type);
    if (file.underlying.has(key)) return file.underlying.get(key) ?? null;
    const out = underlyingAt(type, file, 0);
    file.underlying.set(key, out);
    return out;
  };

  /** A method of a project type, as one viewer sees it: bound, or refused when twins declare it. */
  const methodVal = (decls: Decl<GoFuncFact>[]): Val =>
    decls.length === 1 ? { v: "func", decl: decls[0], via: "receiver-type" } : AMBIGUOUS;

  /**
   * What selects from a type whatever the name: the members of a defined type
   * over a type outside the tree, which keeps that type's fields, whose types
   * are not examined. (An interface is not one: its method names are known.)
   */
  const wildcardOf = (info: TypeInfo): Val | null =>
    info.struct === "external" ? EXTERNAL_ASSUMED : null;

  const interfaceNameSets = new Map<string, InterfaceNames>();

  /**
   * The whole method set of a project interface, worked out once: the names
   * it declares and, through the interfaces it embeds, theirs — all at the
   * interface's own depth, as Go has it. `open` when an embedded element is
   * not a project interface this module can read (`io.Reader`, `error`, a
   * union): the set may then hold any name.
   */
  const interfaceNames = (start: ProjectNamed): InterfaceNames => {
    const key = typeKey(start);
    const known = interfaceNameSets.get(key);
    if (known) return known;
    const names = new Set<string>();
    let open = false;
    let steps = 0;
    const seen = new Set<string>([typeId(start)]);
    const queue: Array<{ named: ProjectNamed; depth: number }> = [{ named: start, depth: 0 }];
    for (let at = 0; at < queue.length && !open; at += 1) {
      const { named, depth } = queue[at];
      const decl = typeDecl(named);
      if (decl?.fact.form !== "interface") {
        open = true;
        break;
      }
      for (const method of decl.fact.methods ?? []) {
        steps += 1;
        names.add(method);
      }
      for (const embedded of decl.fact.embeds ?? []) {
        steps += 1;
        const inner = embedded ? resolveNamed(embedded, decl.file, depth + 1) : UNKNOWN_NAMED;
        if (inner.n !== "project") {
          open = true;
          break;
        }
        const id = typeId(inner);
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push({ named: inner, depth: depth + 1 });
      }
      // Too large to read in budget: it may hold any name.
      if (steps > GO_TYPE_STEP_BUDGET) open = true;
    }
    const out: InterfaceNames = { names, open };
    interfaceNameSets.set(key, out);
    return out;
  };

  const memberTables = new Map<string, MemberTable>();

  /**
   * Every member of a project type: its own (a field or a method), else the
   * one promoted from the shallowest embedded type that has it. Built level by
   * level, once per type.
   */
  const memberTable = (start: ProjectNamed): MemberTable => {
    const key = typeKey(start);
    const known = memberTables.get(key);
    if (known) return known;
    const table = buildMemberTable(start);
    memberTables.set(key, table);
    return table;
  };

  const buildMemberTable = (start: ProjectNamed): MemberTable => {
    const names = new Map<string, Val>();
    const depths = new Map<string, number>();
    const byDir: MemberTable["byDir"] = new Map();
    const done = (rest: Val, wildcardLevel: MemberTable["wildcardLevel"] = null): MemberTable => ({
      names,
      depths,
      rest,
      byDir,
      wildcardLevel,
    });
    let steps = 0;
    let level: ProjectNamed[] = [start];
    const seen = new Set<string>();
    for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth += 1) {
      // Hits at this depth, per name: a name one type of the level holds is
      // that member, a name two hold is ambiguous.
      const hits = new Map<string, { count: number; val: Val; holders: Set<number> }>();
      const hit = (name: string, val: Val, holder: number, replace = false): void => {
        const had = hits.get(name);
        if (!had) hits.set(name, { count: 1, val, holders: new Set([holder]) });
        else if (!had.holders.has(holder)) {
          had.count += 1;
          had.holders.add(holder);
        } else if (replace) had.val = val;
      };
      const wildcards: Array<{ holder: number; val: Val }> = [];
      const infos = level.map((named) => typeInfo(named));
      for (let i = 0; i < level.length; i += 1) {
        const named = level[i];
        const info = infos[i];
        steps += 1;
        const inDir = byDir.get(named.pkg.dir);
        if (inDir) inDir.push({ named, depth });
        else byDir.set(named.pkg.dir, [{ named, depth }]);
        if (info.struct && info.struct !== "external") {
          const file = info.struct.file;
          for (const [name, field] of info.struct.byName) {
            steps += 1;
            hit(name, field.type ? { v: "value", type: field.type, file } : UNKNOWN, i);
          }
        }
        if (info.methods) {
          for (const [name, decls] of info.methods) {
            steps += 1;
            // Methods declared in `_test.go` files are no part of this table:
            // they exist for one directory's tests only ({@link viewMembers}).
            if (decls.nonTest.length === 0) continue;
            // A field AND a method of one name cannot be one type: they are
            // twins behind build constraints, and neither is chosen.
            const fieldToo =
              info.struct && info.struct !== "external" && info.struct.byName.has(name);
            hit(name, fieldToo ? AMBIGUOUS : methodVal(decls.nonTest), i, fieldToo === true);
          }
        }
        if (info.decl?.fact.form === "interface") {
          // An interface holds exactly the methods it declares and embeds,
          // each dispatched at run time — and any name at all when its set
          // is not known in full.
          const set = interfaceNames(named);
          for (const name of set.names) {
            steps += 1;
            hit(name, INTERFACE_METHOD, i);
          }
          if (set.open) wildcards.push({ holder: i, val: INTERFACE_METHOD });
        }
        const wildcard = wildcardOf(info);
        if (wildcard) wildcards.push({ holder: i, val: wildcard });
        if (steps > GO_TYPE_STEP_BUDGET)
          return { ...done(UNKNOWN), names: new Map(), overBudget: true };
      }
      for (const [name, h] of hits) {
        if (names.has(name)) continue;
        // Two types of the level that both DECLARE the name are a tie. A
        // type that answers to any name (its members are not known) beside
        // the one that declares it is not a tie but an open question: in Go
        // that compiles only one of them has it, and which is not known here.
        let open = 0;
        for (const w of wildcards) if (!h.holders.has(w.holder)) open += 1;
        names.set(name, h.count > 1 ? AMBIGUOUS : open > 0 ? UNKNOWN : h.val);
        depths.set(name, depth);
      }
      // A type of this level that answers to every name ends the search
      // here: a name nobody declares is its member — or, with two such
      // types, one of theirs, which is not known.
      if (wildcards.length > 0) {
        return done(wildcards.length === 1 ? wildcards[0].val : UNKNOWN, {
          depth,
          holders: wildcards.map((w) => typeId(level[w.holder])),
        });
      }
      const next: ProjectNamed[] = [];
      for (const info of infos) {
        if (!info.struct || info.struct === "external") continue;
        for (const field of info.struct.fields) {
          if (!field.embedded) continue;
          steps += 1;
          // An embedded type this module cannot see into may declare any name
          // at this depth, which would win over anything deeper.
          if (!field.type) return done(UNKNOWN);
          const embedded = resolveNamed(field.type, info.struct.file, 0);
          if (embedded.n !== "project") return done(UNKNOWN);
          const key = typeId(embedded);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(embedded);
        }
      }
      level = next;
    }
    return done(UNKNOWN);
  };

  /**
   * The members of a type that DIFFER for a caller built with the `_test.go`
   * files of `dir`, worked out once per type and directory.
   *
   * The types a promotion search goes through do not depend on who asks — a
   * type that ships cannot embed a test-only one — so the table above stands,
   * and a test file changes it in one way only: the types of ITS directory
   * gain the methods their `_test.go` files declare. Such a method is the
   * member when it sits shallower than what the table holds for that name; at
   * the same depth the two collide; deeper, it loses. That costs the methods
   * of the directory's types, not another search: a type reached from a
   * thousand test directories is still searched once.
   */
  const viewMembers = (table: MemberTable, dir: string): Map<string, Val> | null => {
    const views = (table.views ??= new Map());
    const known = views.get(dir);
    if (known !== undefined) return known;
    const gains = new Map<
      string,
      { depth: number; count: number; decls: Decl<GoFuncFact>[]; holder: string }
    >();
    let steps = 0;
    for (const { named, depth } of table.byDir.get(dir) ?? []) {
      for (const [name, decls] of named.pkg.methods.get(named.name) ?? []) {
        steps += 1;
        if (decls.all.length === decls.nonTest.length) continue;
        const had = gains.get(name);
        if (!had || depth < had.depth) {
          gains.set(name, {
            depth,
            count: 1,
            decls: decls.all,
            holder: typeId(named),
          });
        } else if (depth === had.depth) had.count += 1;
      }
      if (steps > GO_TYPE_STEP_BUDGET) {
        views.set(dir, null);
        return null;
      }
    }
    const out = new Map<string, Val>();
    for (const [name, gain] of gains) {
      const held = table.depths.get(name);
      // A shallower member still wins.
      if (held !== undefined && held < gain.depth) continue;
      // The same depth already holds the name: the type's own twin, a field
      // of that name, or another embedded type's member.
      if (held === gain.depth) {
        out.set(name, AMBIGUOUS);
        continue;
      }
      // Shallower than anything held. Two test-file declarations at that
      // depth are a tie; ANOTHER type there that answers to any name leaves
      // it open.
      const others =
        table.wildcardLevel?.depth === gain.depth
          ? table.wildcardLevel.holders.filter((h) => h !== gain.holder).length
          : 0;
      out.set(name, gain.count > 1 ? AMBIGUOUS : others > 0 ? UNKNOWN : methodVal(gain.decls));
    }
    views.set(dir, out);
    return out;
  };

  /**
   * `x.name` on a value of a project type: its own member, else the member
   * promoted from the shallowest embedded type that has it — as the caller of
   * the call being resolved is built ({@link view}).
   */
  const member = (start: ProjectNamed, name: string): Val => {
    const table = memberTable(start);
    if (table.overBudget) {
      budgetHit = true;
      return UNKNOWN;
    }
    if (view !== null && table.byDir.has(view)) {
      const inView = viewMembers(table, view);
      if (inView === null) {
        budgetHit = true;
        return UNKNOWN;
      }
      const differs = inView.get(name);
      if (differs) return differs;
    }
    return table.names.get(name) ?? table.rest;
  };
  const packageMember = (
    target: ImportTarget,
    name: string,
    viewer: FileCtx,
    depth: number,
  ): Val => {
    if (target.t === "unknown") return UNKNOWN;
    if (target.t === "external") return { v: "external-func", path: target.path, name };
    return (
      scopeMember(target.pkg, name, viewer, "package", depth) ?? {
        v: "undeclared",
        decided: !incompleteDirs.has(target.pkg.dir),
      }
    );
  };

  /**
   * A package variable's value: its written type, else what its initialiser
   * evaluates to. When that is a FUNCTION (`var run = serve`, `var out =
   * fmt.Println`, `var save = store.Save`) the variable holds a function value:
   * its results are still the function's, but a call of the variable is a
   * call through a value — it runs whatever was assigned last — and is marked
   * so. Twins the initialiser cannot choose between say nothing about it.
   */
  const varVal = ({ fact, file }: Decl<GoVarFact>, depth: number): Val => {
    if (fact.type) return { v: "value", type: fact.type, file };
    if (!fact.value) return UNKNOWN;
    const val = evaluate(fact.value, file, depth + 1);
    switch (val.v) {
      case "func":
      case "external":
      case "external-func":
      case "interface-method":
        return { ...val, held: true };
      case "ambiguous":
        return UNKNOWN;
      default:
        return val;
    }
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
    const funcs = visible(pkg.funcs, name, viewer, pkg.dir);
    const vars = visible(pkg.vars, name, viewer, pkg.dir);
    const types = visible(pkg.types, name, viewer, pkg.dir);
    // One package cannot declare a name twice, so a function AND a variable (or
    // a type) of one name are twins behind build constraints this module does
    // not evaluate. Only the caller's own file settles which it sees.
    if ((funcs ? 1 : 0) + (vars ? 1 : 0) + (types ? 1 : 0) > 1) {
      const ownFuncs = funcs ? declaredIn(pkg.funcs.get(name)!, viewer) : [];
      const ownVars = vars ? declaredIn(pkg.vars.get(name)!, viewer) : [];
      const ownTypes = types ? declaredIn(pkg.types.get(name)!, viewer) : [];
      if (ownFuncs.length + ownVars.length + ownTypes.length !== 1) return AMBIGUOUS;
      if (ownFuncs.length === 1) return { v: "func", decl: ownFuncs[0], via };
      if (ownVars.length === 1) return varVal(ownVars[0], depth);
      return { v: "type", type: { k: "named", name }, file: viewer };
    }
    if (funcs) {
      if (funcs.length === 1) return { v: "func", decl: funcs[0], via };
      // Twins behind build tags: prefer the caller's own file, else refuse.
      const own = declaredIn(pkg.funcs.get(name)!, viewer);
      return own.length === 1 ? { v: "func", decl: own[0], via } : AMBIGUOUS;
    }
    if (vars) return vars.length === 1 ? varVal(vars[0], depth) : UNKNOWN;
    if (types) {
      const file = viewer.pkg === pkg ? viewer : (pkg.types.get(name)?.all[0]?.file ?? viewer);
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
        if (named.n === "external") return externalMember(named, name);
        if (named.n === "interface") {
          return named.outside ? OUTSIDE_INTERFACE_METHOD : { v: "interface-method" };
        }
        return named.n === "project" ? member(named, name) : UNKNOWN;
      }
      case "outside-interface":
        // `resp.Body.Close()`: a method of a standard-library interface value.
        return OUTSIDE_INTERFACE_METHOD;
      case "external":
        // A member of a member (or of a result) of a value from outside the
        // tree: the type in between was never examined.
        return EXTERNAL_ASSUMED;
      case "external-func":
        // Reached only as `pkg.Var.name`, a package-level variable of a package
        // outside the tree. Known to hold an interface (`io.Discard`): its
        // methods are dispatched. Otherwise the variable's type is unexamined.
        return isGoStdlibInterfaceVar(x.path, x.name) ? OUTSIDE_INTERFACE_METHOD : EXTERNAL_ASSUMED;
      default:
        return UNKNOWN;
    }
  };

  /**
   * `x.name` where x's type is declared outside the tree and named in the
   * source. A member of a standard-library type that is not an interface is
   * declared by a concrete standard-library type — external, proven — with two
   * listed exceptions: a member TYPED as an interface (`resp.Body`,
   * `r.Context()`), and a method the type only PROMOTES from an interface it
   * embeds (`sec.ReadAt()` on an `*elf.Section`), which is dispatched like any
   * interface method. A third-party type cannot be examined: it may itself be
   * an interface a project type implements.
   */
  const externalMember = (named: Extract<Named, { n: "external" }>, name: string): Val => {
    // A predeclared type (`int`, `string`) has no members to dispatch.
    if (named.path === undefined || named.name === undefined) return EXTERNAL;
    if (!GO_STDLIB_PACKAGES.has(named.path)) return EXTERNAL_ASSUMED;
    const known = goStdlibInterfaceMember(named.path, named.name, name);
    if (!known) return EXTERNAL;
    if (known.kind === "field") return { v: "outside-interface" };
    return known.promoted
      ? OUTSIDE_INTERFACE_METHOD
      : { v: "external", interfaceResults: known.results };
  };

  const resultOf = (fn: Val, i: number): Val => {
    switch (fn.v) {
      case "func": {
        const result = fn.decl.fact.results[i];
        return result ? { v: "value", type: result, file: fn.decl.file } : UNKNOWN;
      }
      case "type":
        // A conversion: one result, of that type.
        return { v: "value", type: fn.type, file: fn.file };
      case "value": {
        const under = underlying(fn.type, fn.file);
        if (under === "external") return EXTERNAL_ASSUMED;
        if (!under || under.type.k !== "func") return UNKNOWN;
        const result = under.type.results[i];
        return result ? { v: "value", type: result, file: under.file } : UNKNOWN;
      }
      case "external":
        // A method of a non-generic type from outside the tree returns types
        // declared outside it: a standard-library interface where that is
        // known (`r.Context()`), otherwise a type nothing here examined.
        return fn.interfaceResults?.includes(i) ? { v: "outside-interface" } : EXTERNAL_ASSUMED;
      case "interface-method":
        // `w.Header()` on an `http.ResponseWriter`: the standard library cannot
        // name a project type, so the result's type is declared outside the
        // tree — which type, nothing here examined.
        return fn.outside ? EXTERNAL_ASSUMED : UNKNOWN;
      default:
        return UNKNOWN;
    }
  };

  const elementOf = (x: Val, which: "elem" | "key"): Val => {
    if (x.v === "external") return EXTERNAL_ASSUMED;
    if (x.v !== "value") return UNKNOWN;
    const under = underlying(x.type, x.file);
    if (under === "external") return EXTERNAL_ASSUMED;
    if (!under) return UNKNOWN;
    const t = under.type;
    let inner: GoType | null = null;
    // The FIRST value of a range: a map's key — and a channel's element,
    // which is all a range over a channel yields.
    if (which === "key") inner = t.k === "map" ? t.key : t.k === "chan" ? t.elem : null;
    else if (t.k === "list" || t.k === "map" || t.k === "chan") inner = t.elem;
    return inner ? { v: "value", type: inner, file: under.file } : UNKNOWN;
  };

  function evaluate(expr: GoExpr, file: FileCtx, depth: number): Val {
    if (depth > MAX_EVAL_DEPTH) return UNKNOWN;
    step();
    switch (expr.e) {
      case "typed":
        return { v: "value", type: expr.type, file };
      case "name": {
        const imported = importsOf(file)?.get(expr.name);
        if (imported) return { v: "package", target: imported };
        // A name the package itself declares is that declaration whatever the
        // file imports: Go allows no name in both the file and package scope.
        const own = scopeMember(file.pkg, expr.name, file, "same-package", depth);
        if (own) return own;
        // A dot import puts another package's names in this file's scope.
        const dots = dotImportsOf(file);
        if (!dots) {
          // An import block too long to read: the name may be one of its own.
          budgetHit = true;
          return UNKNOWN;
        }
        for (const target of dots) {
          step();
          const hit =
            target.t === "project"
              ? scopeMember(target.pkg, expr.name, file, "package", depth)
              : null;
          if (hit) return hit;
        }
        // Nothing in scope declares it. That is decisive only when the caller's
        // whole package was read and no dot import could have brought it in. A
        // build-ignored file is run with whichever of its ignored siblings the
        // command names (`go run gen.go gen_helpers.go`), so beside another one
        // its package is not known in full either.
        return {
          v: "undeclared",
          decided:
            dots.length === 0 &&
            !incompleteDirs.has(file.dir) &&
            (file.facts.buildIgnored !== true || ignoredInDir.get(file.dir) === 1),
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
      case "indexed":
        // What is indexed; {@link decideIndexed} says what calling it means.
        return evaluate(expr.x, file, depth + 1);
      default:
        return UNKNOWN;
    }
  }

  const unbound = (reason: GoUnboundReason): GoCallVerdict => ({
    kind: "unbound",
    reason,
  });

  /**
   * The verdict for an INDEXED callee `x[…](…)`, from what `x` is: a declared
   * function is a generic one given its type argument, and is the callee; a
   * type converts; a value has one of its elements called. For a member of a
   * package outside the tree nothing says which — a generic function or an
   * element of a variable — so it is only assumed external.
   */
  const decideIndexed = (val: Val, x: GoExpr, file: FileCtx): GoCallVerdict => {
    switch (val.v) {
      case "func":
        if (val.held) return unbound("func-value");
        return { kind: "bound", qualifiedName: val.decl.fact.qualifiedName, via: val.via };
      case "type":
        return unbound("conversion");
      case "value":
        return unbound("func-value");
      case "external":
      case "external-func":
        return unbound("external-assumed");
      case "ambiguous":
        return unbound("ambiguous");
      case "unknown":
        if (x.e === "name" && visible(file.pkg.vars, x.name, file, file.pkg.dir)) {
          return unbound("func-value");
        }
        return { kind: "unknown" };
      default:
        return { kind: "unknown" };
    }
  };

  /** The verdict for what a callee expression evaluated to. */
  const decide = (val: Val, callee: GoExpr, file: FileCtx): GoCallVerdict => {
    if (callee.e === "indexed") return decideIndexed(val, callee.x, file);
    // A function read out of a variable: the call goes through the value.
    if ("held" in val && val.held) return unbound("func-value");
    switch (val.v) {
      case "func":
        return {
          kind: "bound",
          qualifiedName: val.decl.fact.qualifiedName,
          via: val.via,
        };
      case "external":
        return unbound(val.assumed ? "external-assumed" : "external");
      case "external-func":
        // A package-level VARIABLE of a func type (`flag.Usage`) is called
        // through its value, whatever was assigned to it.
        if (isGoStdlibFuncVar(val.path, val.name)) return unbound("func-value");
        return unbound("external");
      case "outside-interface":
        // An interface value is not callable; nothing is decided.
        return { kind: "unknown" };
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
        if (callee.e === "name" && visible(file.pkg.vars, callee.name, file, file.pkg.dir)) {
          return unbound("func-value");
        }
        return { kind: "unknown" };
    }
  };

  return {
    resolveCall(filePath: string, callee: GoExpr): GoCallVerdict {
      const file = ctxByFile.get(filePath);
      if (!file) return { kind: "unknown" };
      if (callee.e === "local") return unbound("func-value");
      if (callee.e === "local-type") return unbound("conversion");
      if (callee.e !== "name" && callee.e !== "sel" && callee.e !== "indexed") {
        return { kind: "unknown" };
      }
      callSteps = 0;
      budgetHit = false;
      view = file.isTest ? file.dir : null;
      let val: Val;
      try {
        val = evaluate(callee, file, 0);
      } catch (err) {
        if (err !== CALL_OVER_BUDGET) throw err;
        return { kind: "unknown", why: "budget" };
      }
      const verdict = decide(val, callee, file);
      // Undecided BECAUSE a budget ran out is said so: the caller counts it.
      return verdict.kind === "unknown" && budgetHit ? { kind: "unknown", why: "budget" } : verdict;
    },
  };
}
