/**
 * #238 — an agent's tool allowlist names only tools METIS really has.
 *
 * The four seeded built-in custom agents named `search_documents`, `search_code`
 * and `record_project_memory`, which no tool carries — so, the allowlist being
 * matched exactly, every built-in ran with NO tools. The check is now ONE
 * function (`agent-runtime/tool-refs.ts`) shared by library and custom agents,
 * applied on save and when the built-ins are seeded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const db = vi.hoisted(() => ({
  created: [] as unknown[],
  updated: [] as unknown[],
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    skill: { findMany: vi.fn(async () => []) },
    customAgent: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "ag_1"
          ? {
              id: "ag_1",
              projectId: "p1",
              name: "Mine",
              description: "",
              systemPrompt: "x",
              tools: "[]",
              model: null,
              reasoningEffort: null,
              isBuiltIn: false,
              version: "1.0.0",
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null,
      ),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.created.push(data);
        return {
          id: `ag_${db.created.length}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.updated.push(data);
        return { id: "ag_1", createdAt: new Date(), updatedAt: new Date(), ...data };
      }),
      upsert: vi.fn(async () => ({})),
    },
  },
}));

const { agentSelectableTools, knownToolNames, unknownToolRefs, visibleTools } =
  await import("../src/lib/agent-runtime/tool-refs.js");
const { CHAT_CODE_TOOL_NAMES } = await import("../src/lib/analysis/tools/chat-code-tool-names.js");
const { ToolRegistry, __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { __resetSearchKnowledgeRegistration, registerSearchKnowledgeTool } =
  await import("../src/lib/rag/search-knowledge-tool.js");
const { registerSearchKnowledgeGlobalTool } =
  await import("../src/lib/rag/search-knowledge-global-tool.js");
const {
  BUILT_IN_AGENTS,
  CustomAgentError,
  assertKnownTools,
  createAgent,
  ensureBuiltInAgents,
  updateAgent,
} = await import("../src/lib/custom-agents/index.js");
const { prisma } = await import("../src/lib/prisma.js");

function registryWith(...names: string[]): InstanceType<typeof ToolRegistry> {
  const r = new ToolRegistry();
  for (const name of names) {
    r.register({
      name,
      description: name,
      schema: z.object({}),
      risk: "low",
      exec: async () => ({ text: "" }),
    } as never);
  }
  return r;
}

beforeEach(() => {
  db.created.length = 0;
  db.updated.length = 0;
  vi.mocked(prisma.customAgent.upsert).mockClear();
  vi.mocked(prisma.customAgent.create).mockClear();
  __resetToolRegistrySingleton();
  __resetSearchKnowledgeRegistration();
});

describe("#238 unknownToolRefs — one check for both kinds of agent", () => {
  const known = knownToolNames(registryWith("count_rows", "mcp:github:create_issue"));

  it("accepts registered tools, the chat code tools and the agent tools", () => {
    expect(
      unknownToolRefs(
        [
          "count_rows",
          "search_code_graph",
          "search_code_symbols",
          "mcp:*",
          "mcp:github:*",
          "mcp:github:create_issue",
          "load_skill",
          "agent:*",
          "agent:library:*",
          "agent:custom:*",
          "agent:custom:c-helper",
          "agent:library:a-lead",
        ],
        known,
      ),
    ).toEqual([]);
  });

  it("rejects every name no tool carries — the old built-in names included", () => {
    expect(
      unknownToolRefs(
        [
          "search_documents",
          "search_code",
          "record_project_memory",
          "*",
          "mcp:gitlab:*",
          "agent:bogus",
          "agent:custom:../x",
          "Count_Rows",
        ],
        known,
      ),
    ).toEqual([
      "search_documents",
      "search_code",
      "record_project_memory",
      "*",
      "mcp:gitlab:*",
      "agent:bogus",
      "agent:custom:../x",
      "Count_Rows",
    ]);
  });
});

describe("#340 a user-scope MCP server's tools are never valid agent refs", () => {
  function registryWithMcp(
    tools: Array<{ name: string; scope: "global" | "project" | "user" }>,
  ): InstanceType<typeof ToolRegistry> {
    const r = new ToolRegistry();
    for (const t of tools) {
      const [, label] = t.name.split(":");
      r.register({
        name: t.name,
        description: t.name,
        schema: z.object({}),
        risk: "low",
        origin: { kind: "mcp", serverId: `srv-${label}`, serverLabel: label, serverScope: t.scope },
        exec: async () => ({ text: "" }),
      } as never);
    }
    return r;
  }
  const registry = registryWithMcp([
    { name: "mcp:mine:read", scope: "user" },
    { name: "mcp:shared:read", scope: "global" },
    { name: "mcp:team:read", scope: "project" },
  ]);

  it("drops them from the known names — a running one included — and keeps other scopes", () => {
    const known = knownToolNames(registry);
    expect(known.has("mcp:mine:read")).toBe(false);
    expect(known.has("mcp:shared:read")).toBe(true);
    expect(known.has("mcp:team:read")).toBe(true);
  });

  it("so an agent save naming one (or its server prefix) is refused as unknown", () => {
    expect(() => assertKnownTools(["mcp:mine:read"], registry)).toThrow(
      /Unknown tools: mcp:mine:read/,
    );
    expect(() => assertKnownTools(["mcp:mine:*"], registry)).toThrow(/Unknown tools: mcp:mine:\*/);
    expect(() => assertKnownTools(["mcp:shared:read", "mcp:team:*"], registry)).not.toThrow();
  });

  it("fails closed on a registry without describeAll — never lists a user tool unfiltered", () => {
    // Only `describeAll` carries a tool's origin; a registry offering just
    // `list` cannot be filtered, so reading it must throw rather than count
    // another user's server tool as known.
    const listOnly = {
      list: () => [{ name: "mcp:mine:read", description: "x", risk: "low" as const }],
    };
    expect(() => knownToolNames(listOnly as never)).toThrow(TypeError);
    expect(() => assertKnownTools(["mcp:mine:read"], listOnly as never)).toThrow(TypeError);
  });
});

