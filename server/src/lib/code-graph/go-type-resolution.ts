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
 * import path only ends like a directory — one segment of it or five, since
 * only a directory holding the WHOLE path says which package is meant; and two
 * imports that would bind the same local name.
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
 * Pure: no I/O. Bounded in DEPTH, in WORK and in what it RETAINS, which are
 * three different things — a depth cap with a `seen` set still let one call
 * look through every embedded field of every type it could reach, and every
 * call do it again; and keeping the answer per type, as a copy, made memory
 * types × members.
 *
 *  - Depth. One call's evaluation carries ONE depth counter through every
 *    re-entry (a selection, a call result, a package variable's initialiser),
 *    so a cycle of package variables ends at {@link MAX_EVAL_DEPTH} like any
 *    other chain. An expression is a chain — every node has one operand — so
 *    that depth is also its number of steps. Type lookups (aliases, defined
 *    types, embeddings) are a separate recursion capped at {@link MAX_DEPTH}.
 *  - Work. Whatever depends only on the DECLARATIONS is worked out once per
 *    resolver and kept: what a type name means in a file, a type's struct, the
 *    types its promotion search goes through, what an import path names, which
 *    declarations a viewer may see. A call then costs its own length, and the
 *    whole tree costs declarations plus calls. Nothing kept depends on the
 *    order calls arrive in.
 *  - Retained size. What is kept for a type is a list of REFERENCES to the
 *    types it embeds, layer by layer — never a copy of their members — and
 *    for an interface a list of the interfaces it embeds, never a copy of
 *    their names. Both lists are capped by a property of the type alone
 *    ({@link GO_TYPE_LAYER_BUDGET}, {@link GO_TYPE_RETAINED_PER_MEMBER},
 *    {@link GO_TYPE_RETAINED_MAX}), so
 *    the whole resolver retains an amount linear in the source and the calls.
 *    A struct's fields are read once per DECLARATION and shared by every type
 *    that is that struct underneath. {@link GoResolver.retained} counts every
 *    structure kept ({@link GO_RESOLVER_CACHES} is the audit), and each is
 *    created through a helper that counts it. (A flattened table per type
 *    aborted the process on 650 KB of Go, and a copy of a struct's fields per
 *    defined type on 2.15 MB, inside every budget below: a heap abort cannot
 *    be caught — PR #1104 review cycles 4 and 5. Ingest keeps a heap watchdog
 *    as the last resort, `GO_BINDING_MAX_HEAP_GROWTH` in `ingest.ts`.)
 *  - Placing. Finding a directory's module, an import's most specific module,
 *    and — with no `go.mod` — the directory an import path is spelled like,
 *    each cost the LENGTH of that path, through indices built once: scanning
 *    the modules or the directories instead made one call cost imports ×
 *    directories (PR #1104, review cycle 3). A file's import block is read
 *    whole, or — longer than {@link GO_CALL_STEP_BUDGET} imports — not at all.
 *  - Budgets. What is left is counted: {@link GO_CALL_STEP_BUDGET} steps for
 *    one call, {@link GO_TYPE_STEP_BUDGET} for one type's layers, and what a
 *    type may keep. Past any of them the answer is `unknown` with
 *    `why: "budget"` — counted by the caller, never a guess. Ingest adds a
 *    ceiling on the whole step (`GO_BINDING_MAX_MS` in `ingest.ts`).
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
   * {@link GO_CALL_STEP_BUDGET} or {@link GO_TYPE_STEP_BUDGET} allow, or
   * needed a type to keep more than it may ({@link GO_TYPE_LAYER_BUDGET}) —
   * not because the source leaves it open. The caller counts these.
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
  /**
   * The step budgets, when not the defaults ({@link GO_CALL_STEP_BUDGET},
   * {@link GO_TYPE_STEP_BUDGET}). Ingest never sets them; the tests do, to pin
   * what counts as a step on a tree of a dozen lines instead of a hundred
   * thousand.
   */
  budgets?: {
    callSteps?: number;
    typeSteps?: number;
    /** {@link GO_TYPE_LAYER_BUDGET}, for the layers of a type's members. */
    layerTypes?: number;
    /** {@link GO_TYPE_LAYER_BUDGET}, for the interfaces one interface's method set reaches. */
    interfaceTypes?: number;
    /** {@link GO_TYPE_RETAINED_PER_MEMBER}. */
    retainedPerMember?: number;
    /** {@link GO_TYPE_RETAINED_MAX}. */
    retainedMax?: number;
  };
}

/**
 * What a resolver holds between calls, in ENTRIES — one reference or one map
 * entry each — for everything whose size depends on what a type REACHES and
 * not only on what it declares. Exposed so that a test can pin retained size
 * across two tree sizes without reading the heap.
 */
export interface GoResolverRetained {
  /** Types a member table was worked out for. */
  tables: number;
  /** Types listed in the layers of those tables (and in a table's depth index). */
  layerTypes: number;
  /** Names in the name index of a table wide enough to keep one. */
  indexedNames: number;
  /** Names answered through the layers of a table with no index, each kept once. */
  askedNames: number;
  /** Interfaces listed in the method sets of the interfaces asked about. */
  interfaceLayers: number;
  /** Types refused a table because keeping it would pass what the type may retain. */
  overRetained: number;
  /** The sum of the entry counts above. */
  entries: number;
  /**
   * EVERY structure the resolver holds between calls, by cache
   * ({@link GO_RESOLVER_CACHES}): one count per map entry, set member or list
   * element. The figures above are the part whose size depends on what a type
   * reaches; this is all of it, including what is built from the declarations
   * up front. A cache cannot be left out: each is created through one helper
   * that counts it, and `go-resolver-type-forms.test.ts` fails on a `new Map`
   * or `new Set` in this file that goes round it.
   */
  caches: Record<GoResolverCache, number>;
  /** The sum of {@link caches}: linear in the source and the calls resolved. */
  total: number;
}

/**
 * The caches of a resolver — the audit of what it retains, kept where the
 * code is. For each: what it is keyed by, what an entry holds, and its bound.
 * "Declared" is a count of things WRITTEN in the source, so every bound here
 * is O(source size) or O(calls resolved); none is a product of two of them.
 *
 * | cache | keyed by | an entry holds | bound |
 * | --- | --- | --- | --- |
 * | `packages` | directory, package clause, file path | a package, a file context, a directory | files + packages + directories |
 * | `declarations` | package and declared name (methods: and receiver; test methods: and directory); twins also by file | a reference to the declaration's facts | 2 × declarations + test methods |
 * | `placing` | `go.mod` directory or module path; directory; one trie node per path segment of a directory outside every module | a module, or a trie node | modules + directories + their path segments |
 * | `imports` | importing module and import path; per file, the local import name | what the path names (one small object) | 3 × import statements |
 * | `typeNames` | file and a type name as SPELLED in that file's declarations or calls | the declaration it names (references) | 2 × type mentions in the source |
 * | `typeInfos` | declared type and whether the viewer sees its test files | references: declaration, shared struct, methods map | 2 × declared types |
 * | `structs` | struct DECLARATION | its field names → field facts (references), and the types it embeds | 1 + fields + embedded fields, per struct declaration — shared by every defined type over it |
 * | `interfaces` | declared interface and view | its own method names, and the interfaces it embeds | 2 × (1 + declared methods + declared embeds) |
 * | `interfaceSets` | declared interface and view | references to the interfaces in reach | 2 × (1 + min(reach, {@link GO_TYPE_LAYER_BUDGET})) per interface asked about |
 * | `memberTables` | type asked about and view | one table object | 2 × types a call selects from |
 * | `layers` | (in a table) | references to the types a promotion search goes through, twice, and their depth index | 4 × max({@link GO_TYPE_LAYER_BUDGET}, min({@link GO_TYPE_RETAINED_MAX}, {@link GO_TYPE_RETAINED_PER_MEMBER} × members the type declares ITSELF)) per table |
 * | `indexedNames` | (in a table wider than the layer budget) member name | what it selects | min({@link GO_TYPE_RETAINED_MAX}, {@link GO_TYPE_RETAINED_PER_MEMBER} × members the type declares itself) |
 * | `askedNames` | (in a table) a member name a call selected | what it selects | one per name per call resolved |
 *
 * Not caches, and so not here: the per-call scratch sets marked `transient`
 * where they are created, which die with the call or the build that made them.
 */
export const GO_RESOLVER_CACHES = [
  "packages",
  "declarations",
  "placing",
  "imports",
  "typeNames",
  "typeInfos",
  "structs",
  "interfaces",
  "interfaceSets",
  "memberTables",
  "layers",
  "indexedNames",
  "askedNames",
] as const;

export type GoResolverCache = (typeof GO_RESOLVER_CACHES)[number];

/** A `Map` that reports each NEW key, so that no cache is held uncounted. */
class KeptMap<K, V> extends Map<K, V> {
  private readonly note: () => void;
  constructor(note: () => void) {
    super();
    this.note = note;
  }
  override set(key: K, value: V): this {
    if (!super.has(key)) this.note();
    return super.set(key, value);
  }
}

/** A `Set` that reports each NEW member ({@link KeptMap}). */
class KeptSet<T> extends Set<T> {
  private readonly note: () => void;
  constructor(note: () => void) {
    super();
    this.note = note;
  }
  override add(value: T): this {
    if (!super.has(value)) this.note();
    return super.add(value);
  }
}

export interface GoResolver {
  /** Decide the callee of one call made in `filePath`. */
  resolveCall(filePath: string, callee: GoExpr): GoCallVerdict;
  /** What the resolver holds so far ({@link GoResolverRetained}). */
  retained(): GoResolverRetained;
  /**
   * {@link GoResolverRetained.total} alone, kept as a running sum: reading it
   * allocates nothing, so a caller may read it before every call (ingest's
   * heap watchdog does, to notice growth between two of its samples).
   */
  retainedTotal(): number;
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
 * Most steps working out ONE type's layers may take: a step is one type, one
 * member a type declares (a field, a method, an interface method — counted,
 * not read) or one embedding followed. That is work proportional to the
 * declarations the type reaches, done once per type — not once per call,
 * which is what made a file of K types each embedding K others cost
 * calls × fields (PR #1104, review cycle 2). A type that reaches more than
 * this (no hand-written Go comes near it) has NO member decided: every call
 * selecting from it is `{ kind: "unknown", why: "budget" }`, at the cost of
 * one lookup.
 */
export const GO_TYPE_STEP_BUDGET = 100_000;

/**
 * Most types the LAYERS of one type may list — the types a promotion search
 * goes through — for the type to be answered by walking them, and most
 * interfaces one interface's method set may reach. Sixty-four embedded types
 * in reach is far past hand-written Go; what it buys is that a lookup costs at
 * most that many steps and a type keeps at most that many references, whatever
 * the types it reaches declare.
 */
export const GO_TYPE_LAYER_BUDGET = 64;

/**
 * A type with MORE layer types than {@link GO_TYPE_LAYER_BUDGET} is answered
 * through an index of its member names instead — one step a lookup however
 * wide a layer is — and may keep that index only while it pays for it: no more
 * layer types, and no more member names, than this many times the members the
 * type DECLARES ITSELF (its fields, embedded ones included, and its methods)
 * — and never more than {@link GO_TYPE_RETAINED_MAX}, whatever it declares.
 * A struct that embeds two hundred others is wide because it says so, two
 * hundred times; a one-line struct that reaches two hundred types through
 * somebody else's embeddings is not, and is left undecided.
 *
 * Together the two make what the resolver retains LINEAR in the source: at
 * most {@link GO_TYPE_LAYER_BUDGET} references for each type asked about, plus
 * twice this many entries for each member a type declares, plus one entry for
 * each distinct (type, name) a call selects. Before them a member table was a
 * flattened copy per type — types × members — and 650 KB of Go exhausted a
 * 4 GB heap, inside every step budget (PR #1104 review cycle 4). A type past
 * both has NO member decided: every call selecting from it is
 * `{ kind: "unknown", why: "budget" }`. That is a property of the type, so it
 * is the same whatever was asked first.
 */
export const GO_TYPE_RETAINED_PER_MEMBER = 16;

/**
 * The ABSOLUTE cap on {@link GO_TYPE_RETAINED_PER_MEMBER}'s allowance: no
 * table lists more layer types, or indexes more member names, than this —
 * however many members the type declares itself. Past it the type has no
 * member decided (`{ kind: "unknown", why: "budget" }`), like any other type
 * over its allowance.
 *
 * Without it the allowance was bounded only by the source, and fields are
 * cheap to write (PR #1104 review cycle 6, real walker and resolver):
 *
 *  - `struct{ W; a0 … a1999 int; N *T }` earned a 32,000-name index, 5 MB a
 *    table; one call `t.N.N.N.N.N.F()` builds six tables, so 160 calls ended
 *    the process (`JavaScript heap out of memory`) between two samples of
 *    ingest's heap watchdog;
 *  - 24,000 types `struct{ W; a0 … a7 int }` over a `W` embedding 133 structs
 *    kept a 143-name index each: 560 MB from 2.1 MB of Go, 1,091 MB with test
 *    callers, 2,333 MB with forty fields (about 150 B a name, per type).
 *
 * 64 — the layer budget itself — because nothing real was found to need more
 * and nothing larger met the memory target. Measured: the widest table in
 * Miniflux (421 files, 21,106 calls) lists 8 layer types and the widest in
 * about 4,200 files of Go's own toolchain and standard library (470,000
 * calls) lists 4; none passes 64, so none has ever kept a name index, and the
 * cap leaves eight times the widest real table. An indexed table costs about
 * 150 B a name PER TYPE, so any cap above the layer budget lets N types keep
 * N indexes: at 128 the shape above, re-tuned to the cap, still retains 443 MB
 * at 24,000 types (857 MB with test callers). At 64 the three trees retain
 * 40, 49 and 71 MB, and re-tuned to sit exactly at the cap 90, 149 and 121 MB
 * (176 MB for forty fields with test callers).
 * The cost: a type whose promotion search reaches more than 64 types is
 * undecided even where it declares the embeddings itself. With this default
 * the name index is not reached at all; it remains for a caller that raises
 * both budgets.
 *
 * The worst ONE call can make the tables retain is therefore a constant: a
 * callee is at most {@link MAX_EVAL_DEPTH} (64) selections, each a table of
 * at most 64 layer types (4 entries each) and 64 names — 64 × 322 = 20,608
 * entries, about 1.5 MB (150 B a name, 50 B a layer entry), a third of a
 * percent of the watchdog's 512 MB; measured, a call through sixty types at
 * the cap keeps 9,098 entries, 0.24 MB. What is NOT a constant is the first
 * reading of the DECLARATIONS a call reaches — a struct's field index, built
 * once per declaration: about 60 B a declared member, less than the parsed
 * facts already held for it, and never repeated.
 */
export const GO_TYPE_RETAINED_MAX = 64;

/**
 * Predeclared identifiers. A bare call to one that the package does not itself
 * declare is a builtin or a conversion to a basic type — never a project symbol.
 */
// constant: not a cache
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
// constant: not a cache
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

/**
 * One struct DECLARATION, read once and shared by reference: by the type that
 * declares it, by every defined type over it (`type A B`) and by every viewer.
 */
type StructInfo = {
  fields: GoFieldFact[];
  file: FileCtx;
  byName: Map<string, GoFieldFact>;
  /**
   * Lazily resolved: the project types the struct embeds, in source order, up
   * to the first that is not a project type this module can see into (`blind`).
   */
  embeds?: { list: ProjectNamed[]; blind: boolean };
};

const NO_EMBEDS: NonNullable<StructInfo["embeds"]> = { list: [], blind: false };
// constant: not a cache
const NO_DIRS: ReadonlySet<string> = new Set<string>();

/** What a composite type is underneath: the type itself, or what a defined type is defined as. */
type Underlying = { type: GoType; file: FileCtx } | "external" | null;

/** One project type's own declaration, read once: its struct (through `type A B`) and its methods. */
interface TypeInfo {
  decl: Decl<GoTypeFact> | null;
  struct: StructInfo | "external" | null;
  methods: Map<string, Decls<GoFuncFact>> | undefined;
}

/**
 * The members one project type has — its own and the promoted ones — by Go's
 * shallowest-depth rule.
 *
 * What is kept per type is its LAYERS: the types a promotion search goes
 * through, depth by depth. A layer is a list of references — each embedded
 * type's own declarations are read where they are, never copied into the type
 * that embeds it. (Copying them made resolver memory types × members: 11,000
 * types embedding one 3,000-field struct, 650 KB of Go, exhausted a 4 GB heap
 * — PR #1104 review cycle 4.) A name is then answered by walking the layers
 * and asking each type of a layer for it, and the answer is kept for the names
 * that were asked ({@link MemberTable.asked}).
 *
 * A type whose whole member set is small beside what it DECLARES ITSELF keeps
 * that set as one table as well ({@link MemberTable.names}): a lookup is then
 * one step however many types a layer holds. See {@link GO_TYPE_RETAINED_BASE}.
 *
 * `rest` is what any name not found selects: unknown where promotion ran into
 * a type this module cannot see into (or ran out), an interface method where
 * the type is an interface.
 */
interface MemberTable {
  /** The types the search goes through, by depth, down to the level it ended at. */
  layers: ProjectNamed[][];
  /** {@link layers}, as each type is declared. */
  infos: TypeInfo[][];
  /** How many types {@link layers} holds. */
  layerCount: number;
  /**
   * Every member name → what it selects and the depth that was decided at, as
   * a file that is NOT a test of any package involved sees it. Null when the
   * type may not keep that many ({@link GO_TYPE_RETAINED_BASE}): names are then
   * answered one by one, through the layers.
   */
  names: Map<string, MemberHit> | null;
  /** The names asked of a table with no {@link names}, each answered once. */
  asked: Map<string, MemberHit | null> | null;
  rest: Val;
  /** The depth the search ended at because types there answer to ANY name, and which types. */
  wildcardLevel: { depth: number; holders: string[]; indices: number[] } | null;
  /**
   * Nothing about the type's members is decided: working them out passed
   * {@link GO_TYPE_STEP_BUDGET} (`steps`), or keeping them would pass what the
   * type may retain (`retained`).
   */
  overBudget?: "steps" | "retained";
  /** Lazily built: package id and type name → the depth of that type in {@link layers}. */
  layerOf?: Map<string, number>;
}

/** What a member name selects, and the promotion depth it was decided at. */
interface MemberHit {
  val: Val;
  depth: number;
}

/** A project interface as it is declared: its own method names and what it embeds. */
interface InterfaceInfo {
  own: ReadonlySet<string>;
  /** The project interfaces it embeds directly. */
  embeds: ProjectNamed[];
  /** It embeds something that is not a project type (`io.Reader`, `error`, a union). */
  blind: boolean;
}

/**
 * An interface's method set, as LAYERS too: the interface and the interfaces
 * it reaches by embedding, each holding its own names. Nothing is copied into
 * the embedder — a name set per interface was interfaces × names along a chain
 * of embeddings, 2.3 GB for 8,000 of them (PR #1104 review cycle 4).
 */
interface InterfaceSet {
  members: InterfaceInfo[];
  /** Names the members declare, summed — what reading the set costs. */
  size: number;
  /**
   * Not known in full: something in reach is not a project interface, or the
   * chain is longer than {@link MAX_DEPTH}, or reaches more interfaces than
   * {@link GO_TYPE_LAYER_BUDGET}. The set may then hold any name.
   */
  open: boolean;
}

/** One segment of the index of directories no `go.mod` covers, read from the END of their paths. */
interface DirSuffixNode {
  kids: Map<string, DirSuffixNode>;
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
  const incompleteDirs = options.incompleteDirs ?? NO_DIRS;
  const callStepBudget = options.budgets?.callSteps ?? GO_CALL_STEP_BUDGET;
  const typeStepBudget = options.budgets?.typeSteps ?? GO_TYPE_STEP_BUDGET;
  const layerBudget = options.budgets?.layerTypes ?? GO_TYPE_LAYER_BUDGET;
  const interfaceBudget = options.budgets?.interfaceTypes ?? GO_TYPE_LAYER_BUDGET;
  const retainedPerMember = options.budgets?.retainedPerMember ?? GO_TYPE_RETAINED_PER_MEMBER;
  const retainedMax = options.budgets?.retainedMax ?? GO_TYPE_RETAINED_MAX;

  // ── What the resolver holds, counted where it is created ─────────────────
  //
  // Every Map, Set and list that outlives a call is made through `keptMap`,
  // `keptSet` or counted with `keep`, under the cache it belongs to
  // ({@link GO_RESOLVER_CACHES}). A counter written for the structures someone
  // thought of does not see the next one: `retained()` read 48,000 entries
  // while a per-type copy of a struct's fields held 2.6 GB (PR #1104 review
  // cycle 5).
  const cacheSizes = Object.fromEntries(GO_RESOLVER_CACHES.map((c) => [c, 0])) as Record<
    GoResolverCache,
    number
  >;
  /** The sum of {@link cacheSizes}, kept as it moves ({@link GoResolver.retainedTotal}). */
  let keptTotal = 0;
  const keep = (cache: GoResolverCache, entries = 1): void => {
    cacheSizes[cache] += entries;
    keptTotal += entries;
  };
  // One counting function per cache, shared by every map of it: a closure per
  // map would itself be a per-type allocation.
  const noteOf = Object.fromEntries(
    GO_RESOLVER_CACHES.map((c) => [
      c,
      (): void => {
        cacheSizes[c] += 1;
        keptTotal += 1;
      },
    ]),
  ) as Record<GoResolverCache, () => void>;
  const keptMap = <K, V>(cache: GoResolverCache): Map<K, V> => new KeptMap<K, V>(noteOf[cache]);
  const keptSet = <T>(cache: GoResolverCache): Set<T> => new KeptSet<T>(noteOf[cache]);
  const pkgs = keptMap<string, Pkg>("packages");
  /**
   * Directory → the packages the go tool builds there (normally one, plus an
   * external `_test` one). A `//go:build ignore` file is in none of them.
   */
  const pkgsByDir = keptMap<string, Pkg[]>("packages");
  /** Every directory holding a Go file, build-ignored ones included. */
  const goDirs = keptSet<string>("packages");
  /** Directory → how many `//go:build ignore` files it holds. */
  const ignoredInDir = keptMap<string, number>("packages");
  const ctxByFile = keptMap<string, FileCtx>("packages");
  /**
   * Directory → method name → the receivers a `_test.go` file of that
   * directory declares a method of that name on (by package id and type name).
   * One entry per such declaration: what a test caller's view of a type can
   * differ by ({@link viewMember}).
   */
  const testMethods = keptMap<string, Map<string, Map<string, { pkg: Pkg; receiver: string }>>>(
    "declarations",
  );

  const add = <T>(map: Map<string, Decls<T>>, key: string, decl: Decl<T>): void => {
    let decls = map.get(key);
    if (!decls) {
      decls = { all: [], nonTest: [] };
      map.set(key, decls);
    }
    decls.all.push(decl);
    if (!decl.file.isTest) decls.nonTest.push(decl);
    keep("declarations", decl.file.isTest ? 1 : 2);
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
        types: keptMap("declarations"),
        funcs: keptMap("declarations"),
        methods: keptMap("declarations"),
        vars: keptMap("declarations"),
      };
      pkgs.set(key, pkg);
      if (!f.facts.buildIgnored) {
        const list = pkgsByDir.get(dir);
        if (list) list.push(pkg);
        else pkgsByDir.set(dir, [pkg]);
        keep("packages");
      }
    }
    const ctx: FileCtx = {
      filePath: f.filePath,
      dir,
      pkg,
      isTest: f.isTest,
      facts: f.facts,
      named: keptMap("typeNames"),
      underlying: keptMap("typeNames"),
    };
    ctxByFile.set(f.filePath, ctx);
    for (const t of f.facts.types) add(pkg.types, t.name, { fact: t, file: ctx });
    for (const fn of f.facts.funcs) {
      if (fn.receiver) {
        let ofType = pkg.methods.get(fn.receiver);
        if (!ofType) {
          ofType = keptMap("declarations");
          pkg.methods.set(fn.receiver, ofType);
        }
        add(ofType, fn.name, { fact: fn, file: ctx });
        if (f.isTest) {
          let inDir = testMethods.get(dir);
          if (!inDir) testMethods.set(dir, (inDir = keptMap("declarations")));
          let ofName = inDir.get(fn.name);
          if (!ofName) inDir.set(fn.name, (ofName = keptMap("declarations")));
          ofName.set(`${pkg.id}\u0000${fn.receiver}`, { pkg, receiver: fn.receiver });
        }
      } else add(pkg.funcs, fn.name, { fact: fn, file: ctx });
    }
    for (const v of f.facts.vars) add(pkg.vars, v.name, { fact: v, file: ctx });
  }

  // The `go.mod` files, by where they sit and by what they declare — so that
  // placing a directory or an import path costs the length of that path, never
  // the number of modules (a tree of 24,000 `go.mod` files took 1.2 s to build
  // a resolver for and 7.7 s to resolve, PR #1104 review cycle 3).
  const moduleAtDir = keptMap<string, GoModule>("placing");
  const modulesByPath = keptMap<string, GoModule[]>("placing");
  for (const m of modules) {
    if (!moduleAtDir.has(m.dir)) moduleAtDir.set(m.dir, m);
    const same = modulesByPath.get(m.path);
    if (same) same.push(m);
    else modulesByPath.set(m.path, [m]);
    keep("placing");
  }

  /** Directory → the `go.mod` nearest above it (the module the directory belongs to), or null. */
  const moduleOfDir = keptMap<string, GoModule | null>("placing");
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
    if (callSteps > callStepBudget) throw CALL_OVER_BUDGET;
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
  const orphanDirs = keptSet<string>("placing");
  for (const d of goDirs) if (moduleOf(d) === null) orphanDirs.add(d);

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
    const root: DirSuffixNode = { kids: keptMap("placing"), dir: null };
    for (const d of orphanDirs) {
      if (d === "") continue;
      const segs = d.split("/");
      let node = root;
      for (let i = segs.length - 1; i >= 0; i -= 1) {
        let next = node.kids.get(segs[i]);
        if (!next) {
          next = { kids: keptMap("placing"), dir: null };
          node.kids.set(segs[i], next);
        }
        node = next;
      }
      node.dir = d;
    }
    orphanSuffixes = root;
    return root;
  };

  /**
   * An import path with no module to place it — the importing file is in no
   * `go.mod`'s tree — placed by GO'S OWN LOOKUP RULE for such a file, and by
   * nothing else. A project directory D is the path P's package only when D
   * holds the WHOLE path and sits where Go would look for it:
   *
   *  (a) `<prefix>/src/P` — the directory directly above P's first segment is
   *      named `src` — and the importing file lies beneath that `src`: both
   *      are then in one GOPATH workspace. (A `src` the importer is NOT under
   *      is some directory of that name: `src/appstats/` inside the package
   *      `example.org/legacy` is `example.org/legacy/src/appstats`, and was
   *      bound for the dependency `appstats` until the importer was asked
   *      for — found by moving the corpus directory, cycle 7.)
   *  (b) `<prefix>/vendor/P`, and the importing file lies beneath `<prefix>`:
   *      Go applies a vendor directory to the code under its parent only;
   *  (c) `P` from the tree root, and P's first segment has a dot in it
   *      (`example.org/…`, `github.com/…`). A domain as the first directory is
   *      the evidence that the tree root is itself a GOPATH `src`.
   *
   * Exactly one such directory binds. Two are undecided. A directory that
   * holds the whole path anywhere else, and a directory the path merely ends
   * in (a PROPER TAIL of it), are undecided too — never external, since the
   * tree root may be the package root and the directory the very package
   * meant. With nothing matched at all the path is outside the tree — unless
   * Go code sits at the tree root, whose import path is the unknown module
   * path itself.
   *
   * The rule has no clause for a depth or a number of segments, on purpose.
   * Three times "one directory ends in the path" bound a dependency's call to
   * a project function, and each fix was cut to the reported shape: a
   * two-segment tail (`pkg/errors/` for `github.com/pkg/errors`, PR #1104
   * review cycle 5), one segment below the root (`internal/appengine/` for
   * `appengine`, cycle 6), then one segment AT the root, with the same guess
   * still bound for `internal/appengine/datastore` (cycle 7). The type checker
   * says external for all of them.
   *
   * {@link spellingScoped} is set when the answer depended on where the
   * importer is — (a) and (b) both ask — so that it is not kept for other
   * files. The cost is the importer's depth times the path's length.
   */
  let spellingScoped = false;
  const bySpelling = (importPath: string, importerDir: string): ImportTarget => {
    const segs = importPath.split("/");
    // `tail`: a directory that IS a proper tail of the import path.
    // `node`: the directories that end in the WHOLE import path.
    let tail = false;
    let node: DirSuffixNode | undefined = orphanSuffixIndex();
    for (let i = segs.length - 1; i >= 0 && node; i -= 1) {
      node = node.kids.get(segs[i]);
      if (node?.dir && i > 0) tail = true;
    }
    if (node) {
      // Where Go would look. More than one place is undecided, so the count
      // is all that is kept past two.
      let found = 0;
      let dir = "";
      const anySrc = node.kids.has("src");
      const anyVendor = node.kids.has("vendor");
      if (anySrc || anyVendor) {
        spellingScoped = true;
        // Every directory the importer lies beneath, the tree root included.
        // `lastIndexOf` answers -1 above the first directory; the root is 0.
        for (
          let end = importerDir.length;
          ;
          end = Math.max(0, importerDir.lastIndexOf("/", end - 1))
        ) {
          const above = importerDir.slice(0, end);
          const prefix = end > 0 ? `${above}/` : "";
          const vendored = `${prefix}vendor/${importPath}`;
          if (anyVendor && orphanDirs.has(vendored)) {
            found += 1;
            dir = vendored;
          }
          const inSrc = `${prefix}${importPath}`;
          if (anySrc && (above === "src" || above.endsWith("/src")) && orphanDirs.has(inSrc)) {
            found += 1;
            dir = inSrc;
          }
          if (end <= 0) break;
        }
      }
      if (node.dir !== null && segs[0].includes(".")) {
        found += 1;
        dir = node.dir;
      }
      return found === 1 && !tail ? inDir(dir) : UNKNOWN_IMPORT;
    }
    if (tail) return UNKNOWN_IMPORT;
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
  const importTargets = keptMap<GoModule | null, Map<string, ImportTarget>>("imports");

  /**
   * What an import path names FROM `importer`: a project package, a package
   * outside the tree, or neither known.
   */
  const resolveImport = (importPath: string, importer: FileCtx): ImportTarget => {
    const own = moduleOf(importer.dir);
    let ofModule = importTargets.get(own);
    if (!ofModule) {
      ofModule = keptMap("imports");
      importTargets.set(own, ofModule);
    }
    const known = ofModule.get(importPath);
    if (known) return known;
    spellingScoped = false;
    const target = resolveImportOnce(importPath, own, importer.dir);
    // An answer that depended on the importer's own directory (a vendor
    // directory in a tree with no `go.mod`) is that file's alone; the file
    // keeps it ({@link importsOf}).
    if (!spellingScoped) ofModule.set(importPath, target);
    return target;
  };

  const resolveImportOnce = (
    importPath: string,
    own: GoModule | null,
    importerDir: string,
  ): ImportTarget => {
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
    const spelled = bySpelling(importPath, importerDir);
    // A file INSIDE a module is built in module mode, where no import is ever
    // looked up in a GOPATH: a directory outside every `go.mod` is not what
    // its import names, wherever it sits. Undecided rather than external —
    // the directory is there, and what build sees it is not known.
    return own && spelled.t === "project" ? UNKNOWN_IMPORT : spelled;
  };

  /**
   * Whether a file's import block is read at all. Its imports are resolved
   * together, the first time a call needs one — work the size of the block,
   * done inside that call. A block longer than one call's whole step budget
   * is not read: the file's imports then name nothing, for every call alike
   * and whatever order calls arrive in, and a call that needed them is
   * undecided (`why: "budget"`). No hand-written file comes near it.
   */
  const importsReadable = (ctx: FileCtx): boolean => ctx.facts.imports.length <= callStepBudget;

  /** Local import name → target, for a file whose imports are read ({@link importsReadable}); else null. */
  const importsOf = (ctx: FileCtx): Map<string, ImportTarget> | null => {
    if (ctx.imports) return ctx.imports;
    if (!importsReadable(ctx)) return null;
    const out = keptMap<string, ImportTarget>("imports");
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
    const seen = new Set<Pkg>(); // transient: this call only
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
    keep("imports", out.length);
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
      decls.byFile = keptMap("declarations");
      for (const d of decls.all) {
        const list = decls.byFile.get(d.file);
        if (list) list.push(d);
        else decls.byFile.set(d.file, [d]);
      }
      keep("declarations", decls.all.length);
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

  /** Struct declaration → its fields by name, read ONCE ({@link StructInfo}). */
  const structInfos = keptMap<Decl<GoTypeFact>, StructInfo>("structs");

  /**
   * The fields of one struct DECLARATION. There is one of these per
   * declaration, and every type that is that struct underneath — the type
   * itself, each `type A B` over it, each viewer — holds a reference to it.
   * (A copy per defined type was types × fields: 111 KB for each of N types
   * over one 3,000-field struct, a heap abort from 2.15 MB of Go — PR #1104
   * review cycle 5.)
   */
  const structOf = (decl: Decl<GoTypeFact>): StructInfo => {
    const known = structInfos.get(decl);
    if (known) return known;
    const fields = decl.fact.fields ?? [];
    const byName = keptMap<string, GoFieldFact>("structs");
    // The first field of a name is the one a selector reaches.
    for (const f of fields) if (!byName.has(f.name)) byName.set(f.name, f);
    const info: StructInfo = { fields, file: decl.file, byName };
    structInfos.set(decl, info);
    return info;
  };

  /** The struct fields a type has, following `type A B` to B's struct. */
  const structAt = (named: ProjectNamed, depth: number): StructInfo | "external" | null => {
    const decl = typeDecl(named);
    if (!decl || depth > MAX_DEPTH) return null;
    if (decl.fact.form === "struct") return structOf(decl);
    if (decl.fact.form !== "defined" || !decl.fact.target) return null;
    const under = resolveNamed(decl.fact.target, decl.file, depth + 1);
    if (under.n === "external") return "external";
    return under.n === "project" ? structAt(under, depth + 1) : null;
  };

  /** Package id and type name: one declared type, whoever looks. */
  const typeId = (named: ProjectNamed): string => `${named.pkg.id}\u0000${named.name}`;

  /** Package id, type name and who is looking → what the type declares, read once. */
  const typeInfos = keptMap<string, TypeInfo>("typeInfos");
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

  // ── What the resolver keeps between calls, counted ───────────────────────
  //
  // Every figure is a number of ENTRIES held for the life of the resolver, so
  // a test can pin what a tree makes it retain without reading the heap.
  const kept = {
    tables: 0,
    layerTypes: 0,
    indexedNames: 0,
    askedNames: 0,
    interfaceLayers: 0,
    overRetained: 0,
  };

  const interfaceInfos = keptMap<string, InterfaceInfo | null>("interfaces");

  /** A project interface's own declaration, read once; null for a type that is not one. */
  const interfaceInfo = (named: ProjectNamed): InterfaceInfo | null => {
    const key = typeKey(named);
    const known = interfaceInfos.get(key);
    if (known !== undefined) return known;
    const decl = typeDecl(named);
    let info: InterfaceInfo | null = null;
    if (decl?.fact.form === "interface") {
      const embeds: ProjectNamed[] = [];
      const seen = new Set<string>(); // transient: this declaration's own embeds
      let blind = false;
      for (const embedded of decl.fact.embeds ?? []) {
        const inner = embedded ? resolveNamed(embedded, decl.file, 0) : UNKNOWN_NAMED;
        if (inner.n !== "project") {
          blind = true;
          continue;
        }
        const id = typeId(inner);
        if (seen.has(id)) continue;
        seen.add(id);
        embeds.push(inner);
      }
      const own = keptSet<string>("interfaces");
      for (const method of decl.fact.methods ?? []) own.add(method);
      keep("interfaces", embeds.length);
      info = { own, embeds, blind };
    }
    interfaceInfos.set(key, info);
    return info;
  };

  const interfaceSets = keptMap<string, InterfaceSet>("interfaceSets");

  /**
   * The method set of a project interface: itself and the interfaces it
   * reaches by embedding — all at the interface's own depth, as Go has it —
   * each still holding its own names. What is kept per interface is that list
   * of references, capped: a chain longer than {@link MAX_DEPTH}, or more than
   * {@link GO_TYPE_LAYER_BUDGET} interfaces in reach, is not followed further
   * and the set is `open`. So is one that embeds anything that is not a
   * project interface this module can read (`io.Reader`, `error`, a union).
   */
  const interfaceSet = (start: ProjectNamed): InterfaceSet => {
    const key = typeKey(start);
    const known = interfaceSets.get(key);
    if (known) return known;
    const members: InterfaceInfo[] = [];
    let open = false;
    let size = 0;
    const seen = new Set<string>([typeId(start)]); // transient: at most the interface budget
    let level: ProjectNamed[] = [start];
    for (let depth = 0; level.length > 0; depth += 1) {
      const next: ProjectNamed[] = [];
      for (const named of level) {
        const info = interfaceInfo(named);
        if (!info) {
          open = true;
          continue;
        }
        members.push(info);
        size += info.own.size;
        if (info.blind) open = true;
        for (const inner of info.embeds) {
          const id = typeId(inner);
          if (seen.has(id)) continue;
          if (depth >= MAX_DEPTH || seen.size >= interfaceBudget) {
            open = true;
            break;
          }
          seen.add(id);
          next.push(inner);
        }
      }
      level = next;
    }
    // Too large to read in budget: it may hold any name.
    if (size > typeStepBudget) open = true;
    const out: InterfaceSet = { members, size, open };
    interfaceSets.set(key, out);
    kept.interfaceLayers += members.length;
    keep("interfaceSets", members.length);
    return out;
  };

  const interfaceHas = (set: InterfaceSet, name: string): boolean => {
    for (const member of set.members) if (member.own.has(name)) return true;
    return false;
  };

  const ownStruct = (info: TypeInfo): StructInfo | null =>
    info.struct && info.struct !== "external" ? info.struct : null;

  /** How many members a type declares ITSELF: its fields, its methods, an interface's method set. */
  const ownSize = (named: ProjectNamed, info: TypeInfo): number =>
    (ownStruct(info)?.byName.size ?? 0) +
    (info.methods?.size ?? 0) +
    (info.decl?.fact.form === "interface" ? interfaceSet(named).size : 0);

  /**
   * `name` as the type ITSELF declares it — a field, a method, or (an
   * interface) a method of its set — or null. Nothing promoted.
   */
  const ownMember = (named: ProjectNamed, info: TypeInfo, name: string): Val | null => {
    let val: Val | null = null;
    const struct = ownStruct(info);
    const field = struct?.byName.get(name);
    if (struct && field) {
      val = field.type ? { v: "value", type: field.type, file: struct.file } : UNKNOWN;
    }
    const decls = info.methods?.get(name);
    // Methods declared in `_test.go` files are no part of this: they exist for
    // one directory's tests only ({@link viewMember}).
    if (decls && decls.nonTest.length > 0) {
      // A field AND a method of one name cannot be one type: they are twins
      // behind build constraints, and neither is chosen.
      val = field ? AMBIGUOUS : methodVal(decls.nonTest);
    }
    // An interface holds exactly the methods it declares and embeds, each
    // dispatched at run time.
    if (
      val === null &&
      info.decl?.fact.form === "interface" &&
      interfaceHas(interfaceSet(named), name)
    ) {
      val = INTERFACE_METHOD;
    }
    return val;
  };

  /** Every name {@link ownMember} may answer for a type; a name may come up more than once. */
  function* ownNames(named: ProjectNamed, info: TypeInfo): Generator<string> {
    const struct = ownStruct(info);
    if (struct) yield* struct.byName.keys();
    if (info.methods) yield* info.methods.keys();
    if (info.decl?.fact.form === "interface") {
      for (const member of interfaceSet(named).members) yield* member.own;
    }
  }

  /** The types a struct embeds, resolved once: where promotion goes next from it. */
  const embedsOf = (info: TypeInfo): NonNullable<StructInfo["embeds"]> => {
    const struct = ownStruct(info);
    if (!struct) return NO_EMBEDS;
    if (struct.embeds) return struct.embeds;
    const list: ProjectNamed[] = [];
    let blind = false;
    for (const field of struct.fields) {
      if (!field.embedded) continue;
      // An embedded type this module cannot see into may declare any name
      // at this depth, which would win over anything deeper.
      const embedded = field.type ? resolveNamed(field.type, struct.file, 0) : UNKNOWN_NAMED;
      if (embedded.n !== "project") {
        blind = true;
        break;
      }
      list.push(embedded);
    }
    keep("structs", list.length);
    struct.embeds = { list, blind };
    return struct.embeds;
  };

  const memberTables = keptMap<string, MemberTable>("memberTables");

  /** A project type's members: its layers, worked out once per type. */
  const memberTable = (start: ProjectNamed): MemberTable => {
    const key = typeKey(start);
    const known = memberTables.get(key);
    if (known) return known;
    const table = buildMemberTable(start);
    memberTables.set(key, table);
    kept.tables += 1;
    if (table.overBudget === "retained") kept.overRetained += 1;
    kept.layerTypes += table.layerCount;
    kept.indexedNames += table.names?.size ?? 0;
    // `layers` and `infos` hold one reference each per layer type, and the
    // level a search ended at names its holders twice (`holders`, `indices`).
    keep("layers", 2 * table.layerCount + 2 * (table.wildcardLevel?.holders.length ?? 0));
    keep("indexedNames", table.names?.size ?? 0);
    return table;
  };

  /**
   * What a name selects when `count` types of the layer at `depth` declare it
   * themselves: a name one type holds is that member, a name two hold is
   * ambiguous. A type of the layer that answers to ANY name (its members are
   * not known) beside the one that declares it is not a tie but an open
   * question: in Go that compiles only one of them has it, and which is not
   * known here.
   */
  const decideAt = (
    table: MemberTable,
    depth: number,
    count: number,
    holder: number,
    val: Val,
  ): Val => {
    if (count > 1) return AMBIGUOUS;
    const wild = table.wildcardLevel;
    if (wild && wild.depth === depth && wild.indices.some((index) => index !== holder)) {
      return UNKNOWN;
    }
    return val;
  };

  /** Nothing about the type is decided, and nothing is kept for it. */
  const overBudgetTable = (overBudget: NonNullable<MemberTable["overBudget"]>): MemberTable => ({
    layers: [],
    infos: [],
    layerCount: 0,
    names: null,
    asked: null,
    rest: UNKNOWN,
    wildcardLevel: null,
    overBudget,
  });

  /**
   * The layers of a project type: itself, then level by level the types it
   * embeds, down to the first level that ends the search. Building them reads
   * no member — it counts them — so it costs the types and embeddings in
   * reach, never their fields.
   */
  const buildMemberTable = (start: ProjectNamed): MemberTable => {
    const layers: ProjectNamed[][] = [];
    const infoLayers: TypeInfo[][] = [];
    let layerCount = 0;
    const done = (rest: Val, wildcardLevel: MemberTable["wildcardLevel"] = null): MemberTable => ({
      layers,
      infos: infoLayers,
      layerCount,
      names: null,
      asked: null,
      rest,
      wildcardLevel,
    });
    let steps = 0;
    /** What the type may keep as an index of names ({@link GO_TYPE_RETAINED_PER_MEMBER}). */
    let wide = 0;
    let level: ProjectNamed[] = [start];
    const seen = new Set<string>(); // transient: this build only
    for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth += 1) {
      const infos = level.map((named) => typeInfo(named));
      const wildcards: Array<{ index: number; val: Val }> = [];
      for (let i = 0; i < level.length; i += 1) {
        const named = level[i];
        const info = infos[i];
        const own = ownSize(named, info);
        // What the type may keep is measured by what its OWN declaration
        // says. A defined type (`type A B`) has B's fields and wrote none of
        // them: only its methods are its own, so it is never wide on B's
        // account — N one-line types over a struct that embeds two hundred
        // others would each keep two hundred references and an index.
        if (depth === 0) {
          // And never more than the absolute cap, however much it declares:
          // sixteen names for each of 2,000 cheap fields was a 32,000-name
          // index per type ({@link GO_TYPE_RETAINED_MAX}).
          wide = Math.min(
            retainedMax,
            retainedPerMember *
              (info.decl?.fact.form === "defined" ? (info.methods?.size ?? 0) : own),
          );
        }
        // One step for the type and one for each member it declares.
        steps += 1 + own;
        // An interface whose set is not known in full answers to any name; so
        // does a defined type over a type outside the tree.
        if (info.decl?.fact.form === "interface" && interfaceSet(named).open) {
          wildcards.push({ index: i, val: INTERFACE_METHOD });
        }
        const wildcard = wildcardOf(info);
        if (wildcard) wildcards.push({ index: i, val: wildcard });
        if (steps > typeStepBudget) return overBudgetTable("steps");
      }
      layers.push(level);
      infoLayers.push(infos);
      layerCount += level.length;
      // A type of this level that answers to every name ends the search
      // here: a name nobody declares is its member — or, with two such
      // types, one of theirs, which is not known. Nor is it known when
      // ANOTHER type of the level embeds something: a name that type's
      // embedded types declare is theirs in Go wherever the one wildcard does
      // not have it (`struct { Store; Mid }`, `Store` embedding `io.Closer`
      // and `Mid` a type with a method `Log`: `s.Log()` is that method), and
      // whether it has it is exactly what is not known.
      if (wildcards.length > 0) {
        const only = wildcards.length === 1 ? wildcards[0] : null;
        const deeper =
          only !== null &&
          infos.some((info, i) => {
            if (i === only.index) return false;
            const embeds = embedsOf(info);
            return embeds.blind || embeds.list.length > 0;
          });
        return finish(
          done(only !== null && !deeper ? only.val : UNKNOWN, {
            depth,
            holders: wildcards.map((w) => typeId(level[w.index])),
            indices: wildcards.map((w) => w.index),
          }),
          wide,
        );
      }
      // An embedded type this module cannot see into ends it too: nothing
      // deeper is decided.
      for (const info of infos) if (embedsOf(info).blind) return finish(done(UNKNOWN), wide);
      const next: ProjectNamed[] = [];
      for (const info of infos) {
        const embeds = embedsOf(info).list;
        // One step for each embedding followed.
        steps += embeds.length;
        for (const embedded of embeds) {
          const key = typeId(embedded);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(embedded);
          // Already more layer types than the type may keep in either form:
          // the rest of a wide level is not read.
          if (depth < MAX_DEPTH && layerCount + next.length > Math.max(layerBudget, wide)) {
            return overBudgetTable("retained");
          }
        }
      }
      level = next;
    }
    return finish(done(UNKNOWN), wide);
  };

  /**
   * How a type's members are kept, decided from the type alone — never from
   * what was asked first:
   *
   *  - up to {@link GO_TYPE_LAYER_BUDGET} layer types: the layers, and a name
   *    is looked up by walking them;
   *  - more, but no more layer types and no more member names than
   *    {@link GO_TYPE_RETAINED_PER_MEMBER} times what the type declares itself:
   *    an index of every name as well, so a lookup does not walk a wide layer;
   *  - otherwise nothing is kept and nothing about the type is decided.
   */
  const finish = (table: MemberTable, wide: number): MemberTable => {
    if (table.layerCount <= layerBudget) return table;
    // (No more layer types than the allowance either: building them stopped
    // at the first level that would have passed it.)
    const names = indexNames(table, wide);
    return names ? { ...table, names } : overBudgetTable("retained");
  };

  /**
   * Every member name of a table, by the layers' own rule — or null as soon
   * as there are more than `limit`.
   */
  const indexNames = (table: MemberTable, limit: number): Map<string, MemberHit> | null => {
    // counted: `indexedNames`, by memberTable, once the table is kept
    const names = new Map<string, MemberHit>();
    for (let depth = 0; depth < table.layers.length; depth += 1) {
      const level = table.layers[depth];
      const infos = table.infos[depth];
      // Hits at this depth, per name.
      // transient: one depth of one build
      const hits = new Map<string, { count: number; val: Val; holder: number; last: number }>();
      for (let i = 0; i < level.length; i += 1) {
        for (const name of ownNames(level[i], infos[i])) {
          // A shallower member still wins.
          if (names.has(name)) continue;
          const had = hits.get(name);
          if (had?.last === i) continue;
          const val = ownMember(level[i], infos[i], name);
          if (!val) continue;
          if (had) {
            had.count += 1;
            had.last = i;
          } else {
            hits.set(name, { count: 1, val, holder: i, last: i });
            if (names.size + hits.size > limit) return null;
          }
        }
      }
      for (const [name, h] of hits) {
        names.set(name, { val: decideAt(table, depth, h.count, h.holder, h.val), depth });
      }
    }
    return names;
  };

  /** One name looked up through the layers: decided at the shallowest depth that declares it. */
  const walkLayers = (table: MemberTable, name: string): MemberHit | null => {
    for (let depth = 0; depth < table.layers.length; depth += 1) {
      const level = table.layers[depth];
      const infos = table.infos[depth];
      let count = 0;
      let holder = -1;
      let val: Val = UNKNOWN;
      for (let i = 0; i < level.length; i += 1) {
        const own = ownMember(level[i], infos[i], name);
        if (!own) continue;
        if (count === 0) {
          val = own;
          holder = i;
        }
        count += 1;
      }
      if (count > 0) return { val: decideAt(table, depth, count, holder, val), depth };
    }
    return null;
  };

  /** What `name` selects from a table and at which depth; null when no type of its layers declares it. */
  const memberHit = (table: MemberTable, name: string): MemberHit | null => {
    if (table.names) return table.names.get(name) ?? null;
    const asked = (table.asked ??= keptMap<string, MemberHit | null>("askedNames"));
    const known = asked.get(name);
    if (known !== undefined) return known;
    const hit = walkLayers(table, name);
    asked.set(name, hit);
    kept.askedNames += 1;
    return hit;
  };

  const layerOf = (table: MemberTable): Map<string, number> => {
    if (table.layerOf) return table.layerOf;
    const out = keptMap<string, number>("layers");
    for (let depth = 0; depth < table.layers.length; depth += 1) {
      for (const named of table.layers[depth]) {
        const id = typeId(named);
        if (!out.has(id)) out.set(id, depth);
      }
    }
    table.layerOf = out;
    kept.layerTypes += out.size;
    return out;
  };

  /**
   * What `name` selects for a caller built with the `_test.go` files of `dir`,
   * where that DIFFERS from what everybody else sees — else null.
   *
   * The types a promotion search goes through do not depend on who asks — a
   * type that ships cannot embed a test-only one — so the layers stand, and a
   * test file changes them in one way only: the types of ITS directory gain
   * the methods their `_test.go` files declare. Such a method is the member
   * when it sits shallower than what the layers hold for that name; at the
   * same depth the two collide; deeper, it loses.
   *
   * Nothing is kept for it. The receivers a directory's test files declare a
   * method of that name on ({@link testMethods}) are each placed in the layers
   * by one lookup — or, where the layers are fewer than they are, the layers
   * are read instead. Either way a type reached from a thousand test
   * directories is still searched once.
   */
  const viewMember = (table: MemberTable, dir: string, name: string): Val | null => {
    const declared = testMethods.get(dir)?.get(name);
    if (!declared) return null;
    const gain = { depth: -1, count: 0, decls: [] as Decl<GoFuncFact>[], holder: "" };
    const consider = (pkg: Pkg, receiver: string, depth: number): void => {
      const decls = pkg.methods.get(receiver)?.get(name);
      if (!decls || decls.all.length === decls.nonTest.length) return;
      if (gain.count === 0 || depth < gain.depth) {
        gain.depth = depth;
        gain.count = 1;
        gain.decls = decls.all;
        gain.holder = `${pkg.id}\u0000${receiver}`;
      } else if (depth === gain.depth) gain.count += 1;
    };
    if (declared.size <= table.layerCount) {
      const depths = layerOf(table);
      for (const [id, { pkg, receiver }] of declared) {
        const depth = depths.get(id);
        if (depth !== undefined) consider(pkg, receiver, depth);
      }
    } else {
      const seen = new Set<string>(); // transient: this lookup only
      for (let depth = 0; depth < table.layers.length; depth += 1) {
        for (const named of table.layers[depth]) {
          if (named.pkg.dir !== dir) continue;
          const id = typeId(named);
          if (seen.has(id)) continue;
          seen.add(id);
          consider(named.pkg, named.name, depth);
        }
      }
    }
    if (gain.count === 0) return null;
    const held = memberHit(table, name)?.depth;
    // A shallower member still wins.
    if (held !== undefined && held < gain.depth) return null;
    // The same depth already holds the name: the type's own twin, a field
    // of that name, or another embedded type's member.
    if (held === gain.depth) return AMBIGUOUS;
    // Shallower than anything held. Two test-file declarations at that
    // depth are a tie; ANOTHER type there that answers to any name leaves
    // it open.
    const others =
      table.wildcardLevel?.depth === gain.depth
        ? table.wildcardLevel.holders.filter((h) => h !== gain.holder).length
        : 0;
    return gain.count > 1 ? AMBIGUOUS : others > 0 ? UNKNOWN : methodVal(gain.decls);
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
    if (view !== null) {
      const differs = viewMember(table, view, name);
      if (differs) return differs;
    }
    return memberHit(table, name)?.val ?? table.rest;
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
    retainedTotal: () => keptTotal,
    retained(): GoResolverRetained {
      let total = 0;
      for (const cache of GO_RESOLVER_CACHES) total += cacheSizes[cache];
      return {
        ...kept,
        entries: kept.layerTypes + kept.indexedNames + kept.askedNames + kept.interfaceLayers,
        caches: { ...cacheSizes },
        total,
      };
    },
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
