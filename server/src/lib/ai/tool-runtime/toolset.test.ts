/**
 * #140 — the session's toolset: registry tools with JSON-Schema parameters,
 * MCP tools only from servers the project may use (and only tools each
 * server's governance admits), code tools, the agent allowlist, provider-safe
 * wire names, and registry execution that can only ever run the one call the
 * gate already decided.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../tool-registry.js";
import type { ToolDefinition } from "../types.js";
import { buildSessionToolset, CHAT_EXCLUDED_TOOLS, toWireName } from "./toolset.js";
import { zodToJsonSchema, toolParametersSchema } from "./json-schema.js";

const CTX = { sessionId: "s1", userId: "u1", projectId: "p1" };

function def(name: string, over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({ q: z.string() }),
    risk: "low",
    exec: vi.fn(async (args: { q: string }) => ({ text: `ran ${name}:${args.q}` })),
    ...over,
  } as ToolDefinition;
}

function registryWith(...defs: ToolDefinition[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const d of defs) r.register(d);
  return r;
}

const mcpDef = (server: string, tool: string) =>
  def(`mcp:${server}:${tool}`, {
    schema: z.record(z.unknown()),
    origin: { kind: "mcp", serverId: `srv-${server}`, serverLabel: server },
  });

describe("buildSessionToolset", () => {
  it("offers registry tools with their JSON Schema and a wire-safe name", async () => {
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(def("inspect_schema")),
    });
    expect(set.specs()).toEqual([
      {
        name: "inspect_schema",
        description: "inspect_schema tool",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    ]);
  });

  it("never offers a tool that reaches beyond the project", async () => {
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(def("search-knowledge-global"), def("search-knowledge")),
    });
    expect(CHAT_EXCLUDED_TOOLS.has("search-knowledge-global")).toBe(true);
    expect(set.tools.map((t) => t.name)).toEqual(["search-knowledge"]);
  });

  it("offers MCP tools only from servers the project may use", async () => {
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(mcpDef("github", "list_issues"), mcpDef("evil", "exfiltrate")),
      mcp: {
        allowedServerIds: async (projectId) => new Set(projectId === "p1" ? ["srv-github"] : []),
        governance: async () => ({ allowlist: null, requireApproval: false }),
      },
    });
    expect(set.tools.map((t) => t.name)).toEqual(["mcp:github:list_issues"]);
    const t = set.tools[0]!;
    expect(t.source).toBe("mcp");
    expect(t.wireName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(set.resolve(t.wireName)).toBe(t);
    expect(set.resolve("mcp:github:list_issues")).toBe(t);
  });

  it("offers no MCP tool when the MCP subsystem is absent or its lookup fails", async () => {
    const reg = registryWith(mcpDef("github", "list_issues"));
    expect((await buildSessionToolset({ ctx: CTX, registry: reg })).tools).toEqual([]);
    const failing = await buildSessionToolset({
      ctx: CTX,
      registry: reg,
      mcp: {
        allowedServerIds: async () => {
          throw new Error("db down");
        },
        governance: async () => ({ allowlist: null, requireApproval: false }),
      },
    });
    expect(failing.tools).toEqual([]);
  });

  it("honours per-server governance: tool allowlist and requireApproval", async () => {
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(mcpDef("github", "list_issues"), mcpDef("github", "delete_repo")),
      mcp: {
        allowedServerIds: async () => new Set(["srv-github"]),
        governance: async () => ({ allowlist: ["list_issues"], requireApproval: true }),
      },
    });
    expect(set.tools.map((t) => t.name)).toEqual(["mcp:github:list_issues"]);
    expect(set.tools[0]!.forcePrompt).toBe(true);
  });

  it("drops a server whose governance is gone or unreadable", async () => {
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(mcpDef("a", "x"), mcpDef("b", "y")),
      mcp: {
        allowedServerIds: async () => new Set(["srv-a", "srv-b"]),
        governance: async (id) => {
          if (id === "srv-a") return null;
          throw new Error("unreadable");
        },
      },
    });
    expect(set.tools).toEqual([]);
  });

  it("offers only what the agent allowlist admits", async () => {
    const codeTool = {
      name: "search_code_graph",
      description: "graph",
      parameters: { type: "object" },
      execute: vi.fn(async () => ({ content: "hit", resultCount: 1 })),
    };
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(def("inspect_schema"), def("query_database")),
      codeTools: [codeTool],
      agentAllowlist: ["inspect_schema"],
    });
    expect(set.tools.map((t) => t.name)).toEqual(["inspect_schema"]);
  });

  it("code tools execute against the session's project only", async () => {
    const execute = vi.fn(async () => ({ content: "hit", resultCount: 3 }));
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(),
      codeTools: [
        { name: "search_code_graph", description: "g", parameters: { type: "object" }, execute },
      ],
    });
    const t = set.tools[0]!;
    expect(t.risk).toBe("low");
    expect(t.validate({ query: "x" })).toEqual({ ok: true, args: { query: "x" } });
    expect(t.validate([1])).toEqual({ ok: false });
    await expect(t.execute({ query: "x" }, CTX)).resolves.toEqual({ text: "hit", resultCount: 3 });
    expect(execute).toHaveBeenCalledWith({ query: "x" }, { projectId: "p1" });
    await expect(t.execute({}, { ...CTX, projectId: null })).resolves.toMatchObject({
      isError: true,
    });
  });

  it("registry execution runs exactly the decided call, marked gate-decided", async () => {
    const d = def("inspect_schema");
    const set = await buildSessionToolset({ ctx: CTX, registry: registryWith(d) });
    const t = set.tools[0]!;
    expect(t.validate({ q: "x" }).ok).toBe(true);
    expect(t.validate({ nope: 1 }).ok).toBe(false);
    await expect(t.execute({ q: "x" }, CTX)).resolves.toEqual({ text: "ran inspect_schema:x" });
    expect(d.exec).toHaveBeenCalledWith(
      { q: "x" },
      expect.objectContaining({
        sessionId: "s1",
        userId: "u1",
        projectId: "p1",
        gateDecided: true,
      }),
    );
  });

  it("a tool's raw exception text is turned into a failure, never returned as a result", async () => {
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(
        def("inspect_schema", {
          exec: async () => {
            throw new Error("password=hunter2");
          },
        }),
      ),
    });
    await expect(set.tools[0]!.execute({ q: "x" }, CTX)).rejects.toThrow();
  });
});

describe("toWireName", () => {
  it("keeps a valid name and makes an invalid one safe and unique", () => {
    expect(toWireName("search_code_graph", new Set())).toBe("search_code_graph");
    const a = toWireName("mcp:a:b.c", new Set());
    const b = toWireName("mcp:a_b:c", new Set());
    expect(a).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(a).not.toBe(b);
    expect(toWireName("x".repeat(200), new Set()).length).toBeLessThanOrEqual(64);
    expect(toWireName("dup", new Set(["dup"]))).not.toBe("dup");
  });
});

describe("zodToJsonSchema", () => {
  it("covers the shapes registry tools use", () => {
    const schema = z.object({
      s: z.string().describe("text"),
      n: z.number().int(),
      f: z.number(),
      b: z.boolean().optional(),
      a: z.array(z.string()),
      e: z.enum(["x", "y"]),
      l: z.literal("k"),
      r: z.record(z.unknown()),
      u: z.union([z.string(), z.number()]),
      d: z.string().default("d"),
      nn: z.string().nullable(),
      t: z.string().transform((v) => v.trim()),
      any: z.any(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        s: { type: "string", description: "text" },
        n: { type: "integer" },
        f: { type: "number" },
        b: { type: "boolean" },
        a: { type: "array", items: { type: "string" } },
        e: { type: "string", enum: ["x", "y"] },
        l: { const: "k" },
        r: { type: "object" },
        u: { anyOf: [{ type: "string" }, { type: "number" }] },
        d: { type: "string" },
        nn: { type: "string" },
        t: { type: "string" },
        any: {},
      },
      required: ["s", "n", "f", "a", "e", "l", "r", "u", "nn", "t", "any"],
    });
  });

  it("top-level parameters are always an object schema", () => {
    expect(toolParametersSchema(z.record(z.unknown()))).toEqual({ type: "object" });
    expect(toolParametersSchema(z.string())).toEqual({ type: "object", properties: {} });
  });
});

describe("MCP requireApproval is read per call, not per toolset (#128 review)", () => {
  it("switching requireApproval on mid-turn forces the next call's prompt", async () => {
    let requireApproval = false;
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(mcpDef("github", "list_issues")),
      mcp: {
        allowedServerIds: async () => new Set(["srv-github"]),
        governance: async () => ({ allowlist: null, requireApproval }),
      },
    });
    const t = set.tools[0]!;
    expect(t.forcePrompt).toBeUndefined();
    await expect(t.forcePromptNow!()).resolves.toBe(false);
    requireApproval = true;
    await expect(t.forcePromptNow!()).resolves.toBe(true);
  });

  it("governance gone by call time forces the prompt", async () => {
    let gone = false;
    const set = await buildSessionToolset({
      ctx: CTX,
      registry: registryWith(mcpDef("github", "list_issues")),
      mcp: {
        allowedServerIds: async () => new Set(["srv-github"]),
        governance: async () => (gone ? null : { allowlist: null, requireApproval: false }),
      },
    });
    gone = true;
    await expect(set.tools[0]!.forcePromptNow!()).resolves.toBe(true);
  });
});
