/**
 * #1050 — the built-in Business Analyst (and the other built-in personas whose
 * role reads requirements) can read the project's requirements in chat.
 *
 * Before: BA allowlisted only `search-knowledge`, so a chat bound to it was
 * never OFFERED `list_requirements` / `get_requirement` — the allowlist is
 * matched exactly. These tests drive the real chat path: `resolveSessionTools`
 * for a session bound to the built-in (`custom:<id>`) on a tool-capable model,
 * with the real requirement tools in the registry, and then execute the
 * offered tool with the context the chat route builds
 * (`{ sessionId, userId, projectId: session.projectId }`, routes/ai.ts).
 *
 * Security: the tools stay scoped to the CHAT's project — a requirement in
 * another project is neither listed nor readable by id, even when the model
 * tries to name a project — and a session in a project that has not enabled
 * the built-in fails closed (no tools at all).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

interface ReqRow {
  id: string;
  projectId: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  labels: string;
  reviewStatus: string | null;
  acceptanceCriteria: string;
  verdict: string | null;
  coverage: string | null;
  externalUrl: string | null;
  implementedByPr: number | null;
  deletedAt: Date | null;
  _count: { codeMappings: number; dataMappings: number };
  dataMappings: unknown[];
}

const state = vi.hoisted(() => ({
  agents: new Map<string, Record<string, unknown>>(),
  /** `${customAgentId}:${projectId}` → enabled */
  enabled: new Set<string>(),
  requirements: [] as ReqRow[],
}));

vi.mock("../src/lib/prisma.js", () => {
  type Where = { id?: string; projectId?: string; deletedAt?: null };
  const matches = (r: ReqRow, w: Where) =>
    (w.id === undefined || r.id === w.id) &&
    (w.projectId === undefined || r.projectId === w.projectId) &&
    (w.deletedAt !== null || r.deletedAt === null);
  return {
    prisma: {
      customAgent: {
        findUnique: vi.fn(
          async ({ where }: { where: { id: string } }) => state.agents.get(where.id) ?? null,
        ),
        findMany: vi.fn(async () => []),
      },
      customAgentEnablement: {
        findUnique: vi.fn(
          async ({
            where,
          }: {
            where: { customAgentId_projectId: { customAgentId: string; projectId: string } };
          }) => {
            const k = where.customAgentId_projectId;
            return state.enabled.has(`${k.customAgentId}:${k.projectId}`)
              ? { enabled: true }
              : null;
          },
        ),
        findMany: vi.fn(async () => []),
      },
      skill: { findMany: vi.fn(async () => []) },
      agent: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
      projectAgentAllowlist: { findMany: vi.fn(async () => []) },
      // The stub APPLIES the where the tool sends, so a query that dropped the
      // project scope would leak the other project's row into the result.
      requirement: {
        findMany: vi.fn(async ({ where }: { where: Where }) =>
          state.requirements.filter((r) => matches(r, where)),
        ),
        findFirst: vi.fn(
          async ({ where }: { where: Where }) =>
            state.requirements.find((r) => matches(r, where)) ?? null,
        ),
      },
    },
  };
});

const { BUILT_IN_AGENTS } = await import("../src/lib/custom-agents/index.js");
const { ToolRegistry } = await import("../src/lib/ai/tool-registry.js");
const { registerRequirementTools, LIST_REQUIREMENTS_TOOL_NAME, GET_REQUIREMENT_TOOL_NAME } =
  await import("../src/lib/requirements/requirements-chat-tools.js");
const { buildSearchKnowledgeTool } = await import("../src/lib/rag/search-knowledge-tool.js");
const { resolveSessionTools } = await import("../src/lib/ai/tool-runtime/session-tools.js");

const REQ_TOOLS = [LIST_REQUIREMENTS_TOOL_NAME, GET_REQUIREMENT_TOOL_NAME];

function req(id: string, projectId: string, title: string): ReqRow {
  return {
    id,
    projectId,
    title,
    body: `${title} body`,
    type: "feature",
    priority: "high",
    labels: "[]",
    reviewStatus: "approved",
    acceptanceCriteria: "[]",
    verdict: null,
    coverage: null,
    externalUrl: null,
    implementedByPr: null,
    deletedAt: null,
    _count: { codeMappings: 0, dataMappings: 0 },
    dataMappings: [],
  };
}

function builtInId(name: string): string {
  return `builtin-${name}`;
}

function registry() {
  const r = new ToolRegistry();
  r.register(buildSearchKnowledgeTool() as never);
  registerRequirementTools(r, {
    chain: async (projectId, requirementId) => ({
      requirementId,
      requirementTitle: "t",
      projectId,
      specs: [],
      directCode: [],
      testedBy: [],
    }),
  });
  // A tool no built-in names: proves the allowlist still withholds the rest.
  r.register({
    name: "query_database",
    description: "run SQL",
    schema: z.object({}),
    risk: "medium",
    exec: async () => ({ text: "rows" }),
  } as never);
  return r;
}

/** A tool-capable provider (native tool calls) — the in-scope case. */
const toolCapable = {
  name: "stub",
  capabilities: { nativeToolCalls: true, responseFormat: false },
} as never;

