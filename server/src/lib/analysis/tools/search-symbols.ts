/**
 * Epic #712 / Issue #713 — search_code_symbols tool.
 *
 * Hybrid (BM25 + vector RRF) symbol search over the project's symbol index,
 * exposed to the chat/stream surface (and reusable by analysis). It wraps the
 * existing {@link HybridCodeSearch} via the same injectable seams #714 wired for
 * fused passive retrieval ({@link FusedCodeSearcher} + {@link SymbolLineLookup}),
 * so line spans come authoritatively from `CodeSymbol` rows and every hit renders
 * a `filePath:startLine-endLine` locator (which #715 citations reuse).
 *
 * A project without a built code graph yields zero symbols → a clean "no code
 * graph symbols" result, never an error (matching `searchCodeGraphTool`). The
 * searcher / line-lookup are injectable so unit tests never touch a live
 * embedder, LanceDB table, or Prisma.
 *
 * #2327 — with `filters` on (chat, behind `CHAT_CODE_SEARCH_PRIMITIVES`), the
 * tool also takes `fileGlob`, `symbolKind` and `language`, each validated here
 * and handed to the searcher's pre-filter. Off (analysis, and chat with the key
 * off), the schema is exactly the pre-#2327 one, so the measured default does
 * not move until the key does.
 */
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import { checkRepoGlob, repoPathError } from "./repo-paths.js";
import { hiddenSymbolIds } from "./code-access.js";
import type { FusedCodeSearcher, SymbolLineLookup } from "../../rag/fused-code-context.js";
import { quotableSnippet } from "../../code-graph/symbol-context.js";
import {
  createDefaultCodeSearcher,
  createDefaultSymbolLineLookup,
} from "../../code-graph/project-code-searcher.js";

/**
 * The cut-off the agent actually sees. EXPORTED because it is a retrieval
 * requirement, not a private detail: a symbol ranked below it is, to the agent,
 * simply not there. #797's weight sweep and its tool-boundary test both derive
 * their cut-off from this constant rather than restating it (PR #803 review, B1).
 */
export const DEFAULT_LIMIT = 15;
/** Hard cap on what the agent may ask for, however large a `limit` it passes. */
export const MAX_LIMIT = 30;
/** Trim each rendered snippet so a wide hit set cannot blow the context. */
const MAX_SNIPPET_CHARS = 400;

/**
 * #2327 — the `CodeSymbol.kind` values a filter may name: the parsers' kinds
 * (`code-graph/parsers.ts` `SymbolKind`) plus the schema symbols the SQL path
 * writes (`table`, `column`, `procedure`).
 */
export const SYMBOL_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "type",
  "module",
  "table",
  "column",
  "procedure",
] as const;

/** #2327 — the `CodeSymbol.language` values (`code-graph/parsers.ts` `Language`, plus `sql`). */
export const SYMBOL_LANGUAGES = [
  "ts",
  "js",
  "py",
  "go",
  "java",
  "kt",
  "scala",
  "cs",
  "c",
  "cpp",
  "rs",
  "sas",
  "cbl",
  "sql",
] as const;

export interface SearchSymbolsArgs {
  query: string;
  limit?: number;
  fileGlob?: string;
  symbolKind?: string;
  language?: string;
}

const parameters: JSONSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language or keyword query for code symbols (functions, classes, methods). " +
        "Ranked with hybrid BM25 + vector search over the project's symbol index.",
    },
    limit: {
      type: "number",
      description: "Maximum symbol hits to return (1-30, default 15).",
    },
  },
  required: ["query"],
};

/** #2327 — the schema with the filters. */
const filteredParameters: JSONSchema = {
  type: "object",
  properties: {
    ...parameters.properties,
    fileGlob: {
      type: "string",
      description:
        "Optional: only symbols in files matching this repository-relative glob " +
        "(`*` within a directory, `**` across directories, `?` one character), e.g. 'internal/reader/**'.",
    },
    symbolKind: {
      type: "string",
      enum: [...SYMBOL_KINDS],
      description: "Optional: only symbols of this kind.",
    },
    language: {
      type: "string",
      enum: [...SYMBOL_LANGUAGES],
      description: "Optional: only symbols in files of this language.",
    },
  },
  required: ["query"],
};

const TOOL = "search_code_symbols";

type FilterCheck =
  | { ok: true; filters: Pick<SearchSymbolsArgs, "fileGlob" | "symbolKind" | "language"> }
  | { ok: false; error: string };

/** #2327 — the optional filters, each validated; an invalid one is refused, never ignored. */
function checkFilters(a: Record<string, unknown>): FilterCheck {
  const filters: Pick<SearchSymbolsArgs, "fileGlob" | "symbolKind" | "language"> = {};
  if (a.fileGlob !== undefined && a.fileGlob !== null) {
    if (typeof a.fileGlob !== "string") {
      return { ok: false, error: repoPathError(TOOL, "fileGlob", "it is not a string") };
    }
    const g = checkRepoGlob(a.fileGlob);
    if (!g.ok) return { ok: false, error: repoPathError(TOOL, "fileGlob", g.reason) };
    filters.fileGlob = g.value;
  }
  for (const [key, allowed] of [
    ["symbolKind", SYMBOL_KINDS],
    ["language", SYMBOL_LANGUAGES],
  ] as const) {
    const v = a[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
      return {
        ok: false,
        error: `Error: ${TOOL} "${key}" must be one of: ${allowed.join(", ")}.`,
      };
    }
    filters[key] = v;
  }
  return { ok: true, filters };
}

