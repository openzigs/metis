/**
 * Epic #473 / Issue #474 — search_code_graph tool.
 *
 * Queries CodeSymbol/CodeEdge via Prisma to let the agent explore the code
 * graph without receiving full source files. Returns formatted symbol
 * references with file:line locations.
 */
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { describeReceivedKeys } from "./arg-errors.js";
import { prisma } from "../../prisma.js";

const MAX_RESULTS = 30;
/** #740 — cap on the unresolved-callee names listed alongside the results. */
const MAX_UNRESOLVED_NAMES = 20;
/** #774 — cap on the candidate symbols listed when a `calls`/`calledBy` name is ambiguous. */
const MAX_CANDIDATES = 10;
/** #774 — cap on the probable (unresolved) call sites listed for `calls`. */
const MAX_PROBABLE_CALL_SITES = 20;
/** #774 — rows read before the case-sensitive name check; bounds the query on a huge graph. */
const PROBABLE_CALL_SITE_FETCH_CAP = 500;

/** Every filter this tool understands. At least one is required (#774). */
const FILTERS = ["query", "kind", "filePath", "calledBy", "calls"] as const;

/**
 * P0 #774 — the guidance returned instead of running an UNFILTERED query.
 *
 * `search_code_graph` has no *required* parameter, so before #774 an empty args
 * object (the shape #774's parser bug produced from every flat tool call)
 * executed `findMany({ take: 30, orderBy: { qualifiedName: "asc" } })` and handed
 * the agent the same first-30-alphabetical symbols on every call. The agent
 * cannot tell that apart from a real answer, so it treated irrelevant symbols as
 * evidence and reported "no evidence found" for the code that DID exist (#773).
 *
 * An accidental empty call must therefore never produce plausible-looking
 * evidence: it produces a repair message naming the available filters.
 */
function unfilteredGuidance(args: unknown): string {
  return (
    "Error: search_code_graph needs at least one filter — it will not return an " +
    `unfiltered symbol dump. Provide one or more of: ${FILTERS.join(", ")} ` +
    `(${describeReceivedKeys(args)}). ` +
    'Retry with: {"tool":"search_code_graph","args":{"query":"computeSeverity"}} ' +
    "— or use search_code_symbols for a fuzzy/semantic search."
  );
}

/**
 * #740 — describe the `calls` edges from `callerId` whose target the parser could
 * not resolve (NULL `toSymbolId`), so the model knows they exist rather than
 * concluding the function calls nothing. Returns "" when there are none.
 * `toQualifiedName` carries the textual reference for an unresolved edge.
 */
async function describeUnresolvedCallees(callerId: string): Promise<string> {
  const where = { fromSymbolId: callerId, kind: "calls", toSymbolId: null };
  const count = await prisma.codeEdge.count({ where });
  if (count === 0) return "";
  const named = await prisma.codeEdge.findMany({
    where: { ...where, toQualifiedName: { not: null } },
    select: { toQualifiedName: true },
    distinct: ["toQualifiedName"],
    orderBy: { toQualifiedName: "asc" },
    take: MAX_UNRESOLVED_NAMES + 1,
  });
  const names = named.flatMap((e) => (e.toQualifiedName ? [e.toQualifiedName] : []));
  const shown = names.slice(0, MAX_UNRESOLVED_NAMES);
  const more = names.length > MAX_UNRESOLVED_NAMES ? ", …" : "";
  const noun = count === 1 ? "call" : "calls";
  const list = shown.length > 0 ? `: ${shown.join(", ")}${more}` : "";
  return `${count} ${noun} to external or unresolved symbols (not in the code graph)${list}`;
}

const SYMBOL_REF_SELECT = {
  id: true,
  name: true,
  qualifiedName: true,
  kind: true,
  filePath: true,
  startLine: true,
  endLine: true,
  language: true,
} as const;

interface SymbolRef {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}

type Resolution =
  | { kind: "found"; symbol: SymbolRef }
  | { kind: "ambiguous"; candidates: SymbolRef[]; more: boolean }
  | { kind: "none" };

