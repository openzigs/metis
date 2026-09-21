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
export { searchCodeGraphTool } from "./search-code-graph.js";
export { readFileSliceTool } from "./read-file-slice.js";
export { listFilesTool } from "./list-files.js";
export { createSearchKnowledgeTool } from "./search-knowledge.js";
export { createSearchSymbolsTool, type SearchSymbolsDeps } from "./search-symbols.js";
export { createDescribeTableTool, type DescribeTableDeps } from "./describe-table.js";

import type { AgentTool } from "./types.js";
import { searchCodeGraphTool } from "./search-code-graph.js";
import { createSearchSymbolsTool, type SearchSymbolsDeps } from "./search-symbols.js";

/** Deps for the chat-facing code tool set (test seams for the hybrid searcher). */
export type ChatCodeToolDeps = Partial<SearchSymbolsDeps>;

/**
 * Epic #712 / Issue #713 — the curated code-search tool set offered on the
 * chat/stream surface for project-scoped sessions. Reuses the SAME
 * `searchCodeGraphTool` the analysis surface registers (single source of truth,
 * no duplication) plus the hybrid `search_code_symbols` tool. Ordering is
 * irrelevant here — `formatToolSchemas` sorts deterministically by name before
 * rendering the schemas into the cache-stable prompt lead.
 */
export function getChatCodeTools(deps?: ChatCodeToolDeps): AgentTool[] {
  return [searchCodeGraphTool, createSearchSymbolsTool(deps)];
}