async function chatTools(agentName: string, projectId: string) {
  return resolveSessionTools({
    session: {
      id: "s1",
      userId: "u1",
      projectId,
      agentId: null,
      agentRef: `custom:${builtInId(agentName)}`,
    },
    provider: toolCapable,
    model: "m",
    flags: { chatTools: true, codeSearchTools: false, progressiveSkills: false, subAgents: false },
    registry: registry(),
    mcp: null,
  });
}

/** The context `routes/ai.ts` hands the executor: the SESSION's project. */
const ctxFor = (projectId: string) => ({ sessionId: "s1", userId: "u1", projectId });

beforeEach(() => {
  state.agents.clear();
  state.enabled.clear();
  for (const def of BUILT_IN_AGENTS) {
    const id = builtInId(def.name);
    state.agents.set(id, {
      id,
      projectId: null,
      name: def.name,
      description: "",
      systemPrompt: def.systemPrompt,
      tools: JSON.stringify(def.tools),
      skillKeys: null,
      model: null,
      reasoningEffort: null,
      approvalPolicy: null,
      isBuiltIn: true,
      version: "1.0.0",
    });
    // Project p1 has enabled every built-in; p2 has enabled none.
    state.enabled.add(`${id}:p1`);
  }
  state.requirements = [
    req("r-mine", "p1", "Store orders"),
    req("r-theirs", "p2", "Secret payroll rule"),
  ];
});

describe("#1050 built-in persona allowlists", () => {
  const tools = (name: string) => BUILT_IN_AGENTS.find((d) => d.name === name)!.tools;

  it("BA reads the knowledge base AND the project's requirements", () => {
    expect(tools("BA")).toEqual(["search-knowledge", ...REQ_TOOLS]);
  });

  it("Architect, PO and QA also read requirements; none is given a write tool", () => {
    for (const name of ["Architect", "PO", "QA"]) {
      for (const t of REQ_TOOLS) expect(tools(name), name).toContain(t);
    }
    // Every tool any built-in names is read-only (the registry's `low` risk).
    const r = registry();
    const lowRisk = new Set(
      r
        .list()
        .filter((t) => t.risk === "low")
        .map((t) => t.name),
    );
    const codeReadTools = new Set(["search_code_graph", "search_code_symbols"]);
    for (const def of BUILT_IN_AGENTS) {
      for (const t of def.tools) {
        expect(lowRisk.has(t) || codeReadTools.has(t), `${def.name}: ${t}`).toBe(true);
      }
    }
  });
});

describe("#1050 a chat bound to the built-in BA on a tool-capable model", () => {
  it("is OFFERED list_requirements and get_requirement (not just configured)", async () => {
    const rt = await chatTools("BA", "p1");
    expect(rt.mode).toBe("native");
    const offered = rt.toolset.specs().map((s) => s.name);
    expect(offered).toEqual(expect.arrayContaining(["search-knowledge", ...REQ_TOOLS]));
    // The allowlist still withholds everything the BA does not name.
    expect(offered).not.toContain("query_database");
    expect(rt.toolset.withheld("query_database")).toBeDefined();
    // And the gate's allowlist admits both requirement tools.
    for (const t of REQ_TOOLS) expect(rt.agentAllowlist).toContain(t);
  });

  it("lists only the chat project's requirements — another project's never leak", async () => {
    const rt = await chatTools("BA", "p1");
    const list = rt.toolset.resolve(LIST_REQUIREMENTS_TOOL_NAME)!;
    const out = await list.execute({}, ctxFor("p1"));
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("r-mine");
    expect(out.text).not.toContain("r-theirs");
    expect(out.text).not.toContain("payroll");
  });

  it("cannot read another project's requirement by id, even naming that project", async () => {
    const rt = await chatTools("BA", "p1");
    const get = rt.toolset.resolve(GET_REQUIREMENT_TOOL_NAME)!;
    const mine = await get.execute({ requirementId: "r-mine" }, ctxFor("p1"));
    expect(mine.text).toContain("Store orders");

    // The model has no project parameter to name; an extra one is ignored and
    // the read stays scoped to the session's project.
    const theirs = await get.execute({ requirementId: "r-theirs", projectId: "p2" }, ctxFor("p1"));
    expect(theirs.isError).toBe(true);
    expect(theirs.text).not.toContain("payroll");
    const listed = await rt.toolset
      .resolve(LIST_REQUIREMENTS_TOOL_NAME)!
      .execute({ projectId: "p2" }, ctxFor("p1"));
    expect(listed.text).not.toContain("r-theirs");
  });

  it("fails CLOSED in a project that has not enabled the built-in — no requirement tools", async () => {
    const rt = await chatTools("BA", "p2");
    expect(rt.mode).toBe("off");
    expect(rt.toolset.tools).toHaveLength(0);
    expect(rt.toolset.resolve(LIST_REQUIREMENTS_TOOL_NAME)).toBeUndefined();
    expect(rt.agentAllowlist).toEqual([]);
  });
});

describe("#1050 the other built-ins in chat", () => {
  it.each(["Architect", "PO", "QA"])(
    "%s is offered both requirement tools on a tool-capable model",
    async (name) => {
      const rt = await chatTools(name, "p1");
      const offered = rt.toolset.specs().map((s) => s.name);
      expect(offered).toEqual(expect.arrayContaining(REQ_TOOLS));
      expect(offered).not.toContain("query_database");
    },
  );
});
