/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #260 (#80/#82/#83) — custom-agents route tests.
 *
 * Covers authoring RBAC (workspace admin), the invocation playground
 * (enabled-gating + IDOR), per-project enablement, and JSON import/export.
 * Prisma + provider are mocked; no real DB or LLM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";

// ---- in-memory prisma -------------------------------------------------------

interface AgentRow {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string;
  model: string | null;
  reasoningEffort: string | null;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const agents = new Map<string, AgentRow>();
const enablements = new Map<string, any>();
const projects = new Map<string, { id: string; workspaceId: string | null }>();
const members = new Map<string, { role: string }>(); // key: `${ws}:${user}`
const auditRows: any[] = [];
let seq = 0;

function reset() {
  agents.clear();
  enablements.clear();
  projects.clear();
  members.clear();
  auditRows.length = 0;
  seq = 0;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async ({ data }: any) => (auditRows.push(data), data)) },
    project: {
      // #561 — answers the membership-row select from the `members` map.
      findUnique: vi.fn(async ({ where, select }: any) => {
        const row = projects.get(where.id);
        if (!row) return null;
        const userId = select?.workspace?.select?.members?.where?.userId;
        if (userId === undefined || !row.workspaceId) return row;
        const member = members.get(`${row.workspaceId}:${userId}`);
        return { ...row, workspace: { deletedAt: null, members: member ? [member] : [] } };
      }),
    },
    workspaceMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        return members.get(`${workspaceId}:${userId}`) ?? null;
      }),
    },
    customAgent: {
      findUnique: vi.fn(async ({ where }: any) => agents.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const r of agents.values())
          if (r.projectId === where.projectId && r.name === where.name) return r;
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const all = [...agents.values()];
        if (where?.id?.in) return all.filter((r) => where.id.in.includes(r.id));
        // Mirror listAgents' where shape so includeBuiltIns gating is testable.
        if (where?.OR) {
          return all.filter((r) =>
            where.OR.some((c: any) => {
              if (c.projectId === null && c.isBuiltIn === true)
                return r.projectId === null && r.isBuiltIn;
              return r.projectId === c.projectId;
            }),
          );
        }
        if (where?.projectId === null && where?.isBuiltIn === true)
          return all.filter((r) => r.projectId === null && r.isBuiltIn);
        return all;
      }),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const row: AgentRow = {
          id: `ag_${seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        agents.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = agents.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      delete: vi.fn(async ({ where }: any) => {
        agents.delete(where.id);
        return { id: where.id };
      }),
    },
    customAgentEnablement: {
      findUnique: vi.fn(async ({ where }: any) => {
        const k = where.customAgentId_projectId;
        for (const e of enablements.values())
          if (e.customAgentId === k.customAgentId && e.projectId === k.projectId) return e;
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...enablements.values()].filter(
          (e) => e.projectId === where.projectId && e.enabled === where.enabled,
        ),
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const k = where.customAgentId_projectId;
        for (const e of enablements.values())
          if (e.customAgentId === k.customAgentId && e.projectId === k.projectId) {
            Object.assign(e, update, { updatedAt: new Date() });
            return e;
          }
        seq++;
        const row = { id: `en_${seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        enablements.set(row.id, row);
        return row;
      }),
    },
  },
}));

// mutable test user
let testUser: any = {
  userId: "u1",
  username: "alice",
  role: "user",
  permissions: [],
  workspaces: ["w1"],
};

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.user = { ...testUser };
    next();
  },
}));

const stubResponse: ChatResponse = {
  content: "playground answer",
  usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
  model: "stub",
  provider: "offline-stub" as any,
};
const chatMock = vi.fn(async () => stubResponse);
function mockProvider(): AIProvider {
  return { key: "offline-stub", model: "stub", offline: true, chat: chatMock } as any;
}

// #724 — observe project-usage writes without touching the ledger.
const recordUsageSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/finops/token-tracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/finops/token-tracker.js")>()),
  recordUsage: recordUsageSpy,
}));

