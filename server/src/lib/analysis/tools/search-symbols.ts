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
 */
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import type { FusedCodeSearcher, SymbolLineLookup } from "../../rag/fused-code-context.js";
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

export interface SearchSymbolsArgs {
  query: string;
  limit?: number;
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

/**
 * Build the `search_code_symbols` tool. Deps default to the production
 * Prisma/HybridCodeSearch wiring (#714), and are overridable for tests.
 */
export function createSearchSymbolsTool(deps?: Partial<SearchSymbolsDeps>): AgentTool {
  const searcher = deps?.searcher ?? createDefaultCodeSearcher();
  const lineLookup = deps?.lineLookup ?? createDefaultSymbolLineLookup();

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

    const raw = await searcher.search(validated.query, context.projectId, { limit });
    if (raw.length === 0) {
      // Empty index (no built code graph) or no keyword/vector match — a clean
      // no-op result, never an error.
      // #773 — resultCount 0 is the STRUCTURED "worked, found nothing" contract:
      // evidence of absence, not of a broken run.
      return {
        content: "No matching code symbols found in this project's code graph.",
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
      const snippet = hit.snippet?.trim();
      return snippet ? `${head}\n${snippet.slice(0, MAX_SNIPPET_CHARS)}` : head;
    });

    return {
      content: lines.join("\n\n"),
      truncated: raw.length >= limit,
      resultCount: raw.length,
    };
  }

  return {
    name: "search_code_symbols",
    description:
      "Hybrid (keyword + semantic) search over the project's code symbol index. " +
      "Returns ranked symbols each with a filePath:startLine-endLine locator into the real source. " +
      "Use for fuzzy/semantic code discovery when you don't know exact names; use search_code_graph " +
      "for exact qualified-name / caller / callee graph traversal.",
    parameters,
    execute,
  };
}