describe("#340 visibleTools — the GET /api/ai/tools listing", () => {
  const r = new ToolRegistry();
  const add = (name: string, origin?: Record<string, unknown>) =>
    r.register({
      name,
      description: name,
      schema: z.object({}),
      risk: "low",
      ...(origin ? { origin } : {}),
      exec: async () => ({ text: "" }),
    } as never);
  add("count_rows");
  add("mcp:shared:read", {
    kind: "mcp",
    serverId: "g",
    serverLabel: "shared",
    serverScope: "global",
  });
  add("mcp:alice:read", {
    kind: "mcp",
    serverId: "a",
    serverLabel: "alice",
    serverScope: "user",
    serverOwnerId: "u-alice",
  });
  add("mcp:orphan:read", {
    kind: "mcp",
    serverId: "o",
    serverLabel: "orphan",
    serverScope: "user",
    serverOwnerId: null,
  });
  const names = (userId: string, role: string) =>
    visibleTools(r, { userId, role }).map((t) => t.name);

  it("lists a user server's tools to its owner, not to anyone else; an ownerless one to admins only", () => {
    expect(names("u-alice", "coordinator")).toEqual([
      "count_rows",
      "mcp:shared:read",
      "mcp:alice:read",
    ]);
    expect(names("u-bob", "coordinator")).toEqual(["count_rows", "mcp:shared:read"]);
    expect(names("u-admin", "admin")).toEqual([
      "count_rows",
      "mcp:shared:read",
      "mcp:alice:read",
      "mcp:orphan:read",
    ]);
  });

  it("returns the list() descriptor shape — no origin or schema leaves it", () => {
    for (const t of visibleTools(r, { userId: "u-admin", role: "admin" })) {
      expect(Object.keys(t).sort()).toEqual(["description", "name", "risk"]);
    }
  });
});

