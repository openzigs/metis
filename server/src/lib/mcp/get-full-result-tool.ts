/**
 * Epic #515 / Issue #518 — get_full_result internal agent tool.
 *
 * Returns the full cached tool result by execution ID. Used in conjunction
 * with ProgressiveResultManager for the summary + expand pattern.
 */
import type { AgentTool, ToolResult } from "../analysis/tools/types.js";
import type { ProgressiveResultManager } from "./progressive-results.js";

export interface GetFullResultToolOptions {
  /** The progressive result manager to retrieve cached results from. */
  manager: ProgressiveResultManager;
}

/**
 * Create the `get_full_result` internal agent tool.
 * When tool results are summarized, the LLM can call this to retrieve
 * the full result content by cache ID.
 */
export function createGetFullResultTool(opts: GetFullResultToolOptions): AgentTool {
  return {
    name: "get_full_result",
    description:
      "Retrieves the full content of a previously summarized tool result by its cache ID.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The cache ID from the summarized result.",
        },
      },
      required: ["id"],
    },
    async execute(args: unknown): Promise<ToolResult> {
      const { id } = args as { id: string };

      if (!id || typeof id !== "string") {
        return { content: JSON.stringify({ error: "id is required" }) };
      }

      const content = opts.manager.getFullResult(id);

      if (content === null) {
        return {
          content: JSON.stringify({
            error: "Result not found or expired. The cached result may have exceeded its TTL.",
          }),
        };
      }

      return { content };
    },
  };
}
