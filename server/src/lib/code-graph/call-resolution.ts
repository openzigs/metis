/**
 * Issue #17 — binding a `calls`/`references` edge's textual target to a symbol.
 *
 * The parsers record a call by its bare callee name (`arr.join(",")` → `"join"`).
 * Resolving that name to "the one project symbol called `join`" is how every
 * `.join()` in this repository became a caller of a local `join` method
 * (in-degree 2,922), and `.trim()`, `.test()`, `vi.mock()` and `beforeEach()`
 * crowded genuinely central symbols out of the Code Overview's top table.
 *
 * The rule here is **no binding without evidence**:
 *
 *  - A **bare** call (`foo()`) binds to a same-file definition (lexical
 *    shadowing), then to a unique match in a file this file imports, then — only
 *    for names that are neither language/runtime or test-framework globals nor
 *    imported from the standard library or a test framework
 *    (`import { join } from "node:path"`), and only within the same language
 *    family — to the project's single TOP-LEVEL declaration of that name.
 *  - A **member** call (`x.foo()`) never uses that project-wide fallback, because
 *    uniqueness of a method name says nothing about the type of `x`:
 *      - `this.foo()` / `self.foo()` — the enclosing file, then imported files.
 *      - `Foo.bar()` where `Foo` is a project class — a member of that class.
 *      - `mod.bar()` where `mod` names a project module (file stem, or the Go
 *        package directory) — that module's top-level `bar`.
 *      - any other receiver — a *method* of the same name in this file or an
 *        imported one, unless the name is a built-in prototype method (`join`,
 *        `trim`, `test`, `get`, …), which is never bound on an unknown receiver.
 *      - a receiver that is itself a runtime/test global (`Math`, `JSON`, `vi`,
 *        `console`, …) is never bound.
 *
 * Everything unresolved keeps `toSymbolId = null` and its `toQualifiedName`, so
 * "who calls X" tools still see the textual reference.
 */

/** `receiver` value for a member call whose receiver is not a plain identifier. */
export const COMPLEX_RECEIVER = "<expr>";

/** Receivers that denote the enclosing instance/class. */
const SELF_RECEIVERS = new Set(["this", "self", "cls", "super", "base"]);

/**
 * Bare names that are runtime / standard-library / test-framework globals in at
 * least one supported language. A bare call to one of these is never bound to a
 * project symbol by project-wide name uniqueness — only by a same-file definition
 * or an explicit import.
 */
export const GLOBAL_CALL_NAMES: ReadonlySet<string> = new Set([
  // JS/TS runtime
  "require",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
  "fetch",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "atob",
  "btoa",
  "alert",
  "confirm",
  "prompt",
  "eval",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Object",
  "Array",
  "Date",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "RegExp",
  "Proxy",
  "URL",
  "URLSearchParams",
  "Buffer",
  "AbortController",
  "TextEncoder",
  "TextDecoder",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "Blob",
  "File",
  "Event",
  "CustomEvent",
  "ReadableStream",
  "WritableStream",
  // Test frameworks (vitest / jest / mocha / jasmine / testing-library / playwright)
  "describe",
  "it",
  "test",
  "expect",
  "suite",
  "context",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "before",
  "after",
  "xit",
  "xdescribe",
  "fit",
  "fdescribe",
  "render",
  "renderHook",
  "screen",
  "waitFor",
  "within",
  "fireEvent",
  "act",
  "cleanup",
  // Python builtins
  "print",
  "len",
  "range",
  "str",
  "int",
  "float",
  "bool",
  "list",
  "dict",
  "tuple",
  "set",
  "isinstance",
  "issubclass",
  "getattr",
  "setattr",
  "hasattr",
  "open",
  "super",
  "enumerate",
  "zip",
  "sorted",
  "reversed",
  "min",
  "max",
  "sum",
  "any",
  "all",
  "abs",
  "round",
  "repr",
  "type",
  "iter",
  "next",
  "map",
  "filter",
  // Go builtins
  "make",
  "new",
  "append",
  "cap",
  "copy",
  "delete",
  "panic",
  "recover",
  "close",
]);

