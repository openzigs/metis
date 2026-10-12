/**
 * #1071 — what the Go type resolver knows about the standard library without
 * reading it: which import paths ARE the standard library, which of its
 * exported types are interfaces, and which members of its concrete types are
 * typed as one.
 *
 * All three are positive lists on purpose. The resolver records a call as
 * `external` (decided: no project callee) only on positive evidence, so "this
 * path is the standard library" must be a fact, not a guess from the path's
 * shape — a tree without a `go.mod` can hold a project directory named
 * `errors` or `http`. And a method called on a value of a standard-library
 * INTERFACE type (`http.Handler`, `io.Writer`) is dispatched at run time to
 * whatever implements it, very often a project type, so that call is
 * `interface` (undecided), never `external` — including when the interface
 * value is reached through a standard-library member: `resp.Body.Close()`,
 * `srv.Handler.ServeHTTP(w, r)`, `r.Context().Done()`.
 *
 * ## Where the lists come from
 *
 * They are GENERATED from a Go toolchain, for the release named by
 * {@link GO_STDLIB_VERSION}: `node scripts/gen-go-stdlib-snapshot.mjs` runs
 * `go list std` and type-checks the standard library, then writes
 * `go-stdlib.snapshot.json` (the facts) and `go-stdlib.data.ts` (the same
 * facts as constants). A test compares the two and the Go version in both
 * (`tests/lib/code-graph/go-stdlib-snapshot.test.ts`), so a hand edit of
 * either fails; no test and no build step runs Go. The interface list is
 * COMPLETE for that release — every exported interface type — which is what
 * lets a method on any other standard-library type be called `external`: a
 * type that is not an interface declares its own methods.
 *
 * ## What a missing entry costs
 *
 * The lists describe one Go release. Source written for a NEWER one can name
 * what they lack:
 *
 *  - a missing PACKAGE (a path added to the standard library since) is treated
 *    like any import outside the tree's modules. Under a `go.mod` that is
 *    still `external`. Only in a tree with Go code outside every `go.mod` can
 *    it be matched to a project directory whose path is, or ends in, that
 *    import path — a wrong binding, and the one reason to regenerate promptly;
 *  - a missing INTERFACE (or interface-typed member) makes a call through it
 *    `external` where it should be `interface`. Nothing is bound wrongly, but
 *    the verdict is decided, so no later reader looks for the project type
 *    that implements it: an edge is lost.
 *
 * Regenerate when the Go release the project's sources target moves on.
 */
import {
  GO_STDLIB_INTERFACE_MEMBERS,
  GO_STDLIB_INTERFACE_TYPES,
  GO_STDLIB_INTERFACE_VARS,
  GO_STDLIB_PACKAGE_LIST,
  GO_STDLIB_SNAPSHOT_VERSION,
} from "./go-stdlib.data.js";

/** The Go release the lists describe, as the toolchain names it (`go1.26.0`). */
export const GO_STDLIB_VERSION = GO_STDLIB_SNAPSHOT_VERSION;

/** The cgo pseudo-package: `import "C"` names no directory, in the tree or out of it. */
export const GO_CGO_PSEUDO_PACKAGE = "C";

/** Standard-library import paths, plus the cgo pseudo-package. */
export const GO_STDLIB_PACKAGES: ReadonlySet<string> = new Set([
  GO_CGO_PSEUDO_PACKAGE,
  ...GO_STDLIB_PACKAGE_LIST,
]);

const split = (names: string): string[] => names.split(" ").filter(Boolean);

const INTERFACE_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  GO_STDLIB_INTERFACE_TYPES.map(([path, names]) => [path, new Set(split(names))]),
);

/** True when `importPath.typeName` is an exported standard-library interface type. */
export function isGoStdlibInterface(importPath: string, typeName: string): boolean {
  return INTERFACE_SETS.get(importPath)?.has(typeName) ?? false;
}

/**
 * A member of a standard-library concrete type that is typed as a
 * standard-library interface: a field holding one, or a method whose results
 * at `results` are one.
 */
export type GoStdlibInterfaceMember =
  { kind: "field" } | { kind: "method"; results: readonly number[] };

function parseMember(token: string): [string, GoStdlibInterfaceMember] {
  const open = token.indexOf("(");
  if (open === -1) return [token, { kind: "field" }];
  const results = token
    .slice(open + 1, -1)
    .split(",")
    .map((n) => Number.parseInt(n, 10));
  return [token.slice(0, open), { kind: "method", results }];
}

const INTERFACE_MEMBERS: ReadonlyMap<
  string,
  ReadonlyMap<string, GoStdlibInterfaceMember>
> = new Map(
  GO_STDLIB_INTERFACE_MEMBERS.map(([type, members]) => [
    type,
    new Map(split(members).map(parseMember)),
  ]),
);

/**
 * What `member` of the standard-library type `importPath.typeName` is, when it
 * is typed as a standard-library interface (`net/http`, `Response`, `Body`);
 * undefined for every other member.
 */
export function goStdlibInterfaceMember(
  importPath: string,
  typeName: string,
  member: string,
): GoStdlibInterfaceMember | undefined {
  return INTERFACE_MEMBERS.get(`${importPath}.${typeName}`)?.get(member);
}

const INTERFACE_VARS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  GO_STDLIB_INTERFACE_VARS.map(([path, names]) => [path, new Set(split(names))]),
);

/** True when `importPath.name` is a package-level variable typed as a standard-library interface (`io.Discard`). */
export function isGoStdlibInterfaceVar(importPath: string, name: string): boolean {
  return INTERFACE_VARS.get(importPath)?.has(name) ?? false;
}
