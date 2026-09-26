/**
 * Epic #129 (#147) — sub-agents as tools, unit level: the budget, the depth
 * and allowlist rules for WHICH agents an owner may call, and every way a run
 * can end (definition gone, no longer callable, budget spent before or during,
 * provider failure, abort, a model that cannot take tools). Every run that
 * starts is recorded; no raw exception text reaches the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinitionDto } from "@metis/shared";

const approvals = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const rows = vi.hoisted(() => ({
  custom: new Map<string, Record<string, unknown>>(),
  library: new Map<string, Record<string, unknown>>(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    aIToolApproval: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        approvals.push(data);
        return data;
      }),
      findFirst: vi.fn(async () => null),
    },
    customAgent: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => rows.custom.get(where.id) ?? null,
      ),
    },
    agent: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => rows.library.get(where.id) ?? null,
      ),
    },
    skill: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));

import { OfflineStubProvider } from "../ai/providers/offline-stub-provider.js";
import { makeToolset } from "../ai/tool-runtime/toolset.js";
import type { RuntimeTool } from "../ai/tool-runtime/types.js";
import type { AIProvider } from "../ai/types.js";
import {
  SubAgentBudget,
  loadSubAgentLimits,
  subAgentTools,
  type AgentToolsContext,
  type SubAgentRunRecord,
  type SubAgentRunStore,
} from "./subagents.js";

function def(id: string, over: Partial<AgentDefinitionDto> = {}): AgentDefinitionDto {
  return {
    ref: `custom:${id}`,
    kind: "custom",
    id,
    key: id,
    name: `Agent ${id}`,
    description: "",
    persona: `You are ${id}.`,
    skillKeys: [],
    toolAllowlist: null,
    model: null,
    reasoningEffort: null,
    approvalPolicy: null,
    version: "1.0.0",
    projectId: "p1",
    ...over,
  };
}

function storeRow(d: AgentDefinitionDto) {
  rows.custom.set(d.id, {
    id: d.id,
    projectId: d.projectId,
    name: d.name,
    description: d.description,
    systemPrompt: d.persona,
    tools: JSON.stringify(d.toolAllowlist ?? []),
    model: d.model,
    reasoningEffort: d.reasoningEffort,
    skillKeys: "[]",
    approvalPolicy: null,
    version: d.version,
  });
}

function tool(name: string, run = vi.fn(async () => ({ text: `${name} ran` }))): RuntimeTool {
  return {
    name,
    wireName: name,
    description: name,
    parameters: { type: "object" },
    risk: "low",
    source: "metis",
    validate: (a) => ({ ok: true, args: a }),
    execute: run,
  };
}

function memoryStore() {
  const created: Array<Record<string, unknown>> = [];
  const completed = new Map<string, SubAgentRunRecord>();
  const store: SubAgentRunStore = {
    async create(input) {
      created.push(input);
      return { id: `run-${created.length}` };
    },
    async complete(id, r) {
      completed.set(id, r);
    },
  };
  return { store, created, completed };
}

function ctxFor(provider: AIProvider, over: Partial<AgentToolsContext> = {}): AgentToolsContext {
  return {
    provider,
    model: "m",
    session: {
      id: "s1",
      userId: "u1",
      projectId: "p1",
      policy: JSON.stringify({ low: "auto", medium: "auto", high: "auto" }),
    },
    callable: [],
    limits: { maxDepth: 2, tokenBudget: 1_000_000, maxTurns: 6 },
    budget: new SubAgentBudget(1_000_000),
    ...over,
  };
}

const rctx = { sessionId: "s1", userId: "u1", projectId: "p1", callId: "call-1" };

beforeEach(() => {
  approvals.length = 0;
  rows.custom.clear();
  rows.library.clear();
});
afterEach(() => {
  delete process.env.SUBAGENT_MAX_DEPTH;
});

describe("SubAgentBudget", () => {
  it("charges totals (or prompt + completion) and reports exhaustion", () => {
    const b = new SubAgentBudget(10);
    b.charge({ totalTokens: 4 });
    b.charge({ promptTokens: 3, completionTokens: 2 });
    expect(b.spent).toBe(9);
    expect(b.exhausted).toBe(false);
    b.charge({ totalTokens: Number.NaN });
    b.charge(undefined);
    expect(b.spent).toBe(9);
    b.charge({ totalTokens: 1 });
    expect(b.exhausted).toBe(true);
  });
});

describe("loadSubAgentLimits", () => {
  it("defaults, and reads the operator's knobs", () => {
    expect(loadSubAgentLimits()).toEqual({ maxDepth: 2, tokenBudget: 200_000, maxTurns: 6 });
    process.env.SUBAGENT_MAX_DEPTH = "1";
    expect(loadSubAgentLimits().maxDepth).toBe(1);
  });
});

describe("subAgentTools — which agents an owner may call", () => {
  const a = def("alpha");
  const b = def("beta");
  const provider = new OfflineStubProvider({ script: [] });

  it("none at or past the depth limit", () => {
    const ctx = ctxFor(provider, { callable: [a, b] });
    const owner = { runId: null, allowlist: null, baseToolset: makeToolset([]) };
    expect(subAgentTools(ctx, { ...owner, depth: 1 }, new Set())).toHaveLength(2);
    expect(subAgentTools(ctx, { ...owner, depth: 2 }, new Set())).toHaveLength(0);
  });

  it("only the agents the owner's allowlist admits, never itself; readable, unique wire names", () => {
    const twin = def("alpha2", { key: "alpha" });
    const ctx = ctxFor(provider, { callable: [a, b, twin] });
    const taken = new Set<string>();
    const tools = subAgentTools(
      ctx,
      {
        depth: 0,
        runId: null,
        allowlist: ["agent:custom:alpha", "agent:custom:alpha2"],
        baseToolset: makeToolset([]),
        selfRef: "custom:beta",
      },
      taken,
    );
    expect(tools.map((t) => t.name)).toEqual(["agent:custom:alpha", "agent:custom:alpha2"]);
    expect(tools[0]!.wireName).toBe("agent_alpha");
    expect(tools[1]!.wireName).not.toBe("agent_alpha");
    expect(tools[1]!.wireName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(tools.every((t) => t.risk === "medium" && t.source === "agent")).toBe(true);
  });

  it("validates the delegated task before anything runs", () => {
    const [t] = subAgentTools(
      ctxFor(provider, { callable: [a] }),
      { depth: 0, runId: null, allowlist: null, baseToolset: makeToolset([]) },
      new Set(),
    );
    expect(t!.validate({ task: "do it" }).ok).toBe(true);
    expect(t!.validate({ task: "   " }).ok).toBe(false);
    expect(t!.validate({ task: "x".repeat(20_001) }).ok).toBe(false);
    expect(t!.validate({ task: "x", extra: true }).ok).toBe(false);
    expect(t!.validate("do it").ok).toBe(false);
  });
});

describe("running a sub-agent", () => {
  function setup(
    provider: AIProvider,
    target: AgentDefinitionDto,
    over: Partial<AgentToolsContext> = {},
    base: RuntimeTool[] = [],
  ) {
    const mem = memoryStore();
    const ctx = ctxFor(provider, { callable: [target], store: mem.store, ...over });
    const [t] = subAgentTools(
      ctx,
      { depth: 0, runId: null, allowlist: null, baseToolset: makeToolset(base) },
      new Set(),
    );
    return { t: t!, ...mem, ctx };
  }

  it("the definition is gone at call time: refused, nothing recorded, no model call", async () => {
    const provider = new OfflineStubProvider({ script: [{ content: "x" }] });
    const { t, created } = setup(provider, def("gone"));
    const r = await t.execute({ task: "go" }, rctx);
    expect(r.isError).toBe(true);
    expect(created).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("no longer callable for the project at call time: refused", async () => {
    const d = def("x");
    storeRow(d);
    const provider = new OfflineStubProvider({ script: [{ content: "x" }] });
    const { t } = setup(provider, d, { isCallable: async () => false });
    expect((await t.execute({ task: "go" }, rctx)).isError).toBe(true);
    expect(provider.requests).toHaveLength(0);
  });

  it("budget already spent: the run is recorded as budget_exhausted and never calls the model", async () => {
    const d = def("x");
    storeRow(d);
    const provider = new OfflineStubProvider({ script: [{ content: "x" }] });
    const budget = new SubAgentBudget(5);
    budget.charge({ totalTokens: 5 });
    const { t, completed } = setup(provider, d, { budget });
    const r = await t.execute({ task: "go" }, rctx);
    expect(r).toMatchObject({ isError: true, subAgentRunId: "run-1" });
    expect(completed.get("run-1")!.status).toBe("budget_exhausted");
    expect(provider.requests).toHaveLength(0);
  });

  it("budget runs out mid-run: stopped, recorded, the partial answer kept", async () => {
    const d = def("x", { toolAllowlist: ["noop"] });
    storeRow(d);
    const provider = new OfflineStubProvider({
      script: [
        {
          content: "partial",
          toolCalls: [{ id: "t1", name: "noop", args: {} }],
          usage: { totalTokens: 50 },
        },
        { content: "never" },
      ],
    });
    const { t, completed } = setup(provider, d, { budget: new SubAgentBudget(10) }, [tool("noop")]);
    const r = await t.execute({ task: "go" }, rctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("token budget");
    expect(completed.get("run-1")).toMatchObject({ status: "budget_exhausted", result: "partial" });
    expect(provider.requests).toHaveLength(1);
  });

  it("a provider failure: recorded as failed, the caller gets a fixed message (no exception text)", async () => {
    const d = def("x");
    storeRow(d);
    const provider = {
      key: "openai",
      model: "m",
      capabilities: { nativeToolCalls: true },
      chat: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1 password=hunter2");
      }),
    } as unknown as AIProvider;
    const { t, completed } = setup(provider, d, {}, [tool("noop")]);
    const r = await t.execute({ task: "go" }, rctx);
    expect(r.text).toBe("Error: the agent failed before it finished.");
    expect(r.text).not.toContain("hunter2");
    expect(completed.get("run-1")!.status).toBe("failed");
  });

  it("an abort propagates (the turn is being stopped) and the run is recorded as aborted", async () => {
    const d = def("x");
    storeRow(d);
    const provider = {
      key: "openai",
      model: "m",
      capabilities: { nativeToolCalls: true },
      chat: vi.fn(async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }),
    } as unknown as AIProvider;
    const { t, completed } = setup(provider, d, {}, [tool("noop")]);
    await expect(t.execute({ task: "go" }, rctx)).rejects.toThrow("aborted");
    expect(completed.get("run-1")!.status).toBe("aborted");
  });

  it("a model that cannot take tools: one text-only call, no tools sent, the task framed", async () => {
    const d = def("x", { toolAllowlist: null });
    storeRow(d);
    const provider = new OfflineStubProvider(); // not tool-capable
    const chat = vi.spyOn(provider, "chat");
    const { t, completed } = setup(provider, d, {}, [tool("noop")]);
    const r = await t.execute({ task: "summarise" }, rctx);
    expect(r.isError).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(1);
    const [msgs, opts] = chat.mock.calls[0]!;
    expect(opts!.tools).toBeUndefined();
    expect(opts!.disableTools).toBe(true);
    expect(msgs).toEqual([{ role: "user", content: "<TASK>\nsummarise\n</TASK>" }]);
    expect(completed.get("run-1")!.status).toBe("completed");
  });

  it("its tools are the caller's INTERSECTED with its allowlist; a withheld one is refused and recorded, never run", async () => {
    const d = def("x", { toolAllowlist: ["read"] });
    storeRow(d);
    const writeRun = vi.fn(async () => ({ text: "wrote" }));
    const readRun = vi.fn(async () => ({ text: "read ok" }));
    const provider = new OfflineStubProvider({
      script: [
        { toolCalls: [{ id: "w", name: "write", args: {} }] },
        { toolCalls: [{ id: "r", name: "read", args: {} }] },
        { content: "done" },
      ],
    });
    const { t, completed } = setup(provider, d, {}, [
      tool("read", readRun),
      tool("write", writeRun),
    ]);
    await t.execute({ task: "go" }, rctx);
    expect(provider.requests[0]!.opts.tools!.map((x) => x.name)).toEqual(["read"]);
    expect(writeRun).not.toHaveBeenCalled();
    expect(readRun).toHaveBeenCalledTimes(1);
    expect(approvals.find((a) => a.toolName === "write")).toMatchObject({
      decision: "deny",
      reason: "not_in_agent_allowlist",
      sessionId: "s1",
      userId: "u1",
    });
    expect(completed.get("run-1")!.toolCalls.map((c) => [c.tool, c.executed])).toEqual([
      ["write", false],
      ["read", true],
    ]);
  });

  it("an agent with NO allowlist (a library agent declaring no tools) inherits exactly the caller's tools — never more", async () => {
    const d = def("lib", {
      ref: "library:lib",
      kind: "library",
      toolAllowlist: null,
      projectId: null,
    });
    rows.library.set("lib", {
      id: "lib",
      key: "lib",
      name: "lib",
      displayName: "Lib",
      description: "",
      systemPrompt: "You are lib.",
      tools: "[]",
      model: "",
      version: "1.0.0",
      enabled: true,
      archivedAt: null,
      deletedAt: null,
      skills: [],
    });
    const provider = new OfflineStubProvider({ script: [{ content: "done" }] });
    const { t } = setup(provider, d, {}, [tool("read")]);
    await t.execute({ task: "go" }, rctx);
    expect(provider.requests[0]!.opts.tools!.map((x) => x.name)).toEqual(["read"]);
  });

  it("the agent's approval override tightens its own gate (a low tool prompts; no prompter ⇒ denied)", async () => {
    const d = def("x", { toolAllowlist: ["read"] });
    storeRow(d);
    rows.custom.get("x")!.approvalPolicy = JSON.stringify({ low: "always-prompt" });
    const readRun = vi.fn(async () => ({ text: "read ok" }));
    const provider = new OfflineStubProvider({
      script: [{ toolCalls: [{ id: "r", name: "read", args: {} }] }, { content: "done" }],
    });
    const broker = { request: vi.fn(async () => "deny" as const) };
    const { t } = setup(provider, d, { broker: broker as never }, [tool("read", readRun)]);
    await t.execute({ task: "go" }, rctx);
    expect(broker.request).toHaveBeenCalledTimes(1);
    expect(readRun).not.toHaveBeenCalled();
    expect(approvals.find((a) => a.toolName === "read")).toMatchObject({ decision: "deny" });
  });
});
