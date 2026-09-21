/**
 * Epic #502 / Issue #503 — get_tool_schema internal tool.
 *
 * Returns the full JSON schema for a specific tool, enabling lazy schema
 * loading when using compact tool manifests.
 */
import type { AgentTool, ToolResult } from "../analysis/tools/types.js";

export interface GetToolSchemaOptions {
  /** Registry of available tools to look up schemas from. */
  tools: AgentTool[];
}

/**
 * Create the `get_tool_schema` internal agent tool.
 * When the LLM needs full parameter details for a tool, it calls this
 * instead of having all schemas in the system prompt.
 */
export function createGetToolSchemaTool(opts: GetToolSchemaOptions): AgentTool {
  return {
    name: "get_tool_schema",
    description: "Returns the full JSON schema (parameters) for a named tool.",
    parameters: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "The name of the tool to get the schema for.",
        },
      },
      required: ["tool_name"],
    },
    async execute(args: unknown): Promise<ToolResult> {
      const { tool_name } = args as { tool_name: string };

      if (!tool_name || typeof tool_name !== "string") {
        return { content: JSON.stringify({ error: "tool_name is required" }) };
      }

      const tool = opts.tools.find((t) => t.name === tool_name);

      if (!tool) {
        return {
          content: JSON.stringify({
            error: `Unknown tool: ${tool_name}`,
            available: opts.tools.map((t) => t.name),
          }),
        };
      }

      return {
        content: JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      };
    },
  };
}
