/**
 * Epic #502 / Issue #503 — Unit tests for compact tool manifests + get_tool_schema.
 */
import { describe, it, expect, afterEach } from "vitest";
import { formatToolDescriptions, getToolManifestMode } from "./agent-loop.js";
import type { AgentTool } from "./tools/types.js";

function makeTool(name: string, description: string): AgentTool {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    },
    execute: async () => ({ content: "ok" }),
  };
}

describe("formatToolDescriptions (Epic #502 / Issue #503)", () => {
  const tools: AgentTool[] = [
    makeTool("search_code", "Search code graph for symbols"),
    makeTool("read_file", "Read contents of a file"),
    makeTool("list_symbols", "List all symbols in a file"),
  ];

  describe("compact mode", () => {
    it("produces one-line-per-tool format", () => {
      const result = formatToolDescriptions(tools, "compact");
      expect(result).toContain("search_code: Search code graph for symbols");
      expect(result).toContain("read_file: Read contents of a file");
      expect(result).toContain("list_symbols: List all symbols in a file");
    });

    it("does not include parameter details", () => {
      const result = formatToolDescriptions(tools, "compact");
      expect(result).not.toContain("query: string");
      expect(result).not.toContain("limit: number");
    });

    it("mentions get_tool_schema for parameter discovery", () => {
      const result = formatToolDescriptions(tools, "compact");
      expect(result).toContain("get_tool_schema");
    });

    it("produces significantly fewer characters than full mode", () => {
      // Generate 34 tools to simulate realistic scenario
      const manyTools: AgentTool[] = Array.from({ length: 34 }, (_, i) =>
        makeTool(`tool_${i}`, `Description for tool number ${i} which does something useful`),
      );

      const compact = formatToolDescriptions(manyTools, "compact");
      const full = formatToolDescriptions(manyTools, "full");

      // Compact should be meaningfully smaller (no parameter details)
      expect(compact.length).toBeLessThan(full.length * 0.7);
    });
  });

  describe("full mode", () => {
    it("includes parameter details", () => {
      const result = formatToolDescriptions(tools, "full");
      expect(result).toContain("query: string");
      expect(result).toContain("limit: number");
    });

    it("includes descriptions for parameters", () => {
      const result = formatToolDescriptions(tools, "full");
      expect(result).toContain("Search query");
    });
  });

  it("returns empty string for no tools", () => {
    expect(formatToolDescriptions([], "compact")).toBe("");
    expect(formatToolDescriptions([], "full")).toBe("");
  });

  describe("getToolManifestMode", () => {
    const originalEnv = process.env.TOOL_MANIFEST_MODE;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.TOOL_MANIFEST_MODE;
      } else {
        process.env.TOOL_MANIFEST_MODE = originalEnv;
      }
    });

    it("defaults to compact", () => {
      delete process.env.TOOL_MANIFEST_MODE;
      expect(getToolManifestMode()).toBe("compact");
    });

    it("returns full when env set", () => {
      process.env.TOOL_MANIFEST_MODE = "full";
      expect(getToolManifestMode()).toBe("full");
    });
  });
});
