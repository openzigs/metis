/**
 * #2331 — the `mcp` arm of `pnpm eval:ba-qa`: does an agent answer as well
 * through `metis-index-mcp` as through chat's in-process code tools?
 *
 * The arm runs `tools-only`'s flags and everything `tools-only` runs (the
 * library system prompt, the auto-RAG block, the tool loop, the judge), with
 * one difference: the session's tools are replaced by the eight `metis_*`
 * tools, called through a real MCP client (`@modelcontextprotocol/sdk`) as
 * the eval user's own API token. So the model sees what an external agent
 * sees: the MCP tool names, descriptions and input schemas from `tools/list`,
 * a `projectId` it must find with `metis_list_projects`, and each result as
 * the JSON text an MCP client reads (`content`), instructions included.
 *
 * Paired with a `tools-only` run, the difference is the MCP surface alone.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RuntimeTool, RuntimeToolResult } from "../../ai/tool-runtime/types.js";

export const MCP_ARM = "mcp";

type McpClient = Pick<Client, "listTools" | "callTool">;

/** A tool's MCP input schema as a provider's tool parameters: no `$schema` key. */
export function toolParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...rest } = schema;
  return rest;
}

/** What one `tools/call` result reads as in the tool loop. */
export function toRuntimeResult(r: Record<string, unknown>): RuntimeToolResult {
  const blocks = Array.isArray(r.content)
    ? (r.content as Array<{ type?: string; text?: string }>)
    : [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  const s = r.structuredContent as Record<string, unknown> | undefined;
  return {
    text,
    ...(r.isError === true ? { isError: true } : {}),
    ...(typeof s?.resultCount === "number" ? { resultCount: s.resultCount } : {}),
    ...(s?.truncated === true ? { truncated: true } : {}),
  };
}

/** The server's tools, as the chat tool loop runs them: every call goes through `client`. */
export async function mcpRuntimeTools(client: McpClient): Promise<RuntimeTool[]> {
  const { tools } = await client.listTools();
  return tools.map((t): RuntimeTool => ({
    name: t.name,
    wireName: t.name,
    description: t.description ?? "",
    parameters: toolParameters(t.inputSchema as Record<string, unknown>),
    risk: "low",
    source: "mcp",
    validate: (args) =>
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? { ok: true, args }
        : { ok: false },
    async execute(args) {
      return toRuntimeResult(
        await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }),
      );
    },
  }));
}
