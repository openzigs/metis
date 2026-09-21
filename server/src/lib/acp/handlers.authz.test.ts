/**
 * Issue #676 (Epic #671, OWASP A01 BOLA/BFLA) — ACP handler tenant-authz tests.
 *
 * These assert PARITY with the REST twin `POST /api/custom-agents/:id/invoke`
 * (custom-agents.ts:277): the ACP handlers must tenant-scope every query, run
 * the real `assertProjectAccess` guard for `run-agent`, mask denials as the
 * 404-equivalent ACP error (no existence oracle), and enforce token scopes in
 * `dispatchAcp`.
 *
 * A behavioural in-memory prisma double drives the tests so we prove the
 * handlers return ONLY accessible rows — not merely that a `where` was built.
 * The double is shared by handlers.ts, acp/authz.ts AND custom-agents/authz.ts
 * (all import the same `../prisma.js` module), so the genuine `assertProjectAccess`
 * runs unmocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  workspaceId: string | null;
  createdById: string;
  deletedAt: Date | null;
  createdAt: Date;
}
interface AgentRow {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  updatedAt: Date;
}
interface SkillRow {
  id: string;
  name: string;
  description: string;
  createdById: string;
  deletedAt: Date | null;
  updatedAt: Date;
  allowlistProjectIds: string[];
}

// ---- Fixture -------------------------------------------------------------
const projects: ProjectRow[] = [
  {
    id: "p-own",
    name: "Own",
    slug: "own",
    status: "active",
    workspaceId: "ws-a",
    createdById: "u-low",
    deletedAt: null,
    createdAt: new Date(3),
  },
  {
    id: "p-foreign",
    name: "Foreign",
    slug: "foreign",
    status: "active",
    workspaceId: "ws-b",
    createdById: "u-other",
    deletedAt: null,
    createdAt: new Date(2),
  },
  {
    id: "p-open",
    name: "Open",
    slug: "open",
    status: "active",
    workspaceId: null,
    createdById: "u-other",
    deletedAt: null,
    createdAt: new Date(1),
  },
];
const userRoles: Record<string, string> = { "u-admin": "admin" }; // u-low → default reader
const memberships: Record<string, string[]> = { "u-low": ["ws-a"], "u-admin": [] };
const agents: AgentRow[] = [
  { id: "a-own", name: "deployer", description: "", projectId: "p-own", updatedAt: new Date(2) },
  {
    id: "a-foreign",
    name: "deployer",
    description: "",
    projectId: "p-foreign",
    updatedAt: new Date(1),
  },
  { id: "a-builtin", name: "fleet", description: "", projectId: null, updatedAt: new Date(3) },
];
const enablements: Array<{ customAgentId: string; projectId: string; enabled: boolean }> = [];
const skills: SkillRow[] = [
  {
    id: "s-global",
    name: "Global",
    description: "",
    createdById: "u-other",
    deletedAt: null,
    updatedAt: new Date(3),
    allowlistProjectIds: [],
  },
  {
    id: "s-own",
    name: "OwnSkill",
    description: "",
    createdById: "u-other",
    deletedAt: null,
    updatedAt: new Date(2),
    allowlistProjectIds: ["p-own"],
  },
  {
    id: "s-foreign",
    name: "ForeignSkill",
    description: "",
    createdById: "u-other",
    deletedAt: null,
    updatedAt: new Date(1),
    allowlistProjectIds: ["p-foreign"],
  },
];
const createdRuns: Array<Record<string, unknown>> = [];

// ---- Behavioural prisma double -------------------------------------------
type W = Record<string, unknown>;
function matchesProjectIdClause(clause: W, value: string | null): boolean {
  if ("projectId" in clause) {
    const pid = clause.projectId as unknown;
    if (pid === null) return value === null;
    if (typeof pid === "string") return value === pid;
    if (pid && typeof pid === "object" && "in" in (pid as W))
      return (((pid as W).in as string[]) ?? []).includes(value ?? "");
  }
  return false;
}

const projectFindMany = vi.fn(async ({ where }: { where: W }) => {
  return projects.filter((p) => {
    if (where.deletedAt === null && p.deletedAt !== null) return false;
    if (where.id && typeof where.id === "object" && "in" in (where.id as W)) {
      if (!(((where.id as W).in as string[]) ?? []).includes(p.id)) return false;
    }
    if (Array.isArray(where.OR)) {
      const ok = (where.OR as W[]).some((clause) => {
        if ("workspaceId" in clause) {
          const wid = clause.workspaceId as unknown;
          if (wid === null) return p.workspaceId === null;
          if (wid && typeof wid === "object" && "in" in (wid as W))
            return (((wid as W).in as string[]) ?? []).includes(p.workspaceId ?? "");
        }
        return false;
      });
      if (!ok) return false;
    }
    return true;
  });
});

const projectFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
  return projects.find((p) => p.id === where.id) ?? null;
});

const prisma = {
  project: { findMany: projectFindMany, findUnique: projectFindUnique },
  userRole: {
    findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => {
      const key = userRoles[where.userId];
      return key ? { role: { key } } : null;
    }),
  },
  workspaceMember: {
    findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
      (memberships[where.userId] ?? []).map((workspaceId) => ({ workspaceId })),
    ),
  },
  customAgent: {
    findMany: vi.fn(async ({ where }: { where: W }) =>
      agents.filter((a) => {
        if (Array.isArray(where.OR))
          return (where.OR as W[]).some((c) => matchesProjectIdClause(c, a.projectId));
        return true; // admin `{}`
      }),
    ),
    findFirst: vi.fn(
      async ({ where }: { where: W }) =>
        agents.find((a) => {
          if ("projectId" in where && where.projectId !== a.projectId) return false;
          if ("name" in where && where.name !== a.name) return false;
          if (where.id && typeof where.id === "object" && "in" in (where.id as W))
            if (!(((where.id as W).in as string[]) ?? []).includes(a.id)) return false;
          return true;
        }) ?? null,
    ),
  },
  customAgentEnablement: {
    findMany: vi.fn(async ({ where }: { where: { projectId: string; enabled: boolean } }) =>
      enablements
        .filter((e) => e.projectId === where.projectId && e.enabled === where.enabled)
        .map((e) => ({ customAgentId: e.customAgentId })),
    ),
  },
  projectSkillAllowlist: {
    findMany: vi.fn(async ({ where }: { where: W }) => {
      const ids = ((where.projectId as W)?.in as string[]) ?? [];
      const out: Array<{ skillId: string }> = [];
      for (const s of skills)
        for (const pid of s.allowlistProjectIds) if (ids.includes(pid)) out.push({ skillId: s.id });
      return out;
    }),
  },
  skill: {
    findMany: vi.fn(async ({ where }: { where: W }) =>
      skills.filter((s) => {
        if (where.deletedAt === null && s.deletedAt !== null) return false;
        if (Array.isArray(where.OR)) {
          return (where.OR as W[]).some((c) => {
            if (c.id && typeof c.id === "object" && "in" in (c.id as W))
              return (((c.id as W).in as string[]) ?? []).includes(s.id);
            if ("createdById" in c) return s.createdById === c.createdById;
            if (c.allowlists && typeof c.allowlists === "object" && "none" in (c.allowlists as W))
              return s.allowlistProjectIds.length === 0;
            return false;
          });
        }
        if (where.allowlists && typeof where.allowlists === "object") {
          const some = (where.allowlists as W).some as W | undefined;
          if (some) return s.allowlistProjectIds.includes(some.projectId as string);
        }
        return true; // admin `{deletedAt:null}`
      }),
    ),
  },
  backgroundRun: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      createdRuns.push(data);
      return { id: `run-${createdRuns.length}` };
    }),
  },
};

const audit = vi.fn();
vi.mock("../prisma.js", () => ({ prisma }));
vi.mock("../audit/audit-service.js", () => ({ audit: (...a: unknown[]) => audit(...a) }));

const { dispatchAcp, ACP_ERR } = await import("./handlers.js");
const { ACP_SCOPES, ACP_SCOPE_WILDCARD } = await import("./authz.js");

function call(method: string, params: unknown, userId: string, scopes: string[]) {
  return dispatchAcp(
    { jsonrpc: "2.0", id: 1, method, params },
    { auth: { tokenId: "t1", userId, scopes } },
  );
}
const READ = [ACP_SCOPES.READ];
const RUN = [ACP_SCOPES.RUN];
const ALL = [ACP_SCOPE_WILDCARD];

beforeEach(() => {
  createdRuns.length = 0;
  vi.clearAllMocks();
});

describe("list handlers — tenant scoping (BOLA)", () => {
  it("list-projects: a low-priv user sees ONLY accessible projects, not instance-wide", async () => {
    const res = await call("list-projects", {}, "u-low", READ);
    const ids = ((res as { result: Array<{ id: string }> }).result ?? []).map((p) => p.id);
    expect(ids.sort()).toEqual(["p-open", "p-own"]); // p-foreign (ws-b) excluded
  });

  it("list-projects: admin sees every project", async () => {
    const res = await call("list-projects", {}, "u-admin", ALL);
    const ids = (res as { result: Array<{ id: string }> }).result.map((p) => p.id);
    expect(ids.sort()).toEqual(["p-foreign", "p-open", "p-own"]);
  });

  it("list-agents: a low-priv user sees own-project + built-in fleet, never a foreign-project agent of the same name", async () => {
    const res = await call("list-agents", {}, "u-low", READ);
    const rows = (res as { result: Array<{ id: string; key: string }> }).result;
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["a-builtin", "a-own"]); // a-foreign hidden despite name collision
  });

  it("list-skills: a low-priv user sees the shared library + accessible-project skills, not foreign-project skills", async () => {
    const res = await call("list-skills", {}, "u-low", READ);
    const ids = (res as { result: Array<{ id: string }> }).result.map((s) => s.id).sort();
    expect(ids).toEqual(["s-global", "s-own"]); // s-foreign (allowlisted only to p-foreign) hidden
  });

  it("list-skills: admin sees every skill", async () => {
    const res = await call("list-skills", {}, "u-admin", ALL);
    const ids = (res as { result: Array<{ id: string }> }).result.map((s) => s.id).sort();
    expect(ids).toEqual(["s-foreign", "s-global", "s-own"]);
  });
});

describe("run-agent — parity with REST invoke twin (BOLA)", () => {
  it("enqueues a BackgroundRun for an accessible project + owned agent", async () => {
    const res = await call("run-agent", { projectId: "p-own", agentKey: "deployer" }, "u-low", RUN);
    expect((res as { result: { runId: string } }).result.runId).toBe("run-1");
    expect(prisma.backgroundRun.create).toHaveBeenCalledTimes(1);
    expect(createdRuns[0].projectId).toBe("p-own");
  });

  it("resolves the agent SCOPED to the target project (not a global name lookup)", async () => {
    // "deployer" exists in both p-own and p-foreign; running against p-own must
    // bind to a-own, never a-foreign.
    await call("run-agent", { projectId: "p-own", agentKey: "deployer" }, "u-low", RUN);
    const payload = JSON.parse(createdRuns[0].payload as string);
    expect(payload.agentKey).toBe("deployer");
    expect(createdRuns[0].projectId).toBe("p-own");
  });

  it("denies run-agent against a project the caller cannot access (404-equivalent, no enqueue)", async () => {
    const res = await call(
      "run-agent",
      { projectId: "p-foreign", agentKey: "deployer" },
      "u-low",
      RUN,
    );
    expect((res as { error: { code: number } }).error.code).toBe(ACP_ERR.PROJECT_NOT_FOUND);
    expect(prisma.backgroundRun.create).not.toHaveBeenCalled();
  });

  it("denies run-agent for an agent not owned/enabled in the accessible project (AGENT_NOT_FOUND, audited, no enqueue)", async () => {
    const res = await call("run-agent", { projectId: "p-own", agentKey: "fleet" }, "u-low", RUN);
    expect((res as { error: { code: number } }).error.code).toBe(ACP_ERR.AGENT_NOT_FOUND);
    expect(prisma.backgroundRun.create).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "acp.run-agent.denied" }));
  });

  it("resolves an agent ENABLED for the project (not owned by it) — mirrors REST enablement", async () => {
    // Built-in fleet agent "fleet" enabled for p-own via CustomAgentEnablement.
    enablements.push({ customAgentId: "a-builtin", projectId: "p-own", enabled: true });
    try {
      const res = await call("run-agent", { projectId: "p-own", agentKey: "fleet" }, "u-low", RUN);
      expect((res as { result: { runId: string } }).result.runId).toBe("run-1");
      expect(createdRuns[0].projectId).toBe("p-own");
    } finally {
      enablements.length = 0;
    }
  });

  it("rejects malformed run-agent params (INVALID_PARAMS, no enqueue)", async () => {
    const res = await call("run-agent", { projectId: "p-own" }, "u-low", RUN);
    expect((res as { error: { code: number } }).error.code).toBe(ACP_ERR.INVALID_PARAMS);
    expect(prisma.backgroundRun.create).not.toHaveBeenCalled();
  });

  it("admin may run-agent in any project", async () => {
    const res = await call(
      "run-agent",
      { projectId: "p-foreign", agentKey: "deployer" },
      "u-admin",
      ALL,
    );
    expect((res as { result: { runId: string } }).result.runId).toBe("run-1");
    expect(createdRuns[0].projectId).toBe("p-foreign");
  });
});

describe("dispatchAcp — token scope enforcement (BFLA)", () => {
  it("rejects a method the token's scopes do not cover, without touching the DB", async () => {
    const res = await call(
      "run-agent",
      { projectId: "p-own", agentKey: "deployer" },
      "u-low",
      READ,
    );
    expect((res as { error: { code: number } }).error.code).toBe(ACP_ERR.FORBIDDEN);
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
    expect(prisma.backgroundRun.create).not.toHaveBeenCalled();
  });

  it("rejects list-projects for a token missing acp:read", async () => {
    const res = await call("list-projects", {}, "u-low", RUN);
    expect((res as { error: { code: number } }).error.code).toBe(ACP_ERR.FORBIDDEN);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("allows a method the token's scopes cover", async () => {
    const res = await call("list-projects", {}, "u-low", READ);
    expect((res as { result: unknown }).result).toBeDefined();
  });

  it("wildcard scope grants every method", async () => {
    const res = await call("run-agent", { projectId: "p-own", agentKey: "deployer" }, "u-low", ALL);
    expect((res as { result: { runId: string } }).result.runId).toBe("run-1");
  });
});