/**
 * Receivers that are runtime / standard-library / test-framework namespaces. A
 * member call on one (`Math.max`, `JSON.parse`, `vi.mock`, `console.log`) is
 * never bound to a project symbol.
 */
export const GLOBAL_RECEIVERS: ReadonlySet<string> = new Set([
  "Math",
  "JSON",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Promise",
  "Reflect",
  "Symbol",
  "Date",
  "Intl",
  "Atomics",
  "console",
  "process",
  "Buffer",
  "globalThis",
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "crypto",
  "performance",
  "vi",
  "jest",
  "expect",
  "cy",
  "assert",
  "screen",
  "userEvent",
  "fireEvent",
  "os",
  "sys",
  "re",
  "json",
  "path",
  "fs",
  "logging",
  "fmt",
  "strings",
  "errors",
  "System",
  "Arrays",
  "Collections",
  "Objects",
  "Optional",
  "Collectors",
]);

/**
 * Method names defined by built-in types (JS Array/String/Map/Set/Promise/RegExp/
 * Date/Object, Python str/list/dict, Java Object/String/Collection). A member call
 * with one of these names on a receiver of unknown type is never bound: `x.join()`
 * is overwhelmingly `Array.prototype.join`, not a project method that happens to
 * share the name.
 */
export const BUILTIN_METHOD_NAMES: ReadonlySet<string> = new Set([
  // Array
  "at",
  "concat",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "pop",
  "push",
  "reduce",
  "reduceRight",
  "reverse",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "unshift",
  "values",
  "toSorted",
  "toReversed",
  // String
  "charAt",
  "charCodeAt",
  "codePointAt",
  "endsWith",
  "localeCompare",
  "match",
  "matchAll",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "search",
  "split",
  "startsWith",
  "substring",
  "substr",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
  // Object / Function
  "toString",
  "toLocaleString",
  "valueOf",
  "toJSON",
  "hasOwnProperty",
  "call",
  "apply",
  "bind",
  // Map / Set
  "get",
  "set",
  "has",
  "delete",
  "clear",
  "add",
  // Promise
  "then",
  "catch",
  "finally",
  // RegExp
  "test",
  "exec",
  // Date / Number
  "getTime",
  "toISOString",
  "toFixed",
  // Test-double APIs (vi.fn() / jest.fn() results)
  "mock",
  "mockReturnValue",
  "mockResolvedValue",
  "mockRejectedValue",
  "mockImplementation",
  "mockReset",
  "mockClear",
  // Python str / list / dict
  "append",
  "extend",
  "insert",
  "remove",
  "index",
  "count",
  "copy",
  "items",
  "update",
  "setdefault",
  "format",
  "strip",
  "lstrip",
  "rstrip",
  "startswith",
  "endswith",
  "lower",
  "upper",
  "encode",
  "decode",
  // Java Object / String / Collection
  "equals",
  "hashCode",
  "getClass",
  "length",
  "size",
  "isEmpty",
  "contains",
  "put",
  "stream",
  "collect",
  "iterator",
]);

/** Node.js core modules — importable bare (`"path"`) or prefixed (`"node:path"`). */
const NODE_CORE_MODULES: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

/** Test-framework packages (and package scopes, ending `/`). */
const TEST_FRAMEWORK_PACKAGES = [
  "vitest",
  "jest",
  "@jest/globals",
  "mocha",
  "chai",
  "@playwright/test",
  "@testing-library/",
];

/**
 * True when an import specifier names the runtime's standard library or a test
 * framework (`"node:path"`, `"fs/promises"`, `"vitest"`,
 * `"@testing-library/react"`). A name imported from one of these is by
 * definition not a project symbol, so it is never bound to one by name.
 */
export function isRuntimeOrTestModule(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  const root = spec.split("/")[0];
  if (NODE_CORE_MODULES.has(root)) return true;
  return TEST_FRAMEWORK_PACKAGES.some((p) =>
    p.endsWith("/") ? spec.startsWith(p) : spec === p || spec.startsWith(`${p}/`),
  );
}

/** Language families whose symbols can call one another. */
function languageFamily(language: string): string {
  return language === "ts" || language === "js" ? "js" : language;
}