describe("#727 agentSelectableTools — the authoring picker offers the code tools", () => {
  const r = new ToolRegistry();
  r.register({
    name: "search-knowledge",
    description: "kb",
    schema: z.object({}),
    risk: "low",
    exec: async () => ({ text: "" }),
  } as never);
  r.register({
    name: "mcp:alice:read",
    description: "a",
    schema: z.object({}),
    risk: "low",
    origin: {
      kind: "mcp",
      serverId: "a",
      serverLabel: "alice",
      serverScope: "user",
      serverOwnerId: "u-alice",
    },
    exec: async () => ({ text: "" }),
  } as never);

  it("lists the registry's visible tools and then every chat code tool, as low risk", () => {
    const listed = agentSelectableTools(r, { userId: "u-bob", role: "coordinator" });
    expect(listed.map((t) => t.name)).toEqual([
      "search-knowledge",
      "search_code_graph",
      "search_code_symbols",
      "read_file_slice",
    ]);
    for (const t of listed.slice(1)) {
      expect(t.risk).toBe("low");
      expect(t.description.length).toBeGreaterThan(0);
      expect(Object.keys(t).sort()).toEqual(["description", "name", "risk"]);
    }
  });

  it("offers code tools the save accepts — never a code tool the save would refuse", () => {
    const listed = agentSelectableTools(r, { userId: "u-bob", role: "coordinator" }).map(
      (t) => t.name,
    );
    expect(unknownToolRefs(listed, knownToolNames(r))).toEqual([]);
    for (const code of CHAT_CODE_TOOL_NAMES) expect(listed).toContain(code);
  });

  it("lists a code tool once when the registry already carries one of that name", () => {
    const dup = new ToolRegistry();
    dup.register({
      name: "read_file_slice",
      description: "registry copy",
      schema: z.object({}),
      risk: "medium",
      exec: async () => ({ text: "" }),
    } as never);
    const listed = agentSelectableTools(dup, { userId: "u", role: "admin" });
    expect(listed.filter((t) => t.name === "read_file_slice")).toEqual([
      { name: "read_file_slice", description: "registry copy", risk: "medium" },
    ]);
  });
});

describe("#238 the built-in custom agents", () => {
  it("name only tools the boot registry (or the chat code tools) really carries", () => {
    // The two knowledge tools `server.ts` registers before it seeds the built-ins.
    registerSearchKnowledgeTool();
    registerSearchKnowledgeGlobalTool();
    const known = knownToolNames(getToolRegistry());
    for (const def of BUILT_IN_AGENTS) {
      expect(unknownToolRefs(def.tools, known), def.name).toEqual([]);
    }
    // Deliberate: every built-in but the PO carries at least one tool.
    expect(BUILT_IN_AGENTS.filter((d) => d.tools.length === 0).map((d) => d.name)).toEqual(["PO"]);
  });

  it("are refused LOUDLY, before any row is written, when a built-in names an unknown tool", async () => {
    // An empty registry: `search-knowledge` is not registered, so BA's list is unknown.
    await expect(ensureBuiltInAgents(registryWith())).rejects.toThrow(
      /Built-in agent BA: Unknown tools: search-knowledge/,
    );
    expect(prisma.customAgent.create).not.toHaveBeenCalled();
    expect(prisma.customAgent.upsert).not.toHaveBeenCalled();
  });

  it("are seeded when every tool they name is registered", async () => {
    await expect(ensureBuiltInAgents(registryWith("search-knowledge"))).resolves.toBeUndefined();
  });
});

describe("#238 saving a custom agent", () => {
  beforeEach(() => registerSearchKnowledgeTool());

  it("rejects an unknown tool name on create, and writes nothing", async () => {
    await expect(
      createAgent({
        projectId: "p1",
        name: "Typo",
        description: "",
        systemPrompt: "x",
        tools: ["search-knowledge", "search_documents"],
      }),
    ).rejects.toThrow(new CustomAgentError("Unknown tools: search_documents"));
    expect(db.created).toHaveLength(0);
  });

  it("rejects an unknown tool name on update, and writes nothing", async () => {
    await expect(updateAgent("ag_1", { tools: ["record_project_memory"] })).rejects.toThrow(
      /Unknown tools: record_project_memory/,
    );
    expect(db.updated).toHaveLength(0);
  });

  it("accepts a known tool on create and on update", async () => {
    const created = await createAgent({
      projectId: "p1",
      name: "Fine",
      description: "",
      systemPrompt: "x",
      tools: ["search-knowledge", "search_code_graph", "agent:*"],
    });
    expect(created.tools).toEqual(["search-knowledge", "search_code_graph", "agent:*"]);
    await updateAgent("ag_1", { tools: ["search-knowledge"] });
    expect(db.updated).toHaveLength(1);
  });

  it("assertKnownTools: an empty or absent list is always fine (no tools at all)", () => {
    expect(() => assertKnownTools([], registryWith())).not.toThrow();
    expect(() => assertKnownTools(undefined, registryWith())).not.toThrow();
  });
});
