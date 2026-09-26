/**
 * Epic #128 — the tool runtime through the REAL `/api/ai/stream`, `/api/ai/chat`
 * and approval routes. Only Prisma, the provider (a scripted offline stub that
 * makes native tool calls) and the MCP server's transport are stubbed; the MCP
 * lifecycle manager, tool bridge, ToolRegistry, approval gate, broker and
 * transcript store are the production code.
 *
 *   #140 — the session's tools are offered natively; an MCP tool from a server
 *          the project may use is callable end to end; one from a server it may
 *          not use is never offered; calls and results land in the transcript.
 *   #142 — a tool that needs approval NEVER runs without the owner's approval:
 *          another user, another session, a forged id, a replay and a late
 *          answer are all refused; a denial and an expiry are recorded; an agent
 *          allowlist refuses a tool even under `auto`.
 *   #143 — `tool_event` frames carry the lifecycle; no raw exception text
 *          reaches the stream or the transcript.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { z } from "zod";
import type { FakeAiMessageRow } from "./helpers/fake-ai-message.js";

type Row = Record<string, unknown>;
const sessions: Row[] = [];
const agents = new Map<string, { tools: string }>();
const approvalRows = vi.hoisted(() => [] as Row[]);
const aiMessageRows = vi.hoisted(() => [] as FakeAiMessageRow[]);

vi.mock("../src/lib/prisma.js", async () => {
  const { createFakeAiMessageDelegate } = await import("./helpers/fake-ai-message.js");
  const generic = (): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async () => (method === "findMany" ? [] : method === "count" ? 0 : null)),
      },
    );
  const aISession = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `sess_${sessions.length + 1}`,
        userId: data.userId,
        projectId: data.projectId ?? null,
        title: "t",
        provider: data.provider,
        model: data.model,
        policy: data.policy,
        status: "active",
        providerSecretRef: null,
        agentId: data.agentId ?? null,
        loadedSkillIds: "[]",
        snapshot: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      sessions.push(row);
      return row;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        sessions.find((s) => s.id === where.id && s.userId === where.userId) ?? null,
    ),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = sessions.find((s) => s.id === where.id) as Row;
      Object.assign(row, data);
      return row;
    }),
  };
  const project = {
    findUnique: vi.fn(async () => ({ workspaceId: null, contextCompactionThreshold: null })),
    findFirst: vi.fn(async () => ({ aiProviderId: null, aiModel: null })),
  };
  const aIToolApproval = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      approvalRows.push(data);
      return data;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        approvalRows.find(
          (r) =>
            r.sessionId === where.sessionId &&
            r.toolName === where.toolName &&
            r.risk === where.risk &&
            r.decision === where.decision,
        ) ?? null,
    ),
    findMany: vi.fn(async () => []),
  };
  const agent = {
    findFirst: vi.fn(async ({ where }: { where: Row }) => agents.get(String(where.id)) ?? null),
  };
  const models: Record<string, unknown> = {
    aISession,
    project,
    aIToolApproval,
    agent,
    aIMessage: createFakeAiMessageDelegate(aiMessageRows),
  };
  const prisma: Record<string, unknown> = new Proxy(models, {
    get: (target, key: string) => {
      if (key === "$transaction") return async (fn: (tx: unknown) => unknown) => fn(prisma);
      if (!(key in target)) target[key] = generic();
      return target[key];
    },
  });
  return { prisma };
});

import { aiRouter, setAIProviderForTests } from "../src/routes/ai.js";
import { __resetAIRateLimiter } from "../src/middleware/ai-rate-limit.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import {
  OfflineStubProvider,
  type OfflineScriptTurn,
} from "../src/lib/ai/providers/offline-stub-provider.js";
import { __resetToolRegistrySingleton, getToolRegistry } from "../src/lib/ai/tool-registry.js";
import {
  __resetToolApprovalBroker,
  getToolApprovalBroker,
} from "../src/lib/ai/tool-runtime/approval-broker.js";
import { MCPLifecycleManager } from "../src/lib/mcp/lifecycle-manager.js";
import { MCPToolBridge } from "../src/lib/mcp/tool-bridge.js";
import { setMCPRegistry, type MCPRegistryService } from "../src/lib/mcp/mcp-service.js";
import type { MCPServerConfig, MCPTransportClient } from "../src/lib/mcp/types.js";
import type { ToolDefinition } from "../src/lib/ai/types.js";

// ── Tools ─────────────────────────────────────────────────────────────────
const dangerExec = vi.fn(async (args: { table: string }) => ({ text: `rows in ${args.table}: 7` }));
const boomExec = vi.fn(async () => {
  throw new Error("connect ECONNREFUSED db.internal:5432 password=hunter2");
});
function registerMetisTools(): void {
  getToolRegistry().register({
    name: "count_rows",
    description: "Count rows in a table",
    schema: z.object({ table: z.string() }),
    risk: "high",
    exec: dangerExec,
  } as ToolDefinition);
  getToolRegistry().register({
    name: "flaky_tool",
    description: "Fails",
    schema: z.object({}),
    risk: "low",
    exec: boomExec,
  } as ToolDefinition);
}

// ── A stub MCP server behind the real lifecycle manager + bridge ────────────
const mcpCalls: Array<{ name: string; args: unknown }> = [];
function mcpTransport(): MCPTransportClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    closed: vi.fn(() => new Promise(() => undefined)),
    request: vi.fn(async (m: string, params?: unknown) => {
      if (m === "initialize") return { protocolVersion: "2025-06-18" };
      if (m === "tools/list") {
        return {
          tools: [
            {
              name: "list_issues",
              description: "List open issues",
              inputSchema: {
                type: "object",
                properties: { repo: { type: "string" } },
                required: ["repo"],
              },
            },
          ],
        };
      }
      if (m === "tools/call") {
        const p = params as { name: string; arguments: unknown };
        mcpCalls.push({ name: p.name, args: p.arguments });
        return { content: "3 open issues", isError: false };
      }
      throw new Error(`unexpected ${m}`);
    }),
  };
}
function mcpConfig(id: string, label: string): MCPServerConfig {
  return {
    id,
    scope: "global",
    projectId: null,
    label,
    transport: "stdio",
    runtime: "native",
    command: "node",
    args: null,
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    trustLevel: "trusted",
    defaultToolRisk: "low",
    version: null,
    sha256: null,
    healthCheckIntervalSec: 60,
    enabled: true,
  };
}
const ALLOWED = new Set(["srv-gh"]);
const mcpRegistry = {
  listForProject: vi.fn(async (projectId: string) =>
    projectId === "proj-1" ? [...ALLOWED].map((id) => ({ id })) : [],
  ),
  readGovernance: vi.fn(async () => ({ allowlist: null, requireApproval: false })),
  getAllowList: vi.fn(async (projectId: string) => (projectId === "proj-1" ? [...ALLOWED] : [])),
  getApprovedSnapshot: vi.fn(async () => ({ snapshot: null })),
};
let lifecycle: MCPLifecycleManager;
let bridge: MCPToolBridge;

// ── Harness ───────────────────────────────────────────────────────────────
let alice: string;
let mallory: string;
beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.AI_RATE_LIMIT_MAX = "1000";
  process.env.AI_RATE_LIMIT_WINDOW_MS = "60000";
  const tok = (userId: string, username: string) =>
    issueTokens({ userId, username, role: "developer", permissions: [] }).accessToken;
  alice = tok("alice", "alice");
  mallory = tok("mallory", "mallory");
});

beforeEach(async () => {
  sessions.length = 0;
  aiMessageRows.length = 0;
  approvalRows.length = 0;
  mcpCalls.length = 0;
  agents.clear();
  dangerExec.mockClear();
  boomExec.mockClear();
  __resetAIRateLimiter();
  __resetToolApprovalBroker();
  __resetToolRegistrySingleton();
  registerMetisTools();
  setMCPRegistry(mcpRegistry as unknown as MCPRegistryService);
  lifecycle = new MCPLifecycleManager({
    resolveEnv: async (e) => e,
    transportFactory: () => mcpTransport(),
  });
  bridge = new MCPToolBridge(lifecycle, mcpRegistry as unknown as MCPRegistryService);
  bridge.attach();
  await lifecycle.start(mcpConfig("srv-gh", "github"));
  await lifecycle.start(mcpConfig("srv-evil", "evil"));
});

afterEach(async () => {
  bridge.shutdown();
  await lifecycle.stopAll();
  setAIProviderForTests(null);
  delete process.env.AI_TOOL_APPROVAL_TIMEOUT_MS;
  vi.clearAllMocks();
});

afterAll(() => {
  setMCPRegistry(null);
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", aiRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`);

async function newSession(
  app: express.Express,
  opts: { projectId?: string | null; policy?: Record<string, string>; agentId?: string } = {},
): Promise<string> {
  const res = await as(
    alice,
    request(app)
      .post("/api/ai/sessions")
      .send({ title: "t", ...(opts.policy ? { policy: opts.policy } : {}) }),
  );
  expect(res.status).toBe(201);
  const id = res.body.data.session.id as string;
  const row = sessions.find((s) => s.id === id) as Row;
  row.projectId = opts.projectId === undefined ? "proj-1" : opts.projectId;
  if (opts.agentId) row.agentId = opts.agentId;
  return id;
}

function stubModel(script: OfflineScriptTurn[]): OfflineStubProvider {
  const p = new OfflineStubProvider({ script });
  setAIProviderForTests(p);
  return p;
}

function frames(sse: string, event: string): Array<Record<string, unknown>> {
  return sse
    .split("\n\n")
    .filter((f) => f.startsWith(`event: ${event}\n`))
    .map((f) =>
      JSON.parse(
        f
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      ),
    );
}

/** The tool parts of the reply the transcript recorded. */
function recordedToolParts(): Array<Record<string, unknown>> {
  const reply = aiMessageRows.filter((r) => r.role === "assistant").at(-1)!;
  return (JSON.parse(reply.content) as Array<Record<string, unknown>>).filter((p) =>
    String(p.type).startsWith("tool_"),
  );
}

