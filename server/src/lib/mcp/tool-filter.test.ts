/**
 * Epic #502 / Issue #504 — Unit tests for ToolFilter.
 */
import { describe, it, expect } from "vitest";
import { ToolFilter } from "./tool-filter.js";
import type { AgentTool } from "../analysis/tools/types.js";

function makeTool(name: string, description = "A tool"): AgentTool {
  return {
    name,
    description,
    parameters: { type: "object" },
    execute: async () => ({ content: "ok" }),
  };
}

describe("ToolFilter", () => {
  const filter = new ToolFilter();

  const tools: AgentTool[] = [
    makeTool("search_code_graph", "Search code graph for symbols"),
    makeTool("read_file", "Read contents of a file"),
    makeTool("mcp:github:list_issues", "List issues from GitHub"),
    makeTool("mcp:jira:get_ticket", "Get Jira ticket"),
    makeTool("mcp:slack:send_message", "Send a Slack message"),
    makeTool("list_symbols", "List all symbols"),
    makeTool("web_search", "Search the web"),
  ];

  describe("filter by connected server IDs", () => {
    it("keeps non-MCP tools and MCP tools from connected servers", () => {
      const result = filter.filter(tools, {
        connectedServerIds: ["github"],
      });

      expect(result.tools.map((t) => t.name)).toContain("search_code_graph");
      expect(result.tools.map((t) => t.name)).toContain("read_file");
      expect(result.tools.map((t) => t.name)).toContain("mcp:github:list_issues");
      expect(result.tools.map((t) => t.name)).not.toContain("mcp:jira:get_ticket");
      expect(result.tools.map((t) => t.name)).not.toContain("mcp:slack:send_message");
    });

    it("passes all tools when no connected servers specified", () => {
      const result = filter.filter(tools, {});
      expect(result.tools).toHaveLength(tools.length);
    });
  });

  describe("filter by allow-list", () => {
    it("only includes tools on the allow-list", () => {
      const result = filter.filter(tools, {
        allowList: ["search_code_graph", "read_file", "list_symbols"],
      });

      expect(result.tools).toHaveLength(3);
      expect(result.tools.map((t) => t.name)).toEqual([
        "search_code_graph",
        "read_file",
        "list_symbols",
      ]);
    });
  });

  describe("filter by session type", () => {
    it("prioritizes analysis-relevant tools for analysis sessions", () => {
      const result = filter.filter(tools, {
        sessionType: "analysis",
      });

      // Should include tools with "search", "read", "graph", "symbol", "list"
      expect(result.tools.map((t) => t.name)).toContain("search_code_graph");
      expect(result.tools.map((t) => t.name)).toContain("read_file");
      expect(result.tools.map((t) => t.name)).toContain("list_symbols");
    });

    it("does not filter when session type is general", () => {
      const result = filter.filter(tools, {
        sessionType: "general",
      });
      expect(result.tools).toHaveLength(tools.length);
    });
  });

  describe("safety net", () => {
    it("triggers safety net when filtering results in fewer than 3 tools", () => {
      const result = filter.filter(tools, {
        allowList: ["nonexistent_tool_1", "nonexistent_tool_2"],
      });

      expect(result.safetyNetTriggered).toBe(true);
      expect(result.tools).toHaveLength(tools.length);
    });

    it("does not trigger when enough tools remain", () => {
      const result = filter.filter(tools, {
        allowList: ["search_code_graph", "read_file", "list_symbols"],
      });

      expect(result.safetyNetTriggered).toBe(false);
      expect(result.tools).toHaveLength(3);
    });

    it("does not trigger when original set is small", () => {
      const smallSet = [makeTool("a"), makeTool("b")];
      const result = filter.filter(smallSet, {
        allowList: ["a"],
      });

      // Original < 3, so safety net doesn't apply
      expect(result.safetyNetTriggered).toBe(false);
    });
  });

  describe("combined filters", () => {
    it("applies server filter then allow-list", () => {
      const result = filter.filter(tools, {
        connectedServerIds: ["github"],
        allowList: ["search_code_graph", "mcp:github:list_issues", "read_file"],
      });

      // After server filter: search_code_graph, read_file, mcp:github:list_issues, list_symbols, web_search (5 non-jira/slack)
      // After allow-list: search_code_graph, mcp:github:list_issues, read_file (3 - meets threshold)
      expect(result.tools).toHaveLength(3);
      expect(result.tools.map((t) => t.name)).toContain("search_code_graph");
      expect(result.tools.map((t) => t.name)).toContain("mcp:github:list_issues");
      expect(result.tools.map((t) => t.name)).toContain("read_file");
    });
  });

  describe("metadata", () => {
    it("reports original and filtered counts", () => {
      const result = filter.filter(tools, {
        allowList: ["search_code_graph", "read_file", "list_symbols"],
      });

      expect(result.originalCount).toBe(7);
      expect(result.filteredCount).toBe(3);
    });
  });
});