const renderSymbol = (s: Omit<SymbolRef, "id" | "name">): string =>
  `${s.kind} ${s.qualifiedName} — ${s.filePath}:${s.startLine}-${s.endLine} [${s.language}]`;

/**
 * #774 — resolve the symbol a `calls`/`calledBy` filter names. Before #774 this
 * was `findFirst({ qualifiedName: { contains } })`: with three `UpdateFeed`
 * symbols it silently answered for whichever came first, and `updateFeed`
 * (the UI handler) matched the client's `UpdateFeed` because SQLite's
 * `contains` ignores case.
 *
 * Exact matches win: a symbol whose qualified name IS the reference, then the
 * symbols whose bare name is the reference (case-sensitive). Only when there is
 * no exact match does a substring match count, and then a unique `::ref` /
 * `.ref` suffix beats the rest. Anything still matching more than one symbol is
 * reported as ambiguous so the model re-asks with a qualified name, instead of
 * reasoning from an arbitrary pick.
 */
async function resolveNamedSymbol(codeGraphId: string, ref: string): Promise<Resolution> {
  const page = { select: SYMBOL_REF_SELECT, orderBy: { qualifiedName: "asc" as const } };
  const exact: SymbolRef[] = await prisma.codeSymbol.findMany({
    where: { codeGraphId, OR: [{ qualifiedName: ref }, { name: ref }] },
    ...page,
    take: MAX_CANDIDATES + 1,
  });
  // SQLite compares `=` case-sensitively, Postgres too; re-check anyway so the
  // rule does not depend on the database's collation.
  const exactHits = exact.filter((s) => s.qualifiedName === ref || s.name === ref);
  const byQualifiedName = exactHits.filter((s) => s.qualifiedName === ref);
  if (byQualifiedName.length === 1) return { kind: "found", symbol: byQualifiedName[0] };

  let pool = exactHits;
  if (pool.length === 0) {
    const fuzzy: SymbolRef[] = await prisma.codeSymbol.findMany({
      where: { codeGraphId, qualifiedName: { contains: ref } },
      ...page,
      take: MAX_CANDIDATES + 1,
    });
    const suffix = fuzzy.filter(
      (s) => s.qualifiedName.endsWith(`::${ref}`) || s.qualifiedName.endsWith(`.${ref}`),
    );
    pool = suffix.length === 1 ? suffix : fuzzy;
  }
  if (pool.length === 0) return { kind: "none" };
  if (pool.length === 1) return { kind: "found", symbol: pool[0] };
  return {
    kind: "ambiguous",
    candidates: pool.slice(0, MAX_CANDIDATES),
    more: pool.length > MAX_CANDIDATES,
  };
}

/** #774 — the reply for a `calls`/`calledBy` name that matches several symbols. */
function ambiguityMessage(
  filter: "calls" | "calledBy",
  ref: string,
  r: { candidates: SymbolRef[]; more: boolean },
): string {
  const count = r.more ? `more than ${MAX_CANDIDATES}` : String(r.candidates.length);
  return [
    `"${ref}" is ambiguous: it matches ${count} symbols, and ${filter} needs exactly one. ` +
      `Re-run with one of these qualified names, e.g. {"${filter}":"${r.candidates[0].qualifiedName}"}:`,
    ...r.candidates.map(renderSymbol),
    ...(r.more ? ["…"] : []),
  ].join("\n");
}

/**
 * #774 — `calls` edges the parser could not bind (`toSymbolId` NULL) whose
 * textual target names `callee`. A Go call through a receiver or a field
 * (`h.store.UpdateFeed(...)`) is stored as the bare `UpdateFeed` and is mostly
 * unresolved, so following only resolved edges reported "tests only" for
 * functions whose production callers all go through a receiver.
 *
 * They are only PROBABLE call sites — the name could belong to another symbol —
 * so they are labelled as such, with the `filePath:line` the edge records.
 * Restricted to callers in the callee's language. Returns "" when there are none.
 */