function validateArgs(args: unknown): SearchSymbolsArgs | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.query !== "string" || a.query.trim() === "") return null;
  return {
    query: a.query,
    limit:
      typeof a.limit === "number"
        ? Math.min(Math.max(1, Math.floor(a.limit)), MAX_LIMIT)
        : undefined,
  };
}

/** Injectable dependencies — mocked in tests (no live embedder / DB). */
export interface SearchSymbolsDeps {
  searcher: FusedCodeSearcher;
  lineLookup: SymbolLineLookup;
}

/** #2327 — how the tool is offered. */
export interface SearchSymbolsOptions {
  /** Offer and honour `fileGlob`, `symbolKind` and `language`. Default off. */
  filters?: boolean;
}

/**
 * Build the `search_code_symbols` tool. Deps default to the production
 * Prisma/HybridCodeSearch wiring (#714), and are overridable for tests.
 */
export function createSearchSymbolsTool(
  deps?: Partial<SearchSymbolsDeps>,
  options: SearchSymbolsOptions = {},
): AgentTool {
  const withFilters = options.filters === true;
  const searcher = deps?.searcher ?? createDefaultCodeSearcher();
  // #1636 — the tool renders `path:start-end` only, so it skips the repo read.
  const lineLookup = deps?.lineLookup ?? createDefaultSymbolLineLookup({ withRepo: false });

  async function execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validated = validateArgs(args);
    if (!validated) {
      // #774 — echo the keys that DID arrive so the model can repair its next
      // call instead of re-emitting the same shape until the turn budget dies.
      return {
        content: missingParamError({
          tool: "search_code_symbols",
          param: "query",
          expected: "non-empty string",
          args,
          example: "drift severity computation",
        }),
        isError: true,
      };
    }
    const limit = validated.limit ?? DEFAULT_LIMIT;
    let filters: Pick<SearchSymbolsArgs, "fileGlob" | "symbolKind" | "language"> = {};
    if (withFilters) {
      const checked = checkFilters(args as Record<string, unknown>);
      if (!checked.ok) return { content: checked.error, isError: true };
      filters = checked.filters;
    }

    const found = await searcher.search(validated.query, context.projectId, {
      limit,
      ...filters,
    });
    // #2243 — a symbol in a file whose document the caller may not see is
    // dropped, as if it were not indexed.
    const hidden = context.codeAccess
      ? await hiddenSymbolIds(
          context.codeAccess,
          context.projectId,
          found.map((r) => r.symbolId),
        )
      : new Set<string>();
    const raw = hidden.size > 0 ? found.filter((r) => !hidden.has(r.symbolId)) : found;
    if (raw.length === 0) {
      // Empty index (no built code graph) or no keyword/vector match — a clean
      // no-op result, never an error.
      // #773 — resultCount 0 is the STRUCTURED "worked, found nothing" contract:
      // evidence of absence, not of a broken run.
      const narrowed = Object.keys(filters).length > 0;
      return {
        content: narrowed
          ? "No matching code symbols found in this project's code graph with these filters."
          : "No matching code symbols found in this project's code graph.",
        resultCount: 0,
      };
    }

    const spans = await lineLookup.resolve(
      raw.map((r) => r.symbolId),
      context.projectId,
    );

    const lines = raw.map((hit) => {
      const span = spans.get(hit.symbolId);
      const locator = span ? `${span.filePath}:${span.startLine}-${span.endLine}` : hit.filePath;
      const head = `${hit.kind} ${hit.name} — ${locator} (score=${hit.score.toFixed(3)})`;
      // Cut first, then quote: a cut cannot expose a line the quoting defused.
      const snippet = quotableSnippet(hit.snippet?.slice(0, MAX_SNIPPET_CHARS));
      return snippet ? `${head}\n${snippet}` : head;
    });

    return {
      content: lines.join("\n\n"),
      truncated: found.length >= limit,
      resultCount: raw.length,
    };
  }

  return {
    name: "search_code_symbols",
    description:
      "Hybrid (keyword + semantic) search over the project's code symbol index. " +
      "Returns ranked symbols each with a filePath:startLine-endLine locator into the real source. " +
      "Use for fuzzy/semantic code discovery when you don't know exact names; use search_code_graph " +
      "for exact qualified-name / caller / callee graph traversal." +
      (withFilters
        ? " Narrow with fileGlob, symbolKind or language; for an exact string use grep_files."
        : ""),
    parameters: withFilters ? filteredParameters : parameters,
    execute,
  };
}
