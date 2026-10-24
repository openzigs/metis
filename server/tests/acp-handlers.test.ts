/**
 * ACP JSON-RPC handlers — dispatch + per-method behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #676 — these mechanics tests run as a reader token with a wildcard
// scope, against workspace-less (open) projects so `assertProjectAccess` grants
// access. This keeps the per-method behaviour under test (incl. the real
// project-existence check that now flows through the tenant guard) intact.
// Tenant-scoping parity is covered separately in src/lib/acp/handlers.authz.test.ts.
const projects: Array<{
  id: string;
  name: string;
  slug: string;
  status: string;
  workspaceId: string | null;
  deletedAt: Date | null;
}> = [];
const skills: Array<{ id: string; name: string; description: string; deletedAt: Date | null }> = [];
const agents: Array<{ id: string; name: string; description: string; updatedAt: Date }> = [];
const bgRuns: Array<{ id: string; payload: string; kind: string; projectId: string }> = [];
const turnedOff = new Set<string>();
// #1445 — an agent id in `neverToggled` has NO enablement row at all. Every
// other agent has an enabled row for every project (off until enabled).
const neverToggled = new Set<string>();
const switchedOn = (id: string) => !turnedOff.has(id) && !neverToggled.has(id);

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findMany: vi.fn(async () => projects.filter((p) => !p.deletedAt)),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          projects.find((p) => p.id === where.id && !p.deletedAt) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; deletedAt: null } }) =>
          projects.find((p) => p.id === where.id && !p.deletedAt) ?? null,
      ),
    },
    // Actor resolution (VerifiedToken → AuthPayload): unassigned → reader, no
    // memberships. Open (workspace-less) projects are still reachable.
    userRole: { findFirst: vi.fn(async () => null) },
    workspaceMember: { findMany: vi.fn(async () => []) },
    skill: {
      findMany: vi.fn(async () => skills.filter((s) => !s.deletedAt)),
    },
    customAgent: {
      findMany: vi.fn(async () => agents),
      findFirst: vi.fn(
        async ({ where }: { where: { name?: string } }) =>
          agents.find((a) => a.name === where.name) ?? null,
      ),
    },
    customAgentEnablement: {
      // Only enabled rows are returned: what every caller here filters for.
      findMany: vi.fn(async () =>
        agents
          .filter((a) => switchedOn(a.id))
          .map((a) => ({
            customAgentId: a.id,
            projectId: (a as { projectId?: string }).projectId,
            enabled: true,
          })),
      ),
      // #1005 — an agent id in `turnedOff` has a disabled row for every project.
      findUnique: vi.fn(
        async ({ where }: { where: { customAgentId_projectId: { customAgentId: string } } }) => {
          const id = where.customAgentId_projectId.customAgentId;
          if (neverToggled.has(id)) return null;
          return { enabled: !turnedOff.has(id) };
        },
      ),
    },
    projectSkillAllowlist: { findMany: vi.fn(async () => []) },
    backgroundRun: {
      create: vi.fn(
        async ({ data }: { data: { kind: string; projectId: string; payload: string } }) => {
          const row = { id: `run_${bgRuns.length + 1}`, ...data };
          bgRuns.push(row);
          return { id: row.id };
        },
      ),
    },
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { ACP_ERR, dispatchAcp } from "../src/lib/acp/handlers.js";

beforeEach(() => {
  projects.length = 0;
  skills.length = 0;
  agents.length = 0;
  bgRuns.length = 0;
  turnedOff.clear();
  neverToggled.clear();
});

afterEach(() => vi.clearAllMocks());

const auth = { tokenId: "tok_1", userId: "u1", scopes: ["acp:*"] };

describe("dispatchAcp", () => {
  it("rejects bad envelopes", async () => {
    const r = await dispatchAcp(
      // @ts-expect-error invalid envelope under test
      { method: "list-projects" },
      { auth },
    );
    expect("error" in r && r.error.code).toBe(ACP_ERR.INVALID_REQUEST);
  });

  it("returns UNAUTHORIZED when no auth", async () => {
    const r = await dispatchAcp({ jsonrpc: "2.0", id: 1, method: "list-projects" }, { auth: null });
    expect("error" in r && r.error.code).toBe(ACP_ERR.UNAUTHORIZED);
  });

  it("returns METHOD_NOT_FOUND for unknown methods", async () => {
    const r = await dispatchAcp({ jsonrpc: "2.0", id: 1, method: "bogus" }, { auth });
    expect("error" in r && r.error.code).toBe(ACP_ERR.METHOD_NOT_FOUND);
  });

  it("list-projects returns visible projects", async () => {
    projects.push({
      id: "p1",
      name: "P",
      slug: "p",
      status: "active",
      workspaceId: null,
      deletedAt: null,
    });
    const r = await dispatchAcp({ jsonrpc: "2.0", id: 1, method: "list-projects" }, { auth });
    expect("result" in r && (r.result as Array<{ id: string }>)[0].id).toBe("p1");
  });

  it("list-skills returns rows", async () => {
    skills.push({ id: "s1", name: "Smoke", description: "", deletedAt: null });
    const r = await dispatchAcp({ jsonrpc: "2.0", id: 1, method: "list-skills" }, { auth });
    expect("result" in r && (r.result as Array<{ id: string }>)[0].id).toBe("s1");
  });

  it("list-agents surfaces name as key", async () => {
    agents.push({ id: "a1", name: "smoke-agent", description: "d", updatedAt: new Date() });
    const r = await dispatchAcp({ jsonrpc: "2.0", id: 1, method: "list-agents" }, { auth });
    const agentList = "result" in r ? (r.result as Array<{ key: string; id: string }>) : [];
    expect(agentList[0].key).toBe("smoke-agent");
  });

  it("run-agent enqueues a BackgroundRun", async () => {
    projects.push({
      id: "p1",
      name: "P",
      slug: "p",
      status: "active",
      workspaceId: null,
      deletedAt: null,
    });
    agents.push({ id: "a1", name: "smoke", description: "", updatedAt: new Date() });
    const r = await dispatchAcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "run-agent",
        params: { projectId: "p1", agentKey: "smoke", prompt: "hi" },
      },
      { auth },
    );
    expect("result" in r && (r.result as { runId: string }).runId).toBe("run_1");
    expect(bgRuns).toHaveLength(1);
    expect(bgRuns[0].kind).toBe("acp.run-agent");
    const payload = JSON.parse(bgRuns[0].payload);
    expect(payload.agentKey).toBe("smoke");
    expect(payload.acp.tokenId).toBe("tok_1");
  });

  it("#1005 — run-agent refuses the project's own agent once it is turned off (AGENT_NOT_FOUND, no enqueue)", async () => {
    projects.push({
      id: "p1",
      name: "P",
      slug: "p",
      status: "active",
      workspaceId: null,
      deletedAt: null,
    });
    agents.push({ id: "a1", name: "smoke", description: "", updatedAt: new Date() });
    turnedOff.add("a1");
    const r = await dispatchAcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "run-agent",
        params: { projectId: "p1", agentKey: "smoke", prompt: "hi" },
      },
      { auth },
    );
    expect("error" in r && r.error.code).toBe(ACP_ERR.AGENT_NOT_FOUND);
    expect(bgRuns).toHaveLength(0);
  });

  it("#1445 — run-agent refuses the project's own agent nobody switched on (AGENT_NOT_FOUND, no enqueue)", async () => {
    projects.push({
      id: "p1",
      name: "P",
      slug: "p",
      status: "active",
      workspaceId: null,
      deletedAt: null,
    });
    agents.push({ id: "a1", name: "smoke", description: "", updatedAt: new Date() });
    neverToggled.add("a1");
    const r = await dispatchAcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "run-agent",
        params: { projectId: "p1", agentKey: "smoke", prompt: "hi" },
      },
      { auth },
    );
    expect("error" in r && r.error.code).toBe(ACP_ERR.AGENT_NOT_FOUND);
    expect(bgRuns).toHaveLength(0);
  });

  it("#1445 — list-agents does not offer an agent nobody switched on", async () => {
    agents.push({ id: "a1", name: "never-on", description: "", updatedAt: new Date() });
    agents.push({ id: "a2", name: "switched-on", description: "", updatedAt: new Date() });
    neverToggled.add("a1");
    const r = await dispatchAcp({ jsonrpc: "2.0", id: 1, method: "list-agents" }, { auth });
    const keys = "result" in r ? (r.result as Array<{ key: string }>).map((a) => a.key) : [];
    expect(keys).toEqual(["switched-on"]);
  });

  it("run-agent returns INVALID_PARAMS when missing projectId/agentKey", async () => {
    const r = await dispatchAcp(
      { jsonrpc: "2.0", id: 1, method: "run-agent", params: {} },
      { auth },
    );
    expect("error" in r && r.error.code).toBe(ACP_ERR.INVALID_PARAMS);
  });

  it("run-agent returns PROJECT_NOT_FOUND when project missing", async () => {
    agents.push({ id: "a1", name: "smoke", description: "", updatedAt: new Date() });
    const r = await dispatchAcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "run-agent",
        params: { projectId: "missing", agentKey: "smoke" },
      },
      { auth },
    );
    expect("error" in r && r.error.code).toBe(ACP_ERR.PROJECT_NOT_FOUND);
  });

  it("run-agent returns AGENT_NOT_FOUND when agent missing", async () => {
    projects.push({
      id: "p1",
      name: "P",
      slug: "p",
      status: "active",
      workspaceId: null,
      deletedAt: null,
    });
    const r = await dispatchAcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "run-agent",
        params: { projectId: "p1", agentKey: "ghost" },
      },
      { auth },
    );
    expect("error" in r && r.error.code).toBe(ACP_ERR.AGENT_NOT_FOUND);
  });
});
