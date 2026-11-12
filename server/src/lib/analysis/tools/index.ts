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
import { createChatReadFileSliceTool } from "./chat-read-file-slice.js";
import { loadCodeVersions } from "../../code-graph/code-version.js";
import { getConfigService } from "../../config/config-service.js";
import {
  createSearchCodeContextTool,
  DEFAULT_MERGE_GAP,
  DEFAULT_TOKEN_BUDGET,
} from "./search-code-context.js";

export { CHAT_CODE_TOOL_NAMES } from "./chat-code-tool-names.js";

/** Deps for the chat-facing code tool set (test seams for the hybrid searcher). */
export type ChatCodeToolDeps = Partial<SearchSymbolsDeps> & {
  /**
   * #2329 — offer `search_code_context`. Defaults to `CHAT_CODE_CONTEXT_TOOL`
   * (off until measured).
   */
  codeContext?: boolean;
};

/**
 * Epic #712 / Issue #713 — the curated code-search tool set offered on the
 * chat/stream surface for project-scoped sessions. Reuses the SAME
 * `searchCodeGraphTool` the analysis surface registers (single source of truth,
 * no duplication) plus the hybrid `search_code_symbols` tool. Ordering is
 * irrelevant here — `formatToolSchemas` sorts deterministically by name before
 * rendering the schemas into the cache-stable prompt lead.
 *
 * #736 — plus `read_file_slice`, so a cited `file:line` can be quoted rather
 * than reported unverified. It reads only the session project's own clones.
 */
export function getChatCodeTools(deps?: ChatCodeToolDeps): AgentTool[] {
  const { codeContext, ...searchDeps } = deps ?? {};
  // #2325 — chat's symbol search states the indexed commit of every hit.
  const tools = [
    searchCodeGraphTool,
    createSearchSymbolsTool({ loadVersions: loadCodeVersions, ...searchDeps }),
    createChatReadFileSliceTool(),
  ];
  // #2329 — whole-symbol context, beside the other tools (never instead of
  // them), and the same searcher, so the ranking is the one they see.
  const cfg = getConfigService();
  if (codeContext ?? cfg.getBool("CHAT_CODE_CONTEXT_TOOL", false)) {
    tools.push(
      createSearchCodeContextTool({
        ...(searchDeps.searcher ? { searcher: searchDeps.searcher } : {}),
        ...(searchDeps.lineLookup ? { lineLookup: searchDeps.lineLookup } : {}),
        ...(searchDeps.loadVersions ? { loadVersions: searchDeps.loadVersions } : {}),
        mergeGap: cfg.getNumber("CHAT_CODE_CONTEXT_MERGE_GAP", DEFAULT_MERGE_GAP),
        tokenBudget: cfg.getNumber("CHAT_CODE_CONTEXT_TOKEN_BUDGET", DEFAULT_TOKEN_BUDGET),
      }),
    );
  }
  return tools;
}
