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
      description: "Find symbols that are called by the named symbol",
    },
    calls: {
      type: "string",
      description: "Find symbols that call the named symbol",
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
  if (calledBy) {
    const caller = await prisma.codeSymbol.findFirst({
      where: { codeGraphId: codeGraph.id, qualifiedName: { contains: calledBy } },
      select: { id: true },
    });
    if (!caller) {
      return { content: `No symbol matching "${calledBy}" found.`, resultCount: 0 };
    }
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
    const callee = await prisma.codeSymbol.findFirst({
      where: { codeGraphId: codeGraph.id, qualifiedName: { contains: calls } },
      select: { id: true },
    });
    if (!callee) {
      return { content: `No symbol matching "${calls}" found.`, resultCount: 0 };
    }
    const edges = await prisma.codeEdge.findMany({
      where: { toSymbolId: callee.id, kind: "calls" },
      select: { fromSymbolId: true },
      distinct: ["fromSymbolId"],
      orderBy: { fromSymbolId: "asc" },
      take: MAX_RESULTS,
    });
    const callerIds = edges.map((e) => e.fromSymbolId);
    if (callerIds.length === 0) {
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
    return { content: unresolvedNote ? `${none}\n${unresolvedNote}` : none, resultCount: 0 };
  }

  const truncated = symbols.length === MAX_RESULTS;
  const lines = symbols.map(
    (s) =>
      `${s.kind} ${s.qualifiedName} — ${s.filePath}:${s.startLine}-${s.endLine} [${s.language}]`,
  );
  if (unresolvedNote) lines.push(`(plus ${unresolvedNote})`);

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
