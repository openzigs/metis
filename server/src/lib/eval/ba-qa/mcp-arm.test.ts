/**
 * #2331 — the `mcp` arm's bridge: the tool loop runs the MCP server's own
 * `tools/list`, and every call goes through the MCP client.
 */
import { describe, expect, it, vi } from "vitest";
import { mcpRuntimeTools, toolParameters, toRuntimeResult } from "./mcp-arm.js";
import { ARMS } from "./run.js";

describe("mcpRuntimeTools", () => {
  const client = {
    listTools: vi.fn(async () => ({
      tools: [
        {
          name: "metis_search_symbols",
          description: "Search symbols.",
          inputSchema: {
            type: "object" as const,
            $schema: "http://json-schema.org/draft-07/schema#",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        { name: "metis_list_projects", inputSchema: { type: "object" as const } },
      ],
    })),
    callTool: vi.fn(async () => ({
      content: [{ type: "text", text: '{"result":"hit"}' }],
      structuredContent: { resultCount: 3, truncated: true },
    })),
  };

  it("offers each listed tool under its MCP name, schema and description", async () => {
    const tools = await mcpRuntimeTools(client as never);
    expect(tools.map((t) => [t.name, t.wireName, t.source, t.risk])).toEqual([
      ["metis_search_symbols", "metis_search_symbols", "mcp", "low"],
      ["metis_list_projects", "metis_list_projects", "mcp", "low"],
    ]);
    expect(tools[0]!.description).toBe("Search symbols.");
    expect(tools[0]!.parameters).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(tools[1]!.description).toBe("");
  });

  it("calls the tool through the client and reads its result", async () => {
    const [search] = await mcpRuntimeTools(client as never);
    const r = await search!.execute(
      { query: "fee" },
      { sessionId: "s", userId: "u", projectId: null },
    );
    expect(client.callTool).toHaveBeenCalledWith({
      name: "metis_search_symbols",
      arguments: { query: "fee" },
    });
    expect(r).toEqual({ text: '{"result":"hit"}', resultCount: 3, truncated: true });
  });

  it("accepts only an object of arguments", async () => {
    const [search] = await mcpRuntimeTools(client as never);
    expect(search!.validate({ query: "x" })).toEqual({ ok: true, args: { query: "x" } });
    expect(search!.validate(null)).toEqual({ ok: false });
    expect(search!.validate([1])).toEqual({ ok: false });
  });
});

describe("toRuntimeResult", () => {
  it("joins text blocks, keeps an error, and ignores non-text blocks", () => {
    expect(
      toRuntimeResult({
        isError: true,
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "x" },
          { type: "text", text: "b" },
        ],
      }),
    ).toEqual({ text: "a\nb", isError: true });
    expect(toRuntimeResult({})).toEqual({ text: "" });
    expect(
      toRuntimeResult({ content: [{ type: "text" }], structuredContent: { resultCount: null } }),
    ).toEqual({
      text: "",
    });
  });
});

describe("toolParameters", () => {
  it("drops only $schema", () => {
    expect(toolParameters({ $schema: "x", type: "object", required: ["a"] })).toEqual({
      type: "object",
      required: ["a"],
    });
  });
});

describe("the mcp arm", () => {
  it("runs tools-only's flags, so the pair differs in the tool surface alone", () => {
    expect(ARMS.mcp).toEqual(ARMS["tools-only"]);
  });
});
