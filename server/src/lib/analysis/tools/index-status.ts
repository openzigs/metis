/**
 * #2326 — `get_index_status`, a read-only chat tool: what the session
 * project's index holds and how its last indexing went, so the model can tell
 * "the code does not do this" apart from "the index is failed, partial or
 * still being built".
 *
 * It takes no arguments. The project is the one the session is bound to
 * (`ctx.projectId`, server-derived), so it cannot be pointed at a project the
 * caller may not read: such a project is simply never in its answer. Error
 * text is a classified summary (`classifyIndexError`), never the recorded
 * message, and documents hidden from the caller (#2243) are not counted.
 */
import type { AgentTool, JSONSchema, ToolContext, ToolResult } from "./types.js";
import { formatIndexStatus, loadProjectIndexStatus } from "../../ai/index-status.js";

export const INDEX_STATUS_TOOL_NAME = "get_index_status";

const parameters: JSONSchema = { type: "object", properties: {} };

async function execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const status = await loadProjectIndexStatus(ctx.projectId, {
    ...(ctx.codeAccess ? { access: ctx.codeAccess } : {}),
  });
  if (!status) return { content: "Error: this chat's project no longer exists.", isError: true };
  // No `resultCount`: a status report is not project content, so chat's
  // grounding label must not count it as a project lookup (#439).
  return { content: formatIndexStatus(status) };
}

export const indexStatusTool: AgentTool = {
  name: INDEX_STATUS_TOOL_NAME,
  description:
    "Report the state of this project's index: for each connected repository, the last indexed " +
    "commit and time, how the last indexing run ended (with a classified error), code symbol and " +
    "document counts, and how many source files were indexed or skipped. Call it before " +
    "concluding that the project lacks something your searches did not find.",
  parameters,
  execute,
};
