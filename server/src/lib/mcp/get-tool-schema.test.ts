/**
 * Epic #502 / Issue #503 — Unit tests for get_tool_schema internal tool.
 */
import { describe, it, expect } from "vitest";
import { createGetToolSchemaTool } from "./get-tool-schema.js";
import type { AgentTool, ToolContext } from "../analysis/tools/types.js";

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    execute: async () => ({ content: "ok" }),
  };
}

const toolContext: ToolContext = { projectId: "test" };

describe("createGetToolSchemaTool", () => {
  const tools = [makeTool("search_code"), makeTool("read_file"), makeTool("list_symbols")];
  const schemaTool = createGetToolSchemaTool({ tools });

  it("has correct name and description", () => {
    expect(schemaTool.name).toBe("get_tool_schema");
    expect(schemaTool.description).toContain("schema");
  });

  it("returns schema for a known tool", async () => {
    const result = await schemaTool.execute({ tool_name: "search_code" }, toolContext);
    const parsed = JSON.parse(result.content);
    expect(parsed.name).toBe("search_code");
    expect(parsed.parameters.type).toBe("object");
    expect(parsed.parameters.properties.query).toBeDefined();
  });

  it("returns error for unknown tool", async () => {
    const result = await schemaTool.execute({ tool_name: "nonexistent" }, toolContext);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("Unknown tool");
    expect(parsed.available).toContain("search_code");
  });

  it("returns error when tool_name is missing", async () => {
    const result = await schemaTool.execute({}, toolContext);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("tool_name is required");
  });

  it("returns error when tool_name is not a string", async () => {
    const result = await schemaTool.execute({ tool_name: 123 }, toolContext);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("tool_name is required");
  });
});