// #1445 review — the playground route sits behind chat's AI limiter and budget
// gate. Both are observed here; each test decides whether they let it through.
const limiterSpy = vi.hoisted(() =>
  vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
);
vi.mock("../src/middleware/ai-rate-limit.js", () => ({
  aiRateLimiter: (req: unknown, res: unknown, next: () => void) => limiterSpy(req, res, next),
}));
const budgetSpy = vi.hoisted(() => vi.fn(async (_projectId: string) => ({})));
vi.mock("../src/lib/finops/budget-enforcer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/finops/budget-enforcer.js")>()),
  assertWithinBudget: (projectId: string) => budgetSpy(projectId),
}));
const { BudgetExceededError } = await import("../src/lib/finops/budget-enforcer.js");

const { customAgentsRouter } = await import("../src/routes/custom-agents.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/custom-agents", customAgentsRouter({ buildProvider: mockProvider }));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res
      .status(err.statusCode ?? 500)
      .json({ error: { code: err.code ?? "INTERNAL", message: err.message } });
  });
  return app;
}

function seedProject(id: string, workspaceId: string | null) {
  projects.set(id, { id, workspaceId });
}
function seedMember(ws: string, user: string, role: string) {
  members.set(`${ws}:${user}`, { role });
}
/** #1445 — off until enabled: switch `agentId` on for `projectId`. */
function enableFor(agentId: string, projectId: string) {
  seq++;
  enablements.set(`en_${seq}`, {
    id: `en_${seq}`,
    customAgentId: agentId,
    projectId,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
function seedAgent(over: Partial<AgentRow> = {}): AgentRow {
  seq++;
  const row: AgentRow = {
    id: `seed_${seq}`,
    projectId: "p1",
    name: `Agent${seq}`,
    description: "",
    systemPrompt: "You are a test agent.",
    tools: "[]",
    model: null,
    reasoningEffort: null,
    isBuiltIn: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  agents.set(row.id, row);
  return row;
}

beforeEach(() => {
  reset();
  chatMock.mockClear();
  limiterSpy.mockClear();
  budgetSpy.mockReset();
  budgetSpy.mockImplementation(async () => ({}));
  testUser = { userId: "u1", username: "alice", role: "user", permissions: [], workspaces: ["w1"] };
});
afterEach(() => vi.restoreAllMocks());

describe("#1445 review — the pre-auth guard sits in front of requireAuth (CodeQL js/missing-rate-limiting)", () => {
  it("on POST /:id/invoke, GET /projects/:projectId/disabled and /enabled, and PUT /:id/enablement", async () => {
    const { customAgentsPreAuthRateLimiter } =
      await import("../src/middleware/custom-agents-rate-limit.js");
    const { requireAuth } = await import("../src/middleware/auth.js");
    const router = customAgentsRouter({ buildProvider: mockProvider }) as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: unknown }>;
        };
      }>;
    };
    const chain = (method: string, path: string) =>
      router.stack
        .find((l) => l.route?.path === path && l.route.methods[method])!
        .route!.stack.map((s) => s.handle);
    for (const [method, path] of [
      ["post", "/:id/invoke"],
      ["get", "/projects/:projectId/disabled"],
      // #1500
      ["get", "/projects/:projectId/enabled"],
      ["put", "/:id/enablement"],
    ] as const) {
      const handles = chain(method, path);
      expect(handles[0]).toBe(customAgentsPreAuthRateLimiter);
      expect(handles[1]).toBe(requireAuth);
    }
  });
});

describe("POST /custom-agents (create RBAC #80)", () => {
  const body = {
    projectId: "p1",
    name: "Builder",
    description: "",
    systemPrompt: "do work",
    tools: [],
  };

  it("allows a workspace admin to create", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const res = await request(createApp()).post("/custom-agents").send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Builder");
  });

  it("rejects a plain workspace member with 403", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const res = await request(createApp()).post("/custom-agents").send(body);
    expect(res.status).toBe(403);
  });

  it("returns 404 for a non-member (IDOR guard)", async () => {
    seedProject("p1", "w1");
    const res = await request(createApp()).post("/custom-agents").send(body);
    expect(res.status).toBe(404);
  });

  it("system admin bypasses workspace RBAC", async () => {
    testUser.role = "admin";
    seedProject("p1", "w1");
    const res = await request(createApp()).post("/custom-agents").send(body);
    expect(res.status).toBe(201);
  });
});

