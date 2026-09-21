/**
 * Epic #502 / Issue #504 — Per-session tool filtering based on project context.
 *
 * Filters the tool list based on:
 * - Project MCP server connections (only show tools from connected servers)
 * - Tool allow-list (per-project or global configuration)
 * - Session type (e.g., analysis, chat, code-review)
 *
 * Safety net: if filtering reduces to fewer than 3 tools, include all tools.
 */
import type { AgentTool } from "../analysis/tools/types.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("tool-filter");

/** Minimum tools after filtering — safety net to prevent empty tool sets. */
const MIN_TOOLS_THRESHOLD = 3;

export interface ToolFilterContext {
  /** Project MCP server IDs that are connected. */
  connectedServerIds?: string[];
  /** Explicit tool allow-list (tool names). When set, only these are allowed. */
  allowList?: string[];
  /** Session type for filtering. */
  sessionType?: "analysis" | "chat" | "code-review" | "general";
}

export interface ToolFilterResult {
  /** Filtered tools. */
  tools: AgentTool[];
  /** Whether the safety net was triggered. */
  safetyNetTriggered: boolean;
  /** Count of tools before filtering. */
  originalCount: number;
  /** Count of tools after filtering. */
  filteredCount: number;
}

/**
 * Tool relevance hints by session type. Tools matching these patterns
 * are prioritized for the given session type.
 */
const SESSION_TYPE_HINTS: Record<string, string[]> = {
  analysis: ["search", "read", "graph", "symbol", "list"],
  chat: ["search", "read", "web", "fetch"],
  "code-review": ["read", "diff", "search", "symbol", "graph"],
  general: [],
};

export class ToolFilter {
  /**
   * Filter tools based on project context and session type.
   */
  filter(tools: AgentTool[], context: ToolFilterContext): ToolFilterResult {
    const originalCount = tools.length;
    let filtered = [...tools];

    // Step 1: Filter by connected server IDs (for MCP tools)
    if (context.connectedServerIds && context.connectedServerIds.length > 0) {
      filtered = filtered.filter((tool) => {
        // MCP tools have the format "mcp:<server-label>:<tool-name>"
        if (tool.name.startsWith("mcp:")) {
          const serverLabel = tool.name.split(":")[1];
          // Check if any connected server matches this label pattern
          return context.connectedServerIds!.some(
            (id) => id === serverLabel || tool.name.includes(id),
          );
        }
        // Non-MCP tools (internal) always pass this filter
        return true;
      });
    }

    // Step 2: Filter by allow-list
    if (context.allowList && context.allowList.length > 0) {
      filtered = filtered.filter((tool) => context.allowList!.includes(tool.name));
    }

    // Step 3: Session type filtering (soft filter — deprioritize but don't remove)
    // We only hard-filter if the result would still meet the threshold
    if (context.sessionType && context.sessionType !== "general") {
      const hints = SESSION_TYPE_HINTS[context.sessionType] ?? [];
      if (hints.length > 0) {
        const relevant = filtered.filter((tool) =>
          hints.some(
            (hint) =>
              tool.name.toLowerCase().includes(hint) ||
              tool.description.toLowerCase().includes(hint),
          ),
        );
        // Only apply session filter if we'd still have enough tools
        if (relevant.length >= MIN_TOOLS_THRESHOLD) {
          filtered = relevant;
        }
      }
    }

    // Safety net: if filtering is too aggressive, include all tools
    const safetyNetTriggered =
      filtered.length < MIN_TOOLS_THRESHOLD && originalCount >= MIN_TOOLS_THRESHOLD;
    if (safetyNetTriggered) {
      log.warn("Tool filter safety net triggered, including all tools", {
        originalCount,
        filteredCount: filtered.length,
        context: {
          connectedServerIds: context.connectedServerIds?.length,
          allowList: context.allowList?.length,
          sessionType: context.sessionType,
        },
      });
      filtered = tools;
    }

    return {
      tools: filtered,
      safetyNetTriggered,
      originalCount,
      filteredCount: filtered.length,
    };
  }
}
