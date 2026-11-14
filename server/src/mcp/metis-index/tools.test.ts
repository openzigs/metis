/**
 * #2331 — the `metis_*` tool table: the eight names, bounded inputs, the
 * mapping of each tool onto chat's own implementation, and its instructions.
 */
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../../lib/analysis/tools/types.js";
import {
  EMPTY_RESULT_INSTRUCTIONS,
  SOURCE_RESULT_INSTRUCTIONS,
  ZERO_RESULT_INSTRUCTIONS,
} from "../../lib/ai/search-guidance.js";
import {
  findIndexTool,
  INDEX_STATUS_INSTRUCTIONS,
  INDEX_TOOLS,
  LIST_PROJECTS_INSTRUCTIONS,
  MAX_DESCRIPTION_CHARS,
  oneLine,
  type IndexToolContext,
  type IndexToolDef,
} from "./tools.js";

const tool = (name: string): IndexToolDef => {
  const t = findIndexTool(name);
  if (!t) throw new Error(`no ${name}`);
  return t;
};
const parse = (name: string, args: unknown) =>
  z.object(tool(name).inputSchema).safeParse(args).success;

function ctxWith(code: Record<string, AgentTool["execute"]>, reqs = {}): IndexToolContext {
  return {
    caller: { userId: "u1", tokenId: "t1", actor: { userId: "u1" } as never },
    projectId: "p1",
    codeAccess: { unrestricted: true } as never,
    impls: {
      code: new Map(
        Object.entries(code).map(([name, execute]) => [
          name,
          { name, description: "", parameters: { type: "object" }, execute } as AgentTool,
        ]),
      ),
      listRequirements: { schema: z.object({}).passthrough(), exec: vi.fn() } as never,
      getRequirement: { schema: z.object({}).passthrough(), exec: vi.fn() } as never,
      ...reqs,
    },
  };
}

describe("INDEX_TOOLS", () => {
  it("exposes exactly the eight metis_ tools", () => {
    expect(INDEX_TOOLS.map((t) => t.name).sort()).toEqual([
      "metis_graph_callees",
      "metis_graph_callers",
      "metis_index_status",
      "metis_list_projects",
      "metis_read_file_slice",
      "metis_read_requirements",
      "metis_search_code_context",
      "metis_search_symbols",
    ]);
    expect(findIndexTool("speckit_plan")).toBeUndefined();
  });

  it("scopes every tool but metis_list_projects to a required projectId", () => {
    for (const t of INDEX_TOOLS) {
      expect(t.projectScoped, t.name).toBe(t.name !== "metis_list_projects");
      if (t.projectScoped) expect(parse(t.name, {}), t.name).toBe(false);
    }
  });

  it("bounds every string, enum and limit", () => {
    const long = "x".repeat(501);
    expect(parse("metis_search_symbols", { projectId: "p", query: long })).toBe(false);
    expect(parse("metis_search_symbols", { projectId: "p", query: "q", limit: 31 })).toBe(false);
    expect(parse("metis_search_symbols", { projectId: "p", query: "q", limit: 1.5 })).toBe(false);
    expect(parse("metis_search_symbols", { projectId: "p", query: "q", symbolKind: "x" })).toBe(
      false,
    );
    expect(parse("metis_search_symbols", { projectId: "p", query: "q", language: "x" })).toBe(
      false,
    );
    expect(
      parse("metis_search_symbols", { projectId: "p", query: "q", fileGlob: "*".repeat(201) }),
    ).toBe(false);
    expect(
      parse("metis_search_symbols", {
        projectId: "p",
        query: "q",
        limit: 30,
        symbolKind: "function",
        language: "go",
        fileGlob: "internal/**",
      }),
    ).toBe(true);
    expect(parse("metis_search_code_context", { projectId: "p", query: "q", limit: 13 })).toBe(
      false,
    );
    expect(parse("metis_graph_callers", { projectId: "p", symbol: "s".repeat(301) })).toBe(false);
    expect(parse("metis_read_file_slice", { projectId: "p", filePath: "a", startLine: 0 })).toBe(
      false,
    );
    expect(parse("metis_read_requirements", { projectId: "p", status: "open" })).toBe(false);
    expect(parse("metis_read_requirements", { projectId: "p", limit: 101 })).toBe(false);
    expect(parse("metis_index_status", { projectId: "p".repeat(129) })).toBe(false);
  });
});

