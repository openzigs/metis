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
export { grepFilesTool } from "./grep-files.js";
export { createSearchKnowledgeTool } from "./search-knowledge.js";
export { createSearchSymbolsTool, type SearchSymbolsDeps } from "./search-symbols.js";
export { createDescribeTableTool, type DescribeTableDeps } from "./describe-table.js";

import type { AgentTool } from "./types.js";
import { chatSearchCodeGraphTool } from "./search-code-graph.js";
import { createSearchSymbolsTool, type SearchSymbolsDeps } from "./search-symbols.js";
import { createChatReadFileSliceTool } from "./chat-read-file-slice.js";
import { indexStatusTool } from "./index-status.js";
import { createChatGrepFilesTool, createChatListFilesTool } from "./chat-file-tools.js";
import { createChangeHistoryTool } from "./change-history.js";
import { CHANGE_HISTORY_FLAG } from "../../connectors/repo/history-repo.js";
import { createFileOutlineTool } from "./file-outline.js";
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
   * (off: measured in #2412, no gain beyond run-to-run spread).
   */
  codeContext?: boolean;
  /**
   * #2338 — offer `get_change_history`. Defaults to `CHAT_CHANGE_HISTORY_TOOL`
   * (off until measured: it reads the history repository that flag fetches).
   */
  changeHistory?: boolean;
  /**
   * #2346 — offer `get_file_outline`. Defaults to `CHAT_FILE_OUTLINE_TOOL`
   * (off until measured).
   */
  fileOutline?: boolean;
};

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
 *
 * #2327 — with `primitives` (`CHAT_CODE_SEARCH_PRIMITIVES`), also `grep_files`
 * and `list_files` over the same clones, and `search_code_symbols` takes its
 * `fileGlob` / `symbolKind` / `language` filters.
 */
export function getChatCodeTools(
  deps?: ChatCodeToolDeps,
  opts: { indexStatus?: boolean; primitives?: boolean } = {},
): AgentTool[] {
  const primitives = opts.primitives === true;
  const { codeContext, changeHistory, fileOutline, ...searchDeps } = deps ?? {};
  // #2325 — chat's graph and symbol searches state the indexed commit of every
  // hit; the analysis surface's copies do not.
  const tools = [
    chatSearchCodeGraphTool,
    createSearchSymbolsTool(
      { loadVersions: loadCodeVersions, ...searchDeps },
      { filters: primitives },
    ),
    createChatReadFileSliceTool(),
    // #2326 — `CHAT_INDEX_STATUS`: what the index holds, and how its last run went.
    ...(opts.indexStatus === false ? [] : [indexStatusTool]),
  ];
  if (primitives) tools.push(createChatGrepFilesTool(), createChatListFilesTool());
  // #2329 — whole-symbol context, beside the other tools (never instead of
  // them), and the same searcher, so the ranking is the one they see.
  const cfg = getConfigService();
  // #2346 — a file's symbols and spans, from the code graph.
  if (fileOutline ?? cfg.getBool("CHAT_FILE_OUTLINE_TOOL", false)) {
    tools.push(
      createFileOutlineTool(
        searchDeps.loadVersions ? { loadVersions: searchDeps.loadVersions } : {},
      ),
    );
  }
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
  // #2338 — commit history, read locally from the connector's history repository.
  if (changeHistory ?? cfg.getBool(CHANGE_HISTORY_FLAG, false)) {
    tools.push(createChangeHistoryTool());
  }
  return tools;
}