/**
 * True for paths that hold tests or test infrastructure rather than product code:
 * `*.test.*` / `*.spec.*`, Go `_test.go`, Python `test_*.py` / `*_test.py`, Java
 * `*Test(s).java` / `*IT.java`, and anything under a `test/`, `tests/`,
 * `__tests__/`, `__mocks__/` or `e2e/` directory (which covers Maven's
 * `src/test/`).
 */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  if (/(^|\/)(tests?|__tests__|__mocks__|e2e)\//.test(p)) return true;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /_test\.go$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    /(Tests?|IT)\.java$/.test(base)
  );
}

/** A persisted symbol as the resolver sees it. */
export interface ResolvableSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  kind: string;
  language: string;
}

/** Project-wide indices, built once per ingest after every symbol is persisted. */
export interface ResolutionIndex {
  /** Per file: first definition of each name in that file. */
  fileToNameIndex: Map<string, Map<string, ResolvableSymbol>>;
  /** Per file: first method-capable definition of each name in that file. */
  fileToMemberIndex: Map<string, Map<string, ResolvableSymbol>>;
  /** Every symbol of a given name, project-wide. */
  nameToSymbols: Map<string, ResolvableSymbol[]>;
}

/** The calling side of one edge. */
export interface ResolutionSite {
  filePath: string;
  language: string;
  /** Project files this file's `imports` edges resolved to. */
  importedFiles: string[];
  /**
   * Names this file imports from the runtime's standard library or a test
   * framework ({@link isRuntimeOrTestModule}) — `import { join } from "node:path"`.
   */
  runtimeImports?: ReadonlySet<string>;
}

/**
 * Kinds a member call can land on. Go records receiver methods
 * (`func (s *Server) Start()`) as `function` symbols, so there a function is
 * method-capable too.
 */
function isMemberCapable(sym: ResolvableSymbol): boolean {
  return sym.kind === "method" || (sym.language === "go" && sym.kind === "function");
}

export function createResolutionIndex(): ResolutionIndex {
  return { fileToNameIndex: new Map(), fileToMemberIndex: new Map(), nameToSymbols: new Map() };
}

/** Add one persisted symbol to the indices. First definition per file wins. */
export function indexSymbol(index: ResolutionIndex, sym: ResolvableSymbol): void {
  let byName = index.fileToNameIndex.get(sym.filePath);
  if (!byName) index.fileToNameIndex.set(sym.filePath, (byName = new Map()));
  if (!byName.has(sym.name)) byName.set(sym.name, sym);
  if (isMemberCapable(sym)) {
    let members = index.fileToMemberIndex.get(sym.filePath);
    if (!members) index.fileToMemberIndex.set(sym.filePath, (members = new Map()));
    if (!members.has(sym.name)) members.set(sym.name, sym);
  }
  const bucket = index.nameToSymbols.get(sym.name);
  if (bucket) bucket.push(sym);
  else index.nameToSymbols.set(sym.name, [sym]);
}

/**
 * The unique hit for `name` across `files` in the given per-file index; null when
 * absent or when two different files define it (refuse to guess).
 */
function uniqueAcross(
  files: string[],
  perFile: Map<string, Map<string, ResolvableSymbol>>,
  name: string,
): ResolvableSymbol | null {
  let hit: ResolvableSymbol | null = null;
  for (const fp of files) {
    const cand = perFile.get(fp)?.get(name);
    if (!cand) continue;
    if (hit && hit.id !== cand.id) return null;
    hit = cand;
  }
  return hit;
}

/** `src/lib/api.ts` → `api`; `pkg/util/index.ts` → `util`. */
function moduleStem(filePath: string): string {
  const parts = filePath.split("/");
  const base = parts[parts.length - 1] ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  return stem === "index" || stem === "__init__" ? (parts[parts.length - 2] ?? stem) : stem;
}

/** Go package name convention: the directory the file lives in. */
function parentDirName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 2] ?? "";
}

/**
 * `receiver.name()` where `receiver` names a project class (`AppError.from()`) or a
 * project module (`api.get()` for `api.ts`, `pkg.Run()` for Go package `pkg`).
 * Returns the unique same-language candidate, or null.
 */
