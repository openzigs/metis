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
      findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
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
  testUser = { userId: "u1", username: "alice", role: "user", permissions: [], workspaces: ["w1"] };
});
afterEach(() => vi.restoreAllMocks());

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
    const agent = seedAgent({ projectId: "p1" });
    const res = await request(createApp())
      .post(`/custom-agents/${agent.id}/invoke`)
      .send({ projectId: "p1", input: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe("playground answer");
    expect(chatMock).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    const inv = auditRows.find((a) => a.action === "custom_agent.invoked");
    expect(inv).toBeTruthy();
    expect(inv.targetId).toBe(agent.id);
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

  it("writes a custom_agent.invoke_denied audit row before the 404", async () => {
    seedProject("p1", "w1");
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
      tools: JSON.stringify(["search_code"]),
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
    expect(imp.body.data.tools).toEqual(["search_code"]);
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
    const agent = seedAgent({ projectId: "p1" });
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
    const agent = seedAgent({ projectId: "p1" });
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
