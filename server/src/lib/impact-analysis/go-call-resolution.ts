/**
 * #791 — bind a Go project's unresolved `calls` edges to the function they reach,
 * for impact analysis only.
 *
 * The Go parser records a method declaration (`func (s *Storage)
 * SetEntriesStatus(…)`) as a plain `function` and a call through a struct field
 * (`h.store.SetEntriesStatus(…)`) by its bare callee name, so the ingest-time
 * resolver (`code-graph/call-resolution.ts`) has no method to bind it to and
 * leaves `toSymbolId` null. On Miniflux v2.3.3 that is 16.5k of 21.7k call
 * edges, including every call from an HTTP handler into `internal/storage`. The
 * impact blast radius and the schema crossing walk only resolved edges, so the
 * Fever and Google Reader handlers that change an entry's status never appeared.
 *
 * The rule is Go's own visibility rule, so it binds only on evidence: a callee
 * named `X` is a candidate when it is declared in the caller's package (same
 * directory) or in a package the caller's package imports (an import path that
 * ends in the candidate's directory). The edge binds only when exactly one
 * candidate remains; an ambiguous name stays unresolved. A test file is never a
 * candidate for a non-test caller.
 *
 * Pure: the loader below reads the rows, {@link resolveGoCalls} decides.
 */
import type { PrismaClient } from "@prisma/client";
import { isTestFilePath } from "../code-graph/call-resolution.js";

/** A Go function or method that a call can reach. */
export interface GoCallable {
  id: string;
  /** Simple name — the segment after the last `::`. */
  name: string;
  filePath: string;
}

/** A `calls` edge the ingest left unresolved (`toSymbolId` null). */
export interface UnresolvedGoCall {
  fromSymbolId: string;
  /** The caller's file — the edge's own `filePath`. */
  filePath: string;
  /** The callee as the parser recorded it: `SetEntriesStatus`, or `pkg.Name`. */
  toQualifiedName: string;
}

/** An `imports` edge: `filePath` imports the Go package at `importPath`. */
export interface GoImport {
  filePath: string;
  importPath: string;
}

/** A call edge bound by {@link resolveGoCalls}. */
export interface ResolvedGoCall {
  fromSymbolId: string;
  toSymbolId: string;
}

/** The directory of a repo-relative path (`""` at the root). */
export function goPackageDir(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? "" : filePath.slice(0, i);
}

/** The callee's simple name: `h.store.Save` / `storage.Save` → `Save`. */
function calleeName(toQualifiedName: string): string {
  const i = toQualifiedName.lastIndexOf(".");
  return i === -1 ? toQualifiedName : toQualifiedName.slice(i + 1);
}

/** True when a package at `dir` is reachable through `importPath`. */
function importReaches(importPath: string, dir: string): boolean {
  return dir.length > 0 && (importPath === dir || importPath.endsWith(`/${dir}`));
}

/**
 * Bind each unresolved call to its single visible candidate. Calls with no
 * candidate, or with more than one, are dropped — never guessed.
 */
export function resolveGoCalls(
  calls: readonly UnresolvedGoCall[],
  callables: readonly GoCallable[],
  imports: readonly GoImport[],
): ResolvedGoCall[] {
  const byName = new Map<string, GoCallable[]>();
  for (const c of callables) {
    const list = byName.get(c.name);
    if (list) list.push(c);
    else byName.set(c.name, [c]);
  }
  // Imports are per file in Go, but a package's files share one namespace for
  // the fields a call goes through (`h.store` is declared in handler.go and
  // called from every other file of the package), so pool them per directory.
  const importsByDir = new Map<string, string[]>();
  for (const imp of imports) {
    const dir = goPackageDir(imp.filePath);
    const list = importsByDir.get(dir);
    if (list) list.push(imp.importPath);
    else importsByDir.set(dir, [imp.importPath]);
  }

  const out: ResolvedGoCall[] = [];
  for (const call of calls) {
    const candidates = byName.get(calleeName(call.toQualifiedName));
    if (!candidates) continue;
    const callerDir = goPackageDir(call.filePath);
    const callerIsTest = isTestFilePath(call.filePath);
    const visible = importsByDir.get(callerDir) ?? [];
    const matches = candidates.filter((c) => {
      if (c.id === call.fromSymbolId) return false;
      if (!callerIsTest && isTestFilePath(c.filePath)) return false;
      const dir = goPackageDir(c.filePath);
      return dir === callerDir || visible.some((p) => importReaches(p, dir));
    });
    if (matches.length === 1) {
      out.push({ fromSymbolId: call.fromSymbolId, toSymbolId: matches[0].id });
    }
  }
  return out;
}