async function waitForPending(sessionId: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const pending = getToolApprovalBroker().listPending(sessionId, "alice");
    if (pending.length > 0) return pending[0]!.approvalId;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval was requested");
}

function stream(app: express.Express, sessionId: string, token = alice) {
  return as(token, request(app).post("/api/ai/stream").send({ sessionId, message: "go" }));
}

function decide(
  app: express.Express,
  token: string,
  sessionId: string,
  approvalId: string,
  decision: "approve" | "deny" = "approve",
) {
  return as(
    token,
    request(app).post(`/api/ai/sessions/${sessionId}/approvals/${approvalId}`).send({ decision }),
  );
}

// ── #140 ────────────────────────────────────────────────────────────────
describe("#140 native tools in chat", () => {
  it("offers the session's tools natively — including an allowed MCP server's, never another's", async () => {
    const model = stubModel([{ content: "hello" }]);
    const app = makeApp();
    const sid = await newSession(app);
    const res = await stream(app, sid);
    expect(res.status).toBe(200);
    const offered = model.requests[0]!.opts.tools!.map((t) => t.name);
    expect(offered).toContain("count_rows");
    expect(offered.some((n) => n.startsWith("mcp_github_list_issues"))).toBe(true);
    expect(offered.some((n) => n.includes("evil"))).toBe(false);
    // The MCP server's own argument schema is what the model is shown.
    const gh = model.requests[0]!.opts.tools!.find((t) => t.name.startsWith("mcp_github"))!;
    expect(gh.parameters).toMatchObject({ required: ["repo"] });
    expect(gh.description).toContain("List open issues");
    // The untrusted-result note rides in the system lead only when tools do.
    expect(
      model.requests[0]!.messages.some((m) => String(m.content).includes("METIS-DATA-BOUNDARY")),
    ).toBe(true);
  });

  it("an allowed MCP tool is callable end to end, and the call is in the transcript", async () => {
    const probe = stubModel([{ content: "x" }]);
    const app = makeApp();
    const sid0 = await newSession(app);
    await stream(app, sid0);
    const wire = probe.requests[0]!.opts.tools!.find((t) => t.name.startsWith("mcp_github"))!.name;

    stubModel([
      { toolCalls: [{ id: "c1", name: wire, args: { repo: "openzigs/metis" } }] },
      { content: "There are 3 open issues." },
    ]);
    const sid = await newSession(app);
    const res = await stream(app, sid);
    expect(mcpCalls).toEqual([{ name: "list_issues", args: { repo: "openzigs/metis" } }]);
    expect(
      frames(res.text, "delta")
        .map((d) => d.content)
        .join(""),
    ).toContain("3 open issues");
    const parts = recordedToolParts();
    expect(parts[0]).toMatchObject({ type: "tool_call", id: "c1", name: "mcp:github:list_issues" });
    expect(parts[1]).toMatchObject({
      type: "tool_result",
      toolCallId: "c1",
      text: "3 open issues",
      decision: "auto-approve",
    });
  });

  it("a model naming a disallowed server's tool gets nothing run", async () => {
    stubModel([
      { toolCalls: [{ id: "c1", name: "mcp:evil:list_issues", args: { repo: "x" } }] },
      { content: "ok" },
    ]);
    const app = makeApp();
    const sid = await newSession(app);
    const res = await stream(app, sid);
    expect(mcpCalls).toEqual([]);
    expect(frames(res.text, "tool_event").at(-1)).toMatchObject({ code: "TOOL_UNKNOWN" });
  });

  it("an unscoped session is offered no tools (#1368)", async () => {
    const model = stubModel([{ content: "hi" }]);
    const app = makeApp();
    const sid = await newSession(app, { projectId: null });
    await stream(app, sid);
    expect(model.requests[0]!.opts.tools).toBeUndefined();
  });

  it("CHAT_TOOLS=false offers no METIS/MCP tools", async () => {
    process.env.CHAT_TOOLS = "false";
    try {
      const model = stubModel([{ content: "hi" }]);
      const app = makeApp();
      const sid = await newSession(app);
      await stream(app, sid);
      expect(model.requests[0]!.opts.tools).toBeUndefined();
    } finally {
      delete process.env.CHAT_TOOLS;
    }
  });
});

