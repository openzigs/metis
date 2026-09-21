/**
 * Epic #473 / Issue #476 — search_knowledge tool.
 *
 * Agent-directed RAG queries against the project's knowledge base.
 * Wraps KnowledgeService.search() so the agent can retrieve document
 * chunks with its own queries (vs. the static retrieval-query map).
 */
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import type { KnowledgeService } from "../../rag/knowledge-service.js";

const DEFAULT_K = 5;
const MAX_K = 15;

export interface SearchKnowledgeArgs {
  query: string;
  k?: number;
}

const parameters: JSONSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural language search query against the project's document knowledge base",
    },
    k: {
      type: "number",
      description: "Number of results to return (1-15, default 5)",
    },
  },
  required: ["query"],
};

function validateArgs(args: unknown): SearchKnowledgeArgs | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.query !== "string" || a.query.trim() === "") return null;
  return {
    query: a.query,
    k: typeof a.k === "number" ? Math.min(Math.max(1, Math.floor(a.k)), MAX_K) : undefined,
  };
}

export interface SearchKnowledgeDeps {
  knowledgeService: KnowledgeService;
}

export function createSearchKnowledgeTool(deps: SearchKnowledgeDeps): AgentTool {
  async function execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validated = validateArgs(args);
    if (!validated) {
      // #774 — echo the received keys so the rejection is self-repairable.
      return {
        content: missingParamError({
          tool: "search_knowledge",
          param: "query",
          expected: "non-empty natural-language string",
          args,
          example: "acceptance criteria for drift alerts",
        }),
        isError: true,
      };
    }

    const k = validated.k ?? DEFAULT_K;
    const result = await deps.knowledgeService.search(context.projectId, validated.query, { k });

    if (result.hits.length === 0) {
      return { content: "No relevant documents found for the query.", resultCount: 0 };
    }

    const formatted = result.hits.map(
      (hit, i) =>
        `[${i + 1}] ${hit.filename}#chunk${hit.position} (score: ${hit.score?.toFixed(3) ?? "n/a"})\n${hit.text}`,
    );

    return {
      content: formatted.join("\n---\n"),
      truncated: result.hits.length === k,
      resultCount: result.hits.length,
    };
  }

  return {
    name: "search_knowledge",
    description:
      "Search the project's document knowledge base using a natural language query. " +
      "Returns relevant document chunks with source attribution. Use to find business requirements, " +
      "specifications, and other project documentation.",
    parameters,
    execute,
  };
}