describe("POST /custom-agents/:id/invoke (#80/#83)", () => {
  it("invokes an agent owned by the caller's project and writes an audit row", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: "p1" });
    enableFor(agent.id, "p1"); // #1445 — a plain member needs it switched on
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe("playground answer");
    // #727 — the API caller is told the answer is prompt-only, not just the UI.
    expect(res.body.data.grounding).toMatchObject({ mode: "prompt-only" });
    expect(res.body.data.grounding.notice).toMatch(/^Ungrounded answer/);
    expect(chatMock).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    const inv = auditRows.find((a) => a.action === "custom_agent.invoked");
    expect(inv).toBeTruthy();
    expect(inv.targetId).toBe(agent.id);
  });

  it("bills the invocation's tokens to the invoking project (#724)", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: "p1" });
    enableFor(agent.id, "p1");
    recordUsageSpy.mockClear();
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(200);
    expect(recordUsageSpy).toHaveBeenCalledTimes(1);
    expect(recordUsageSpy.mock.calls[0]![0]).toMatchObject({
      projectId: "p1",
      // Per agent AND project, so projects sharing an agent do not share a session.
      sessionId: `playground:${agent.id}:p1`,
      inputTokens: 3,
      outputTokens: 4,
    });
  });

  it("404s when the agent is not enabled for the project (IDOR)", async () => {
    seedProject("p1", "w1");
    // agent owned by a DIFFERENT project, not enabled for p1
    const agent = seedAgent({ projectId: "other" });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(404);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("#561 — 404s a caller whose claim still names the workspace after removal", async () => {
    seedProject("p1", "w1"); // claim says w1; no membership row remains
    const agent = seedAgent({ projectId: "p1" });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(404);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("writes a custom_agent.invoke_denied audit row before the 404", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: "other" }); // not enabled for p1
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 0));
    const denied = auditRows.find((a) => a.action === "custom_agent.invoke_denied");
    expect(denied).toBeTruthy();
    expect(denied.targetId).toBe(agent.id);
  });

  it("invokes a workspace-shared agent once enabled for the project", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: null, isBuiltIn: false });
    // enable via the API
    await request(createApp())
      .put(`/custom-agents/${agent.id}/enablement`)
      .send({ projectId: "p1", enabled: true });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(200);
  });

  it("#1005 — refuses the project's own agent once turned off, says why, and runs again once turned on", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: "p1", name: "Go SQL reviewer" });
    await request(createApp())
      .put(`/custom-agents/${agent.id}/enablement`)
      .send({ projectId: "p1", enabled: false });
    const off = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("AGENT_DISABLED");
    // #1500 — says who can switch it back on, in the session notice's words.
    expect(off.body.error.message).toBe(
      '"Go SQL reviewer" is turned off for this project. Ask a workspace admin to switch it back on under Custom agents.',
    );
    expect(chatMock).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(auditRows.find((a) => a.action === "custom_agent.invoke_denied")).toBeTruthy();

    await request(createApp())
      .put(`/custom-agents/${agent.id}/enablement`)
      .send({ projectId: "p1", enabled: true });
    const on = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(on.status).toBe(200);
  });

  it("#1005 — a shared agent turned off again is a 404 like any agent not enabled here", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: null, isBuiltIn: false });
    await request(createApp())
      .put(`/custom-agents/${agent.id}/enablement`)
      .send({ projectId: "p1", enabled: false });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(404);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("#1445 — a newly created agent is off until enabled: the card lists it off and chat/ACP refuse it, but the playground may test it", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const created = await request(createApp()).post("/custom-agents").send({
      projectId: "p1",
      name: "Fresh",
      description: "",
      systemPrompt: "do work",
      tools: [],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    // The card's source (`GET /projects/:id/enabled`): not on.
    const enabled = await request(createApp()).get("/custom-agents/projects/p1/enabled");
    expect(enabled.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
    // Chat's sub-agent tools, the session picker and ACP read this rule: off too.
    const { isCustomAgentUsableInProject, listUsableCustomAgentRows } =
      await import("../src/lib/agent-runtime/definition.js");
    expect(await isCustomAgentUsableInProject({ kind: "custom", id, projectId: "p1" }, "p1")).toBe(
      false,
    );
    expect((await listUsableCustomAgentRows("p1")).map((r) => r.id)).not.toContain(id);

    // The authoring playground is the one exception.
    const tried = await request(createApp())
      .post(`/custom-agents/${id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(tried.status).toBe(200);
    expect(chatMock).toHaveBeenCalledTimes(1);

    // Enabling it turns it on everywhere, in agreement with the card.
    await request(createApp())
      .put(`/custom-agents/${id}/enablement`)
      .send({ projectId: "p1", enabled: true });
    const after = await request(createApp()).get("/custom-agents/projects/p1/enabled");
    expect(after.body.data.map((a: { id: string }) => a.id)).toContain(id);
    expect(await isCustomAgentUsableInProject({ kind: "custom", id, projectId: "p1" }, "p1")).toBe(
      true,
    );
    expect((await listUsableCustomAgentRows("p1")).map((r) => r.id)).toContain(id);
  });

  it("#1445 review — a plain member may NOT run the project's never-enabled agent; once enabled they may", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: "p1", name: "Draft" });
    const off = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("AGENT_DISABLED");
    expect(off.body.error.message).toBe(
      '"Draft" is off for this project until a workspace admin enables it under Custom agents.',
    );
    expect(chatMock).not.toHaveBeenCalled();
    expect(budgetSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    const denied = auditRows.find((a) => a.action === "custom_agent.invoke_denied");
    expect(denied).toBeTruthy();

    enableFor(agent.id, "p1");
    const on = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(on.status).toBe(200);
  });

  it("#1445 review — on a project with no workspace (nobody but a system admin can enable), a member gets the strict rule, not a 400", async () => {
    seedProject("p-open", null);
    const agent = seedAgent({ projectId: "p-open", name: "Open draft" });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p-open", input: "hello" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AGENT_DISABLED");
    // #1500 — there only a system admin can enable it, and the message says so.
    expect(res.body.error.message).toBe(
      '"Open draft" is off for this project until a system admin enables it under Custom agents.',
    );
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("#1500 — a switched-off agent on a project with no workspace names a system admin", async () => {
    seedProject("p-open", null);
    const agent = seedAgent({ projectId: "p-open", name: "Open off" });
    enableFor(agent.id, "p-open");
    for (const row of enablements.values()) if (row.customAgentId === agent.id) row.enabled = false;
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p-open", input: "hello" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      '"Open off" is turned off for this project. Ask a system admin to switch it back on under Custom agents.',
    );
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("#1445 review — a caller outside the project's workspace never reaches the exception (404 before it)", async () => {
    seedProject("p1", "w1");
    testUser.workspaces = []; // claims no workspace: the project itself is out of reach
    const agent = seedAgent({ projectId: "p1" });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(404);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("#1445 review — a system admin may test the project's never-enabled agent", async () => {
    testUser.role = "admin";
    seedProject("p1", "w1");
    const agent = seedAgent({ projectId: "p1" });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(200);
  });

  it("#1445 review — the AI rate limiter runs on the playground, and a refusal stops the call", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: "p1" });
    const ok1 = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(ok1.status).toBe(200);
    expect(limiterSpy).toHaveBeenCalledTimes(1);

    limiterSpy.mockImplementationOnce((_req: unknown, res: any) => {
      res.status(429).json({ success: false, error: { code: "AI_RATE_LIMITED" } });
    });
    chatMock.mockClear();
    const limited = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(limited.status).toBe(429);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("#1445 review — the project budget is checked before the model call; over budget is a 402", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: "p1" });
    await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(budgetSpy).toHaveBeenCalledWith("p1");

    chatMock.mockClear();
    budgetSpy.mockRejectedValueOnce(new BudgetExceededError(1000, 500));
    const over = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe("BUDGET_EXCEEDED");
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("#1445 review — an agent the caller may not run is refused before the budget is read", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const foreign = seedAgent({ projectId: "p2" });
    const res = await request(createApp())
      .post(`/custom-agents/${foreign.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(404);
    expect(budgetSpy).not.toHaveBeenCalled();
  });

  it("#1445 — the playground exception does not reach another project's agent", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const foreign = seedAgent({ projectId: "p2" });
    const res = await request(createApp())
      .post(`/custom-agents/${foreign.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(404);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("rejects an empty input with 400 before invoking", async () => {
    seedProject("p1", "w1");
    const agent = seedAgent({ projectId: "p1" });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "" });
    expect(res.status).toBe(400);
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe("enablement endpoints (#79/#80)", () => {
  it("admin enables then lists enabled agents for the project", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: null });
    const put = await request(createApp())
      .put(`/custom-agents/${agent.id}/enablement`)
      .send({ projectId: "p1", enabled: true });
    expect(put.status).toBe(200);
    expect(put.body.data.enabled).toBe(true);

    const list = await request(createApp()).get("/custom-agents/projects/p1/enabled");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(agent.id);
  });

  it("#1500 — /enabled returns summaries only: no system prompt or other definition field, for own and borrowed agents alike", async () => {
    seedProject("p1", "w1");
    seedProject("p2", "w2");
    seedMember("w1", "u1", "member"); // any member reads the card
    const own = seedAgent({ projectId: "p1", name: "Own" });
    const borrowed = seedAgent({ projectId: "p2", name: "Borrowed" });
    enableFor(own.id, "p1");
    enableFor(borrowed.id, "p1");

    const list = await request(createApp()).get("/custom-agents/projects/p1/enabled");
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("systemPrompt");
    const byId = new Map(list.body.data.map((a: { id: string }) => [a.id, a]));
    expect(byId.get(borrowed.id)).toEqual({
      id: borrowed.id,
      name: "Borrowed",
      description: borrowed.description,
      isBuiltIn: false,
      projectId: "p2",
    });
    expect(Object.keys(byId.get(own.id) as object).sort()).toEqual([
      "description",
      "id",
      "isBuiltIn",
      "name",
      "projectId",
    ]);
  });

  it("#1445 review — lists the agents explicitly switched OFF for the project, and only to its members", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const off = seedAgent({ projectId: "p1" });
    const on = seedAgent({ projectId: "p1" });
    seedAgent({ projectId: "p1" }); // never switched: in neither list
    await request(createApp())
      .put(`/custom-agents/${off.id}/enablement`)
      .send({ projectId: "p1", enabled: false });
    await request(createApp())
      .put(`/custom-agents/${on.id}/enablement`)
      .send({ projectId: "p1", enabled: true });
    const res = await request(createApp()).get("/custom-agents/projects/p1/disabled");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([off.id]);

    members.clear(); // no longer a member of w1
    const outsider = await request(createApp()).get("/custom-agents/projects/p1/disabled");
    expect(outsider.status).toBe(404);
  });

  it("#1445 review — an admin can switch OFF a borrowed agent already enabled here, even without access to its home project; never switch one ON", async () => {
    seedProject("p1", "w1");
    seedProject("p2", "w2"); // the agent's home: u1 is not a member of w2
    seedMember("w1", "u1", "admin");
    const borrowed = seedAgent({ projectId: "p2", name: "Borrowed" });
    enableFor(borrowed.id, "p1");

    const off = await request(createApp())
      .put(`/custom-agents/${borrowed.id}/enablement`)
      .send({ projectId: "p1", enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.data.enabled).toBe(false);
    const disabled = await request(createApp()).get("/custom-agents/projects/p1/disabled");
    expect(disabled.body.data).toEqual([borrowed.id]);

    // Switching it back ON still needs the agent's own project (#305): 404.
    const on = await request(createApp())
      .put(`/custom-agents/${borrowed.id}/enablement`)
      .send({ projectId: "p1", enabled: true });
    expect(on.status).toBe(404);

    // With no row here, switching OFF is no exception either: 404, nothing written.
    const stranger = seedAgent({ projectId: "p2", name: "Stranger" });
    const offStranger = await request(createApp())
      .put(`/custom-agents/${stranger.id}/enablement`)
      .send({ projectId: "p1", enabled: false });
    expect(offStranger.status).toBe(404);
    expect([...enablements.values()].some((e) => e.customAgentId === stranger.id)).toBe(false);
  });

  it("#1445 review — a plain member still cannot switch a borrowed agent off (403)", async () => {
    seedProject("p1", "w1");
    seedProject("p2", "w2");
    seedMember("w1", "u1", "member");
    const borrowed = seedAgent({ projectId: "p2" });
    enableFor(borrowed.id, "p1");
    const res = await request(createApp())
      .put(`/custom-agents/${borrowed.id}/enablement`)
      .send({ projectId: "p1", enabled: false });
    expect(res.status).toBe(403);
  });

  it("non-admin cannot toggle enablement (403)", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: null });
    const res = await request(createApp())
      .put(`/custom-agents/${agent.id}/enablement`)
      .send({ projectId: "p1", enabled: true });
    expect(res.status).toBe(403);
  });
});

describe("import / export (#82)", () => {
  it("round-trips: export an agent, import it into another project", async () => {
    seedProject("p1", "w1");
    seedProject("p2", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({
      projectId: "p1",
      name: "Portable",
      systemPrompt: "do the thing",
      // #238 — a tool METIS really has (a chat code tool).
      tools: JSON.stringify(["search_code_graph"]),
      model: "claude-x",
    });

    const exp = await request(createApp()).get(`/custom-agents/${agent.id}/export`);
    expect(exp.status).toBe(200);
    expect(exp.body.data.schemaVersion).toBe(1);

    const imp = await request(createApp())
      .post("/custom-agents/import")
      .send({ projectId: "p2", document: exp.body.data });
    expect(imp.status).toBe(201);
    expect(imp.body.data.name).toBe("Portable");
    expect(imp.body.data.projectId).toBe("p2");
    expect(imp.body.data.tools).toEqual(["search_code_graph"]);
    expect(imp.body.data.model).toBe("claude-x");
  });

  it("rejects a malicious import (SSRF in tools)", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const res = await request(createApp())
      .post("/custom-agents/import")
      .send({
        projectId: "p1",
        document: {
          name: "Evil",
          description: "",
          systemPrompt: "x",
          tools: ["http://169.254.169.254/"],
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("AGENT_IMPORT_INVALID");
  });

  it("#145 — an import naming a tool METIS does not have drops and reports it (never maps it to a real tool)", async () => {
    // #238 refused the whole file, which made every export from METIS's first
    // release (its wizard offered names no tool carries) un-importable. The
    // name never granted anything — the allowlist is matched exactly — so it is
    // dropped and reported; authoring (create / PATCH) still refuses it.
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const res = await request(createApp())
      .post("/custom-agents/import")
      .send({
        projectId: "p1",
        document: { name: "Old", description: "", systemPrompt: "x", tools: ["search_code"] },
      });
    expect(res.status).toBe(201);
    expect(res.body.meta.droppedTools).toEqual(["search_code"]);
    expect(res.body.data.tools).toEqual([]);
  });

  it("#309 — an absent document reaches the import parser (400 AGENT_IMPORT_INVALID, not BAD_REQUEST)", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const res = await request(createApp()).post("/custom-agents/import").send({ projectId: "p1" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("AGENT_IMPORT_INVALID");
  });

  it("rejects import with a missing projectId (400 BAD_REQUEST)", async () => {
    const res = await request(createApp())
      .post("/custom-agents/import")
      .send({ document: { name: "X", description: "", systemPrompt: "x", tools: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });

  it("maps a duplicate-name on import to a 400 CUSTOM_AGENT_ERROR (rethrow)", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    seedAgent({ projectId: "p1", name: "Dup" });
    const res = await request(createApp())
      .post("/custom-agents/import")
      .send({
        projectId: "p1",
        document: { name: "Dup", description: "", systemPrompt: "x", tools: [] },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CUSTOM_AGENT_ERROR");
  });
});

describe("CRUD routes (#112/#80)", () => {
  it("GET / lists agents", async () => {
    // #288 — listing a project's agents needs access to that project.
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    seedAgent({ projectId: "p1", name: "Listed" });
    const res = await request(createApp()).get("/custom-agents?projectId=p1");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /?includeBuiltIns=false still returns 200", async () => {
    const res = await request(createApp()).get("/custom-agents?includeBuiltIns=false");
    expect(res.status).toBe(200);
  });

  it("GET /?includeBuiltIns=0 and =false both exclude built-ins; 1/true/absent include", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    seedAgent({ projectId: null, isBuiltIn: true, name: "BA" });
    seedAgent({ projectId: "p1", isBuiltIn: false, name: "Custom" });

    const hasBuiltIn = (body: any) => body.data.some((a: any) => a.isBuiltIn === true);

    // "0" sentinel (UI client) excludes built-ins.
    const zero = await request(createApp()).get("/custom-agents?projectId=p1&includeBuiltIns=0");
    expect(zero.status).toBe(200);
    expect(hasBuiltIn(zero.body)).toBe(false);

    // "false" sentinel excludes built-ins.
    const f = await request(createApp()).get("/custom-agents?projectId=p1&includeBuiltIns=false");
    expect(hasBuiltIn(f.body)).toBe(false);

    // "1" includes built-ins (UI client truthy form).
    const one = await request(createApp()).get("/custom-agents?projectId=p1&includeBuiltIns=1");
    expect(hasBuiltIn(one.body)).toBe(true);

    // "true" includes built-ins.
    const t = await request(createApp()).get("/custom-agents?projectId=p1&includeBuiltIns=true");
    expect(hasBuiltIn(t.body)).toBe(true);

    // absent includes built-ins (default).
    const absent = await request(createApp()).get("/custom-agents?projectId=p1");
    expect(hasBuiltIn(absent.body)).toBe(true);
  });

  it("GET /:id returns the agent", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: "p1", name: "One" });
    const res = await request(createApp()).get(`/custom-agents/${agent.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(agent.id);
  });

  it("GET /:id 404s for unknown id", async () => {
    const res = await request(createApp()).get("/custom-agents/nope");
    expect(res.status).toBe(404);
  });

  it("GET /:id returns a built-in (projectId=null) to any accessible caller", async () => {
    const agent = seedAgent({ projectId: null, isBuiltIn: true, name: "BA" });
    const res = await request(createApp()).get(`/custom-agents/${agent.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(agent.id);
  });

  it("POST / 400s on an invalid body", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const res = await request(createApp())
      .post("/custom-agents")
      .send({ projectId: "p1", name: "x" }); // too short, missing systemPrompt
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });

  it("POST / maps a duplicate-name CustomAgentError to 400", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    seedAgent({ projectId: "p1", name: "Dup" });
    const res = await request(createApp()).post("/custom-agents").send({
      projectId: "p1",
      name: "Dup",
      description: "",
      systemPrompt: "do",
      tools: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CUSTOM_AGENT_ERROR");
  });

  it("PATCH /:id updates an agent", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: "p1", name: "Editable" });
    const res = await request(createApp())
      .patch(`/custom-agents/${agent.id}`)
      .send({ description: "updated" });
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe("updated");
  });

  it("PATCH /:id 400s on an invalid body", async () => {
    const agent = seedAgent({ projectId: "p1" });
    const res = await request(createApp())
      .patch(`/custom-agents/${agent.id}`)
      .send({ reasoningEffort: "ultra" });
    expect(res.status).toBe(400);
  });

  it("PATCH /:id 404s for unknown agent (existence not leaked)", async () => {
    const res = await request(createApp()).patch("/custom-agents/nope").send({ description: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("DELETE /:id removes an agent (204)", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: "p1" });
    const res = await request(createApp()).delete(`/custom-agents/${agent.id}`);
    expect(res.status).toBe(204);
  });
});

// ── Epic #260 review — IDOR / Broken Access Control on by-id routes ─────────
describe("by-id route authorization (IDOR hardening)", () => {
  // Caller u1 belongs only to workspace w1. The target agent lives in project
  // p2 / workspace w2, which u1 cannot reach at all.
  function seedCrossWorkspaceAgent() {
    seedProject("p2", "w2");
    return seedAgent({ projectId: "p2", name: "Foreign" });
  }

  it("GET /:id 404s for a caller from an unrelated workspace (no existence leak)", async () => {
    const agent = seedCrossWorkspaceAgent();
    const res = await request(createApp()).get(`/custom-agents/${agent.id}`);
    expect(res.status).toBe(404);
  });

  it("GET /:id/export 404s for a caller from an unrelated workspace", async () => {
    const agent = seedCrossWorkspaceAgent();
    const res = await request(createApp()).get(`/custom-agents/${agent.id}/export`);
    expect(res.status).toBe(404);
  });

  it("PATCH /:id 404s for a caller from an unrelated workspace", async () => {
    const agent = seedCrossWorkspaceAgent();
    const res = await request(createApp())
      .patch(`/custom-agents/${agent.id}`)
      .send({ description: "pwned" });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id 404s for a caller from an unrelated workspace", async () => {
    const agent = seedCrossWorkspaceAgent();
    const res = await request(createApp()).delete(`/custom-agents/${agent.id}`);
    expect(res.status).toBe(404);
    // and the agent is still there
    expect(agents.get(agent.id)).toBeTruthy();
  });

  it("plain project member may GET and export but not PATCH/DELETE (403)", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: "p1", name: "MemberView" });

    const get = await request(createApp()).get(`/custom-agents/${agent.id}`);
    expect(get.status).toBe(200);

    const exp = await request(createApp()).get(`/custom-agents/${agent.id}/export`);
    expect(exp.status).toBe(200);

    const patch = await request(createApp())
      .patch(`/custom-agents/${agent.id}`)
      .send({ description: "nope" });
    expect(patch.status).toBe(403);

    const del = await request(createApp()).delete(`/custom-agents/${agent.id}`);
    expect(del.status).toBe(403);
  });

  it("workspace admin may GET, export, PATCH and DELETE", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "admin");
    const agent = seedAgent({ projectId: "p1", name: "AdminView" });

    expect((await request(createApp()).get(`/custom-agents/${agent.id}`)).status).toBe(200);
    expect((await request(createApp()).get(`/custom-agents/${agent.id}/export`)).status).toBe(200);
    expect(
      (await request(createApp()).patch(`/custom-agents/${agent.id}`).send({ description: "ok" }))
        .status,
    ).toBe(200);
    expect((await request(createApp()).delete(`/custom-agents/${agent.id}`)).status).toBe(204);
  });
});

describe("invoke failure path (#83)", () => {
  it("audits an error outcome when the provider throws", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: "p1" });
    enableFor(agent.id, "p1");
    chatMock.mockRejectedValueOnce(new Error("provider exploded"));
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 0));
    const inv = auditRows.find((a) => a.action === "custom_agent.invoked");
    expect(inv).toBeTruthy();
    const meta = JSON.parse(inv.metadata);
    expect(meta.outcome).toBe("error");
  });

  it("404s invoking an unknown agent", async () => {
    seedProject("p1", "w1");
    const res = await request(createApp())
      .post("/custom-agents/ghost/invoke")
      .send({ projectId: "p1", input: "hi" });
    expect(res.status).toBe(404);
  });

  it("audits an error outcome when the provider throws a non-Error value", async () => {
    seedProject("p1", "w1");
    seedMember("w1", "u1", "member");
    const agent = seedAgent({ projectId: "p1" });
    enableFor(agent.id, "p1");
    chatMock.mockRejectedValueOnce("string failure"); // non-Error throw
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 0));
    const inv = auditRows.find((a) => a.action === "custom_agent.invoked");
    const meta = JSON.parse(inv.metadata);
    expect(meta.outcome).toBe("error");
    expect(meta.error).toBe("string failure");
  });
});