describe("each tool runs chat's own implementation", () => {
  it.each([
    [
      "metis_search_code_context",
      "search_code_context",
      { query: "fees", limit: 3 },
      { query: "fees", limit: 3 },
    ],
    [
      "metis_search_symbols",
      "search_code_symbols",
      { query: "fees", language: "go" },
      { query: "fees", language: "go" },
    ],
    ["metis_graph_callers", "search_code_graph", { symbol: "Fee" }, { calls: "Fee" }],
    ["metis_graph_callees", "search_code_graph", { symbol: "Fee" }, { calledBy: "Fee" }],
    [
      "metis_read_file_slice",
      "read_file_slice",
      { filePath: "a.go", startLine: 2 },
      { filePath: "a.go", startLine: 2 },
    ],
    ["metis_index_status", "get_index_status", {}, {}],
  ])("%s → %s", async (mcpName, chatName, args, expected) => {
    const execute = vi.fn(async () => ({ content: "ok", resultCount: 1 }));
    const ctx = ctxWith({ [chatName]: execute });
    const r = await tool(mcpName).run({ projectId: "p1", ...args } as never, ctx);
    expect(r).toEqual({ content: "ok", resultCount: 1 });
    expect(execute).toHaveBeenCalledWith(expected, {
      projectId: "p1",
      codeAccess: ctx.codeAccess,
    });
  });

  it("fails loudly when a chat tool was not built", async () => {
    await expect(
      tool("metis_index_status").run({ projectId: "p1" } as never, ctxWith({})),
    ).rejects.toThrow(/get_index_status is not built/);
  });

  it("metis_read_requirements lists, or reads one in full, as the session's user", async () => {
    const list = vi.fn(async () => ({ text: "2 matching", resultCount: 2 }));
    const get = vi.fn(async () => ({ text: "No requirement", isError: true }));
    const ctx = ctxWith(
      {},
      {
        listRequirements: { schema: z.object({}).passthrough(), exec: list },
        getRequirement: { schema: z.object({}).passthrough(), exec: get },
      },
    );
    const run = tool("metis_read_requirements").run;
    expect(await run({ projectId: "p1", status: "approved", query: "fees" } as never, ctx)).toEqual(
      { content: "2 matching", resultCount: 2 },
    );
    expect(list).toHaveBeenCalledWith(
      { status: "approved", query: "fees" },
      { sessionId: "mcp:t1", userId: "u1", projectId: "p1" },
    );
    expect(
      await run({ projectId: "p1", requirementId: "r1", status: "draft" } as never, ctx),
    ).toEqual({ content: "No requirement", isError: true });
    expect(get).toHaveBeenCalledWith(
      { requirementId: "r1" },
      { sessionId: "mcp:t1", userId: "u1", projectId: "p1" },
    );
  });
});

describe("instructions", () => {
  it("are #2324's grounding instructions on the search and read tools", () => {
    for (const name of [
      "metis_search_code_context",
      "metis_search_symbols",
      "metis_graph_callers",
      "metis_read_file_slice",
      "metis_read_requirements",
    ]) {
      const t = tool(name);
      expect(t.instructionsFor({ content: "", resultCount: 2 }), name).toBe(
        SOURCE_RESULT_INSTRUCTIONS,
      );
      expect(t.instructionsFor({ content: "", resultCount: 0 }), name).toBe(
        EMPTY_RESULT_INSTRUCTIONS,
      );
      expect(t.instructionsFor({ content: "", isError: true }), name).toBeUndefined();
    }
    expect(
      tool("metis_graph_callees").instructionsFor({
        content: "",
        resultCount: 0,
        zeroResultKind: "no-call-edges",
      }),
    ).toBe(ZERO_RESULT_INSTRUCTIONS["no-call-edges"]);
  });

  it("are fixed text on the project list and index status", () => {
    expect(tool("metis_list_projects").instructionsFor({ content: "" })).toBe(
      LIST_PROJECTS_INSTRUCTIONS,
    );
    expect(tool("metis_index_status").instructionsFor({ content: "" })).toBe(
      INDEX_STATUS_INSTRUCTIONS,
    );
    expect(tool("metis_index_status").instructionsFor({ content: "", isError: true })).toBe(
      undefined,
    );
    expect(tool("metis_list_projects").instructionsFor({ content: "", isError: true })).toBe(
      undefined,
    );
  });
});

describe("oneLine", () => {
  it("keeps the first non-blank line, trimmed", () => {
    expect(oneLine("\n  Billing service  \nmore")).toBe("Billing service");
    expect(oneLine("")).toBe("");
  });

  it("cuts a long line", () => {
    const out = oneLine("a".repeat(MAX_DESCRIPTION_CHARS + 50));
    expect(out.length).toBe(MAX_DESCRIPTION_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});