async function describeProbableCallSites(
  codeGraphId: string,
  callee: SymbolRef,
  filePath: string | undefined,
): Promise<string> {
  const rows = await prisma.codeEdge.findMany({
    where: {
      codeGraphId,
      kind: "calls",
      toSymbolId: null,
      OR: [{ toQualifiedName: callee.name }, { toQualifiedName: { endsWith: `.${callee.name}` } }],
      fromSymbol: { language: callee.language },
      ...(filePath ? { filePath: { contains: filePath } } : {}),
    },
    select: {
      filePath: true,
      line: true,
      toQualifiedName: true,
      fromSymbol: { select: { qualifiedName: true } },
    },
    orderBy: [{ filePath: "asc" }, { line: "asc" }],
    take: PROBABLE_CALL_SITE_FETCH_CAP,
  });
  // `endsWith` is a case-insensitive LIKE on SQLite; the call must name it exactly.
  const sites = rows.filter(
    (e) => e.toQualifiedName === callee.name || e.toQualifiedName?.endsWith(`.${callee.name}`),
  );
  if (sites.length === 0) return "";
  const total =
    rows.length === PROBABLE_CALL_SITE_FETCH_CAP ? `${sites.length}+` : String(sites.length);
  const shown = sites
    .slice(0, MAX_PROBABLE_CALL_SITES)
    .map((e) => `${e.filePath}:${e.line} in ${e.fromSymbol.qualifiedName}`);
  if (sites.length > MAX_PROBABLE_CALL_SITES) shown.push("…");
  return [
    `Probable (unresolved) call sites (${total}): calls to "${callee.name}" the parser could not ` +
      `bind to a symbol, so they may target ${callee.qualifiedName} or another symbol with that name:`,
    ...shown,
  ].join("\n");
}

export interface SearchCodeGraphArgs {
  query?: string;
  kind?: string;
  filePath?: string;
  calledBy?: string;
  calls?: string;
}

const parameters: JSONSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Substring match against qualifiedName (case-insensitive)",
    },
    kind: {
      type: "string",
      description: "Filter by symbol kind (class, function, method, interface, etc.)",
    },
    filePath: {
      type: "string",
      description: "Filter by file path substring",
    },
    calledBy: {
      type: "string",
      description:
        "Find symbols that are called by the named symbol. Give its qualified name when the bare name is ambiguous.",
    },
    calls: {
      type: "string",
      description:
        "Find symbols that call the named symbol, plus probable call sites the parser could not resolve. Give its qualified name when the bare name is ambiguous.",
    },
  },
};

function validateArgs(args: unknown): SearchCodeGraphArgs {
  if (!args || typeof args !== "object") return {};
  const a = args as Record<string, unknown>;
  return {
    query: typeof a.query === "string" ? a.query : undefined,
    kind: typeof a.kind === "string" ? a.kind : undefined,
    filePath: typeof a.filePath === "string" ? a.filePath : undefined,
    calledBy: typeof a.calledBy === "string" ? a.calledBy : undefined,
    calls: typeof a.calls === "string" ? a.calls : undefined,
  };
}