type GoResolutionPrisma = Pick<PrismaClient, "codeSymbol" | "codeEdge">;

/**
 * Load a project's Go call graph gap and resolve it. Returns `[]` for a project
 * with no Go functions, without reading any edge.
 */
export async function loadResolvedGoCalls(
  prisma: GoResolutionPrisma,
  projectId: string,
  opts?: {
    /**
     * Read only the unresolved calls to these callee names (#1034). The Go parser
     * stores the bare field name, so this is an exact match on `toQualifiedName`.
     * Left out, every unresolved call is read, as impact analysis does. The
     * DECISION is the same either way: ambiguity is judged over the candidates
     * of a name, which are still all loaded, never over the calls.
     */
    calleeNames?: readonly string[];
  },
): Promise<ResolvedGoCall[]> {
  if (opts?.calleeNames?.length === 0) return [];
  const symbols = await prisma.codeSymbol.findMany({
    where: { projectId, language: "go", kind: { in: ["function", "method"] } },
    select: { id: true, qualifiedName: true, filePath: true },
  });
  if (symbols.length === 0) return [];
  const callables: GoCallable[] = symbols.map((s) => {
    const i = s.qualifiedName.lastIndexOf("::");
    return {
      id: s.id,
      name: i === -1 ? s.qualifiedName : s.qualifiedName.slice(i + 2),
      filePath: s.filePath,
    };
  });

  const [callRows, importRows] = await Promise.all([
    prisma.codeEdge.findMany({
      where: {
        projectId,
        kind: "calls",
        toSymbolId: null,
        filePath: { endsWith: ".go" },
        ...(opts?.calleeNames ? { toQualifiedName: { in: [...opts.calleeNames] } } : {}),
      },
      select: { fromSymbolId: true, filePath: true, toQualifiedName: true },
    }),
    prisma.codeEdge.findMany({
      where: { projectId, kind: "imports", filePath: { endsWith: ".go" } },
      select: { filePath: true, toQualifiedName: true },
    }),
  ]);
  const calls: UnresolvedGoCall[] = [];
  for (const r of callRows) {
    if (r.toQualifiedName) {
      calls.push({
        fromSymbolId: r.fromSymbolId,
        filePath: r.filePath,
        toQualifiedName: r.toQualifiedName,
      });
    }
  }
  const imports: GoImport[] = [];
  for (const r of importRows) {
    if (r.toQualifiedName) imports.push({ filePath: r.filePath, importPath: r.toQualifiedName });
  }
  return resolveGoCalls(calls, callables, imports);
}

/** Ids or names per `IN (…)` list: SQLite binds at most 999 variables per statement. */
const SCOPED_IN_CHUNK = 500;
/** Directory prefixes per `OR` list. */
const SCOPED_OR_CHUNK = 100;