// ── #142 ────────────────────────────────────────────────────────────────
describe("#142 the approval gate through the routes", () => {
  const highCall: OfflineScriptTurn = {
    toolCalls: [{ id: "c1", name: "count_rows", args: { table: "users" } }],
  };

  it("never runs without approval; refuses every other party; runs once for the owner", async () => {
    stubModel([highCall, { content: "7 rows." }]);
    const app = makeApp();
    const sid = await newSession(app);
    const other = await newSession(app);
    // supertest is lazy: `.then` sends it.
    const pending = stream(app, sid).then((r) => r);
    const approvalId = await waitForPending(sid);
    expect(dangerExec).not.toHaveBeenCalled();

    // Another user (even naming the right session), another session, a forged id.
    expect((await decide(app, mallory, sid, approvalId)).status).toBe(404);
    expect((await decide(app, alice, other, approvalId)).status).toBe(404);
    expect((await decide(app, alice, sid, "apr_00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
    expect((await decide(app, alice, sid, "../../etc")).status).toBe(404);
    expect(dangerExec).not.toHaveBeenCalled();
    // The pending list is the owner's alone.
    expect(
      (await as(mallory, request(app).get(`/api/ai/sessions/${sid}/approvals/pending`))).status,
    ).toBe(404);
    const listed = await as(alice, request(app).get(`/api/ai/sessions/${sid}/approvals/pending`));
    expect(listed.body.data.items).toEqual([
      expect.objectContaining({ approvalId, toolName: "count_rows", callId: "c1" }),
    ]);

    expect((await decide(app, alice, sid, approvalId)).status).toBe(200);
    const res = await pending;
    expect(dangerExec).toHaveBeenCalledTimes(1);
    // Replay after it was used.
    expect((await decide(app, alice, sid, approvalId)).status).toBe(404);
    expect(dangerExec).toHaveBeenCalledTimes(1);

    const phases = frames(res.text, "tool_event").map((e) => e.phase);
    expect(phases).toEqual(["started", "awaiting_approval", "result"]);
    expect(recordedToolParts()[1]).toMatchObject({ decision: "approve", text: "rows in users: 7" });
  });

  it("a denial is recorded, the tool never runs, the model is told", async () => {
    const model = stubModel([highCall, { content: "Understood." }]);
    const app = makeApp();
    const sid = await newSession(app);
    // supertest is lazy: `.then` sends it.
    const pending = stream(app, sid).then((r) => r);
    const approvalId = await waitForPending(sid);
    expect((await decide(app, alice, sid, approvalId, "deny")).status).toBe(200);
    const res = await pending;
    expect(dangerExec).not.toHaveBeenCalled();
    expect(frames(res.text, "tool_event").at(-1)).toMatchObject({ code: "TOOL_DENIED" });
    expect(recordedToolParts()[1]).toMatchObject({
      decision: "deny",
      executed: false,
      isError: true,
      errorCode: "TOOL_DENIED",
    });
    const toolMsg = model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(String(toolMsg.content)).toMatch(/denied/);
  });

  it("an unanswered approval expires, never runs, and a late answer is refused", async () => {
    process.env.AI_TOOL_APPROVAL_TIMEOUT_MS = "60";
    stubModel([highCall, { content: "No answer, so I did not run it." }]);
    const app = makeApp();
    const sid = await newSession(app);
    // supertest is lazy: `.then` sends it.
    const pending = stream(app, sid).then((r) => r);
    const approvalId = await waitForPending(sid);
    const res = await pending;
    expect((await decide(app, alice, sid, approvalId)).status).toBe(404);
    expect(dangerExec).not.toHaveBeenCalled();
    expect(frames(res.text, "tool_event").at(-1)).toMatchObject({ code: "TOOL_APPROVAL_EXPIRED" });
    expect(recordedToolParts()[1]).toMatchObject({ decision: "expired", executed: false });
    expect(approvalRows.map((r) => r.decision)).toEqual(["expired"]);
  });

  it("policy=deny refuses without asking; auto runs without asking", async () => {
    stubModel([highCall, { content: "done" }]);
    const app = makeApp();
    const denied = await newSession(app, { policy: { high: "deny" } });
    await stream(app, denied);
    expect(dangerExec).not.toHaveBeenCalled();
    expect(getToolApprovalBroker().size).toBe(0);

    stubModel([highCall, { content: "done" }]);
    const auto = await newSession(app, { policy: { high: "auto" } });
    await stream(app, auto);
    expect(dangerExec).toHaveBeenCalledTimes(1);
  });

  it("an agent allowlist refuses a tool outside it EVEN under auto — and never offers it", async () => {
    agents.set("agent-1", { tools: JSON.stringify(["mcp:github:*"]) });
    const model = stubModel([highCall, { content: "done" }]);
    const app = makeApp();
    const sid = await newSession(app, { policy: { high: "auto" }, agentId: "agent-1" });
    const res = await stream(app, sid);
    const offered = model.requests[0]!.opts.tools!.map((t) => t.name);
    expect(offered.every((n) => n.startsWith("mcp_github"))).toBe(true);
    expect(dangerExec).not.toHaveBeenCalled();
    // Not offered ⇒ resolved as unknown; the gate would refuse it too (unit-tested).
    expect(frames(res.text, "tool_event").at(-1)).toMatchObject({ phase: "error" });
  });

  it("an agent that can no longer be read gets no tools at all (fails closed)", async () => {
    const model = stubModel([{ content: "hi" }]);
    const app = makeApp();
    const sid = await newSession(app, { agentId: "deleted-agent" });
    await stream(app, sid);
    expect(model.requests[0]!.opts.tools).toBeUndefined();
  });

  it("the non-streaming /chat route runs the same gate", async () => {
    stubModel([highCall, { content: "done" }]);
    const app = makeApp();
    const sid = await newSession(app);
    const pending = as(
      alice,
      request(app).post("/api/ai/chat").send({ sessionId: sid, message: "go" }),
    ).then((r) => r);
    const approvalId = await waitForPending(sid);
    expect(dangerExec).not.toHaveBeenCalled();
    await decide(app, alice, sid, approvalId, "approve");
    const res = await pending;
    expect(res.status).toBe(200);
    expect(dangerExec).toHaveBeenCalledTimes(1);
    expect(recordedToolParts()[1]).toMatchObject({ decision: "approve" });
  });

  it("time spent waiting on a person does not count against the stream's hard ceiling", async () => {
    process.env.AI_STREAM_MAX_DURATION_MS = "150";
    try {
      stubModel([highCall, { content: "7 rows." }]);
      const app = makeApp();
      const sid = await newSession(app);
      const pending = stream(app, sid).then((r) => r);
      const approvalId = await waitForPending(sid);
      await new Promise((r) => setTimeout(r, 300)); // twice the ceiling
      expect((await decide(app, alice, sid, approvalId)).status).toBe(200);
      const res = await pending;
      expect(frames(res.text, "error")).toEqual([]);
      expect(dangerExec).toHaveBeenCalledTimes(1);
      expect(
        frames(res.text, "delta")
          .map((d) => d.content)
          .join(""),
      ).toContain("7 rows.");
    } finally {
      delete process.env.AI_STREAM_MAX_DURATION_MS;
    }
  });

  it("streams each native turn's text as it arrives, separated, and records it all", async () => {
    stubModel([
      {
        content: "Let me count.",
        toolCalls: [{ id: "c1", name: "count_rows", args: { table: "t" } }],
      },
      { content: "There are 7." },
    ]);
    const app = makeApp();
    const sid = await newSession(app, { policy: { high: "auto" } });
    const res = await stream(app, sid);
    const text = frames(res.text, "delta")
      .map((d) => d.content)
      .join("");
    expect(text).toBe("Let me count.\n\nThere are 7.");
    const reply = aiMessageRows.filter((r) => r.role === "assistant").at(-1)!;
    expect(reply.content).toContain("There are 7.");
    expect(reply.content).toContain("Let me count.");
    // #713's summary frame is kept for existing clients.
    expect(frames(res.text, "tool_call")).toEqual([
      { type: "tool_call", name: "count_rows", arguments: { table: "t" } },
    ]);
  });

  it("a turn that ends mid-investigation streams the substitute answer too", async () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({
      toolCalls: [{ id: `c${i}`, name: "count_rows", args: { table: `t${i}` } }],
    }));
    stubModel(calls);
    const app = makeApp();
    const sid = await newSession(app, { policy: { high: "auto" } });
    const res = await stream(app, sid);
    const text = frames(res.text, "delta")
      .map((d) => d.content)
      .join("");
    expect(text).toMatch(/tool-call limit/);
  });

  it("MCP requireApproval forces a prompt even under auto — asked once, run once", async () => {
    mcpRegistry.readGovernance.mockResolvedValue({ allowlist: null, requireApproval: true });
    try {
      const probe = stubModel([{ content: "x" }]);
      const app = makeApp();
      await stream(app, await newSession(app));
      const wire = probe.requests[0]!.opts.tools!.find((t) =>
        t.name.startsWith("mcp_github"),
      )!.name;
      stubModel([
        { toolCalls: [{ id: "c1", name: wire, args: { repo: "r" } }] },
        { content: "done" },
      ]);
      const sid = await newSession(app, { policy: { low: "auto" } });
      const pending = stream(app, sid).then((r) => r);
      const approvalId = await waitForPending(sid);
      expect(mcpCalls).toEqual([]);
      expect((await decide(app, alice, sid, approvalId)).status).toBe(200);
      const res = await pending;
      // The bridge's own (UI-less) per-server prompt is not raised a second time.
      expect(mcpCalls).toHaveLength(1);
      expect(frames(res.text, "tool_event").map((e) => e.phase)).toEqual([
        "started",
        "awaiting_approval",
        "result",
      ]);
    } finally {
      mcpRegistry.readGovernance.mockResolvedValue({ allowlist: null, requireApproval: false });
    }
  });

  it("a turn that fails after a tool ran still records the call (nothing dropped)", async () => {
    const model = stubModel([
      {
        content: "Let me count.",
        toolCalls: [{ id: "c1", name: "count_rows", args: { table: "t" } }],
      },
    ]);
    const original = model.stream.bind(model);
    let n = 0;
    vi.spyOn(model, "stream").mockImplementation((m, o) => {
      n++;
      if (n === 2) {
        return (async function* () {
          throw new Error("upstream 502");
        })();
      }
      return original(m, o);
    });
    const app = makeApp();
    const sid = await newSession(app, { policy: { high: "auto" } });
    const res = await stream(app, sid);
    expect(frames(res.text, "error")).toHaveLength(1);
    expect(dangerExec).toHaveBeenCalledTimes(1);
    const reply = aiMessageRows.filter((r) => r.role === "assistant").at(-1)!;
    expect(reply.finishReason).toBe("error");
    // The text the user already saw is kept with the failed turn.
    expect(reply.content).toContain("Let me count.");
    expect(recordedToolParts()[1]).toMatchObject({
      text: "rows in t: 7",
      decision: "auto-approve",
    });
  });

  it("/chat: a turn that fails after a tool ran still records the call", async () => {
    const model = stubModel([
      { toolCalls: [{ id: "c1", name: "count_rows", args: { table: "t" } }] },
    ]);
    const original = model.chat.bind(model);
    let n = 0;
    vi.spyOn(model, "chat").mockImplementation(async (m, o) => {
      n++;
      if (n === 2) throw new Error("upstream 502");
      return original(m, o);
    });
    const app = makeApp();
    const sid = await newSession(app, { policy: { high: "auto" } });
    const res = await as(
      alice,
      request(app).post("/api/ai/chat").send({ sessionId: sid, message: "go" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(dangerExec).toHaveBeenCalledTimes(1);
    expect(recordedToolParts()[1]).toMatchObject({ text: "rows in t: 7" });
  });

  it("rejects a malformed decision body", async () => {
    stubModel([{ content: "x" }]);
    const app = makeApp();
    const sid = await newSession(app);
    const res = await as(
      alice,
      request(app).post(`/api/ai/sessions/${sid}/approvals/apr_x`).send({ decision: "yes" }),
    );
    expect(res.status).toBe(400);
  });
});

// ── #143 ────────────────────────────────────────────────────────────────
describe("#143 no raw exception text reaches the client", () => {
  it("a throwing tool surfaces only the fixed message — stream and transcript", async () => {
    stubModel([
      { toolCalls: [{ id: "c1", name: "flaky_tool", args: {} }] },
      { content: "The tool failed." },
    ]);
    const app = makeApp();
    const sid = await newSession(app);
    const res = await stream(app, sid);
    expect(boomExec).toHaveBeenCalledTimes(1);
    expect(res.text).not.toContain("hunter2");
    expect(res.text).not.toContain("ECONNREFUSED");
    expect(frames(res.text, "tool_event").at(-1)).toMatchObject({
      phase: "error",
      code: "TOOL_FAILED",
      message: "The tool failed while running.",
    });
    // The transcript (what GET /sessions/:id/messages serves) holds the fixed text too.
    expect(JSON.stringify(aiMessageRows)).not.toContain("hunter2");
    expect(recordedToolParts()[1]).toMatchObject({ errorCode: "TOOL_FAILED", isError: true });
  });
});