async function execute(args: unknown, context: ToolContext): Promise<ToolResult> {
  const { query, kind, filePath, calledBy, calls } = validateArgs(args);

  // #774 — refuse to answer a query with NO filters. Checked before any DB work
  // so an accidental empty call costs nothing and yields guidance, never the
  // first 30 symbols alphabetically.
  if (!query && !kind && !filePath && !calledBy && !calls) {
    // #774 — an unfiltered call is a REJECTION, not an empty result.
    return { content: unfilteredGuidance(args), isError: true };
  }

  // Find the code graph for this project
  const codeGraph = await prisma.codeGraph.findFirst({
    where: { projectId: context.projectId },
    select: { id: true },
    orderBy: { lastIndexedAt: "desc" },
  });

  if (!codeGraph) {
    // Retrieval is UNAVAILABLE (nothing indexed) — that is a broken search, not
    // a codebase in which the symbol is absent.
    return { content: "No code graph available for this project.", isError: true };
  }

  // Build where clause for symbol search
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { codeGraphId: codeGraph.id };
  if (query) where.qualifiedName = { contains: query };
  if (kind) where.kind = kind;
  if (filePath) where.filePath = { contains: filePath };

  // Handle edge-based queries (calledBy / calls)
  let unresolvedNote = "";
  let probableNote = "";
  if (calledBy) {
    const resolved = await resolveNamedSymbol(codeGraph.id, calledBy);
    if (resolved.kind === "none") {
      return { content: `No symbol matching "${calledBy}" found.`, resultCount: 0 };
    }
    if (resolved.kind === "ambiguous") {
      return { content: ambiguityMessage("calledBy", calledBy, resolved), resultCount: 0 };
    }
    const caller = resolved.symbol;
    // #740 — a callee the parser could not resolve (stdlib, third-party) is
    // stored with toSymbolId = NULL, and Prisma rejects a NULL member of `in`.
    // Filter in the query so `take` caps RESOLVED edges, not the first N edges
    // (which for Go are mostly `fmt`/`errors` calls).
    const edges = await prisma.codeEdge.findMany({
      where: { fromSymbolId: caller.id, kind: "calls", toSymbolId: { not: null } },
      select: { toSymbolId: true },
      distinct: ["toSymbolId"],
      orderBy: { toSymbolId: "asc" },
      take: MAX_RESULTS,
    });
    const targetIds = edges.flatMap((e) => (e.toSymbolId ? [e.toSymbolId] : []));
    unresolvedNote = await describeUnresolvedCallees(caller.id);
    if (targetIds.length === 0) {
      if (unresolvedNote) {
        return {
          content: `"${calledBy}" calls no symbols resolved in this code graph; ${unresolvedNote}`,
          resultCount: 0,
        };
      }
      return { content: `"${calledBy}" does not call any other symbols.`, resultCount: 0 };
    }
    where.id = { in: targetIds };
  }

  if (calls) {
    const resolved = await resolveNamedSymbol(codeGraph.id, calls);
    if (resolved.kind === "none") {
      return { content: `No symbol matching "${calls}" found.`, resultCount: 0 };
    }
    if (resolved.kind === "ambiguous") {
      return { content: ambiguityMessage("calls", calls, resolved), resultCount: 0 };
    }
    const callee = resolved.symbol;
    const edges = await prisma.codeEdge.findMany({
      where: { toSymbolId: callee.id, kind: "calls" },
      select: { fromSymbolId: true },
      distinct: ["fromSymbolId"],
      orderBy: { fromSymbolId: "asc" },
      take: MAX_RESULTS,
    });
    const callerIds = edges.map((e) => e.fromSymbolId);
    probableNote = await describeProbableCallSites(codeGraph.id, callee, filePath);
    if (callerIds.length === 0) {
      if (probableNote) {
        return {
          content: `No resolved symbols call "${calls}".\n${probableNote}`,
          resultCount: 0,
        };
      }
      return { content: `No symbols call "${calls}".`, resultCount: 0 };
    }
    where.id = { in: callerIds };
    // `calls` replaces the id filter set by `calledBy`, so its note no longer applies.
    unresolvedNote = "";
  }

  const symbols = await prisma.codeSymbol.findMany({
    where,
    select: {
      qualifiedName: true,
      kind: true,
      filePath: true,
      startLine: true,
      endLine: true,
      language: true,
    },
    take: MAX_RESULTS,
    orderBy: { qualifiedName: "asc" },
  });

  if (symbols.length === 0) {
    const none = "No symbols found matching the query.";
    const notes = [none, unresolvedNote, probableNote].filter(Boolean);
    return { content: notes.join("\n"), resultCount: 0 };
  }

  const truncated = symbols.length === MAX_RESULTS;
  const lines = symbols.map(renderSymbol);
  if (unresolvedNote) lines.push(`(plus ${unresolvedNote})`);
  if (probableNote) lines.push(probableNote);

  return {
    content: lines.join("\n"),
    truncated,
    resultCount: symbols.length,
  };
}

export const searchCodeGraphTool: AgentTool = {
  name: "search_code_graph",
  description:
    "Search the project's code graph for symbols (classes, functions, methods, interfaces). " +
    "Returns qualified names with file:line locations. Use to discover relevant code before reading file slices. " +
    `At least one filter is required (${FILTERS.join(", ")}) — an unfiltered call is rejected.`,
  parameters,
  execute,
};