/**
 * #1060 — the resolvable Go calls OUT OF the given symbols, reading only what
 * decides them. {@link loadResolvedGoCalls} reads every Go function, every
 * unresolved call and every import of the project and resolves them all in one
 * synchronous pass: 4.8 s on a 1M-call-edge project, which a request thread
 * cannot afford. A walk from a dozen retrieved symbols needs the calls out of
 * its frontier, the functions that carry one of THEIR callee names, and the
 * imports of THEIR packages: three narrow reads, decided by
 * {@link resolveGoCalls} as before.
 *
 * The result equals the whole-project resolution filtered by caller: ambiguity
 * is judged over every candidate of a name (all loaded, by name) and the
 * imports of the caller's package (all loaded, by directory).
 *
 * Candidates are read by the symbol's `name` column and compared, as everywhere
 * else, by the tail of `qualifiedName`. The Go parser writes `<file>::<name>`,
 * so the two are the same string (23,633 of 23,633 Go functions in the #706
 * run-7 database).
 */
export async function loadResolvedGoCallsFrom(
  prisma: GoResolutionPrisma,
  projectId: string,
  fromSymbolIds: readonly string[],
): Promise<ResolvedGoCall[]> {
  if (fromSymbolIds.length === 0) return [];
  const calls: UnresolvedGoCall[] = [];
  for (let i = 0; i < fromSymbolIds.length; i += SCOPED_IN_CHUNK) {
    // "Unresolved" is checked on the rows, not in the query: with `toSymbolId:
    // null` in the WHERE, SQLite walked its `(toSymbolId, kind)` index — every
    // unresolved call of the project, 110 ms per read on 1M call edges — where
    // `(fromSymbolId, kind)` reaches the callers' few rows directly.
    const rows = await prisma.codeEdge.findMany({
      where: {
        projectId,
        kind: "calls",
        fromSymbolId: { in: fromSymbolIds.slice(i, i + SCOPED_IN_CHUNK) },
        filePath: { endsWith: ".go" },
      },
      select: { fromSymbolId: true, toSymbolId: true, filePath: true, toQualifiedName: true },
    });
    for (const r of rows) {
      if (!r.toSymbolId && r.toQualifiedName) {
        calls.push({
          fromSymbolId: r.fromSymbolId,
          filePath: r.filePath,
          toQualifiedName: r.toQualifiedName,
        });
      }
    }
  }
  if (calls.length === 0) return [];

  const names = [...new Set(calls.map((c) => calleeName(c.toQualifiedName)))].sort();
  const callables: GoCallable[] = [];
  for (let i = 0; i < names.length; i += SCOPED_IN_CHUNK) {
    const rows = await prisma.codeSymbol.findMany({
      where: {
        projectId,
        language: "go",
        kind: { in: ["function", "method"] },
        name: { in: names.slice(i, i + SCOPED_IN_CHUNK) },
      },
      select: { id: true, qualifiedName: true, filePath: true },
    });
    for (const s of rows) {
      const at = s.qualifiedName.lastIndexOf("::");
      callables.push({
        id: s.id,
        name: at === -1 ? s.qualifiedName : s.qualifiedName.slice(at + 2),
        filePath: s.filePath,
      });
    }
  }
  if (callables.length === 0) return [];

  // Imports pool per package directory, so read the files under each caller's
  // directory. `startsWith` also returns the files of its sub-packages; they
  // need no filtering here, because `resolveGoCalls` pools imports by the exact
  // directory of the importing file and looks up the caller's.
  const dirs = [...new Set(calls.map((c) => goPackageDir(c.filePath)))].sort();
  const imports: GoImport[] = [];
  for (let i = 0; i < dirs.length; i += SCOPED_OR_CHUNK) {
    const rows = await prisma.codeEdge.findMany({
      where: {
        projectId,
        kind: "imports",
        filePath: { endsWith: ".go" },
        OR: dirs
          .slice(i, i + SCOPED_OR_CHUNK)
          .map((d) => ({ filePath: { startsWith: d === "" ? "" : `${d}/` } })),
      },
      select: { filePath: true, toQualifiedName: true },
    });
    for (const r of rows) {
      if (r.toQualifiedName) imports.push({ filePath: r.filePath, importPath: r.toQualifiedName });
    }
  }
  return resolveGoCalls(calls, callables, imports);
}