function resolveQualifiedReceiver(
  receiver: string,
  name: string,
  site: ResolutionSite,
  index: ResolutionIndex,
): ResolvableSymbol | null {
  const family = languageFamily(site.language);
  const candidates = (index.nameToSymbols.get(name) ?? []).filter((c) => {
    if (languageFamily(c.language) !== family) return false;
    // Static member of a class named `receiver`.
    if (c.qualifiedName.endsWith(`::${receiver}::${name}`)) return true;
    // Top-level symbol of a module named `receiver`.
    if (c.qualifiedName !== `${c.filePath}::${name}`) return false;
    if (moduleStem(c.filePath) === receiver) return true;
    return c.language === "go" && parentDirName(c.filePath) === receiver;
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // Prefer the one the caller actually imports, when that disambiguates.
    const imported = candidates.filter((c) => site.importedFiles.includes(c.filePath));
    if (imported.length === 1) return imported[0];
  }
  return null;
}

/**
 * Resolve an edge's textual target to a symbol id, or null when there is no
 * evidence for any single binding.
 *
 * @param name     the callee / referenced name as the parser recorded it.
 * @param receiver undefined for a bare call or a reference; the receiver
 *                 identifier (`this`, `arr`, `Foo`) for a member call, or
 *                 {@link COMPLEX_RECEIVER} for any other receiver expression.
 */
export function resolveEdgeTarget(
  name: string,
  receiver: string | undefined,
  site: ResolutionSite,
  index: ResolutionIndex,
): string | null {
  if (receiver === undefined) return resolveBare(name, site, index);

  if (SELF_RECEIVERS.has(receiver)) {
    // `super.foo()` is the parent's `foo`, never the overriding one in this file.
    if (receiver !== "super" && receiver !== "base") {
      const local = index.fileToMemberIndex.get(site.filePath)?.get(name);
      if (local) return local.id;
    }
    return uniqueAcross(site.importedFiles, index.fileToMemberIndex, name)?.id ?? null;
  }

  if (receiver !== COMPLEX_RECEIVER) {
    if (GLOBAL_RECEIVERS.has(receiver) || site.runtimeImports?.has(receiver)) return null;
    const qualified = resolveQualifiedReceiver(receiver, name, site, index);
    if (qualified) return qualified.id;
  }

  // Receiver of unknown type.
  if (BUILTIN_METHOD_NAMES.has(name)) return null;
  const local = index.fileToMemberIndex.get(site.filePath)?.get(name);
  if (local) return local.id;
  return uniqueAcross(site.importedFiles, index.fileToMemberIndex, name)?.id ?? null;
}

function resolveBare(name: string, site: ResolutionSite, index: ResolutionIndex): string | null {
  // 1. Same-file definition wins outright — lexical shadowing.
  const local = index.fileToNameIndex.get(site.filePath)?.get(name);
  if (local) return local.id;

  // 2. Unique match across the files this file imports.
  if (site.importedFiles.length) {
    let hit: ResolvableSymbol | null = null;
    for (const fp of site.importedFiles) {
      const cand = index.fileToNameIndex.get(fp)?.get(name);
      if (!cand) continue;
      if (hit && hit.id !== cand.id) return null; // ambiguous across imports
      hit = cand;
    }
    if (hit) return hit.id;
  }

  // 3. Project-wide unique — never for a runtime / test-framework global or a
  //    name this file imports from one, and never across language families.
  if (GLOBAL_CALL_NAMES.has(name) || site.runtimeImports?.has(name)) return null;
  //    Only a TOP-LEVEL, non-method declaration is reachable by a bare name from
  //    another file: a method needs a receiver, a nested helper is not exported.
  const candidates = index.nameToSymbols.get(name);
  if (candidates && candidates.length === 1) {
    const only = candidates[0];
    if (
      languageFamily(only.language) === languageFamily(site.language) &&
      only.kind !== "method" &&
      only.qualifiedName === `${only.filePath}::${only.name}`
    ) {
      return only.id;
    }
  }
  return null;
}
