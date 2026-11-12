/**
 * Epic #473 — Tool barrel export.
 */
export {
  type AgentTool,
  type ToolContext,
  type ToolResult,
  type ToolCallRequest,
  type JSONSchema,
} from "./types.js";
export { searchCodeGraphTool, chatSearchCodeGraphTool } from "./search-code-graph.js";
export { readFileSliceTool } from "./read-file-slice.js";
export { listFilesTool } from "./list-files.js";
export { createSearchKnowledgeTool } from "./search-knowledge.js";
export { createSearchSymbolsTool, type SearchSymbolsDeps } from "./search-symbols.js";
export { createDescribeTableTool, type DescribeTableDeps } from "./describe-table.js";

import type { AgentTool } from "./types.js";
import { chatSearchCodeGraphTool } from "./search-code-graph.js";
import { createSearchSymbolsTool, type SearchSymbolsDeps } from "./search-symbols.js";
import { createChatReadFileSliceTool } from "./chat-read-file-slice.js";
import { loadCodeVersions } from "../../code-graph/code-version.js";

export { CHAT_CODE_TOOL_NAMES } from "./chat-code-tool-names.js";

/** Deps for the chat-facing code tool set (test seams for the hybrid searcher). */
export type ChatCodeToolDeps = Partial<SearchSymbolsDeps>;

/**
 * Epic #712 / Issue #713 — the curated code-search tool set offered on the
 * chat/stream surface for project-scoped sessions. Reuses the SAME search the
 * analysis surface's `searchCodeGraphTool` runs (single source of truth, no
 * duplication; chat's copy adds only the #2325 citation contract) plus the
 * hybrid `search_code_symbols` tool. Ordering is
 * irrelevant here — `formatToolSchemas` sorts deterministically by name before
 * rendering the schemas into the cache-stable prompt lead.
 *
 * #736 — plus `read_file_slice`, so a cited `file:line` can be quoted rather
 * than reported unverified. It reads only the session project's own clones.
 */
export function getChatCodeTools(deps?: ChatCodeToolDeps): AgentTool[] {
  // #2325 — chat's graph and symbol searches state the indexed commit of every
  // hit; the analysis surface's copies do not.
  return [
    chatSearchCodeGraphTool,
    createSearchSymbolsTool({ loadVersions: loadCodeVersions, ...deps }),
    createChatReadFileSliceTool(),
  ];
}
