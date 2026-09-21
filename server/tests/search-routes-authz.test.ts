/**
 * Issue #1052 (finding F4, epic #1051) — cross-tenant disclosure regression
 * tests for `/api/search/*`.
 *
 * `getUserAccessibleProjects` is the SOLE authorization gate for both
 * `/api/search/projects` and `/api/search/federated`. It used to ignore its
 * `userId` argument and return every non-archived project in the deployment, so
 * any authenticated `reader` could list other tenants' projects and then read
 * verbatim RAG chunk text out of them.
 *
 * Unlike `search-routes.test.ts` (which mocks the accessible-projects lookup and
 * the federated service to focus on the route surface), this suite exercises the
 * REAL helper and the REAL `FederatedSearchService` over HTTP, mocking only
 * prisma and the per-project `KnowledgeService`. That is the only way to prove
 * the projectIds intersection is genuine enforcement rather than a no-op.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Fixture tenancy ────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  workspaceId: string | null;
  status: string;
  deletedAt: Date | null;
}

const PROJECTS: ProjectRow[] = [
  {
    id: "proj-a",
    name: "Alpha (workspace A)",
    workspaceId: "ws-a",
    status: "active",
    deletedAt: null,
  },
  {
    id: "proj-b",
    name: "Beta (workspace B)",
    workspaceId: "ws-b",
    status: "active",
    deletedAt: null,
  },
  {
    id: "proj-open",
    name: "Legacy (no workspace)",
    workspaceId: null,
    status: "active",
    deletedAt: null,
  },
  {
    id: "proj-arch",
    name: "Archived (workspace B)",
    workspaceId: "ws-b",
    status: "archived",
    deletedAt: null,
  },
];

const SECRET_TEXT: Record<string, string> = {
  "proj-a": "WORKSPACE-A-CONFIDENTIAL-CHUNK",
  "proj-b": "WORKSPACE-B-OWN-CHUNK",
  "proj-open": "LEGACY-OPEN-CHUNK",
  "proj-arch": "ARCHIVED-CHUNK",
};

/** Actor resolved out of the DB by the helper under test. */
let currentRole: string | null = "reader";
let currentWorkspaces: string[] = ["ws-b"];

/**
 * Minimal evaluator for the `where` shapes the helper builds. Keeping this
 * faithful is what makes the assertions meaningful — a mock that ignored the
 * filter would pass even with the vulnerable implementation.
 */
function matchesWhere(row: ProjectRow, where: Record<string, unknown>): boolean {
  if ("deletedAt" in where && where.deletedAt === null && row.deletedAt !== null) return false;
  const status = where.status as { not?: string } | undefined;
  if (status?.not && row.status === status.not) return false;
  const or = where.OR as Array<Record<string, unknown>> | undefined;
  if (or) {
    const anyMatch = or.some((clause) => {
      if ("workspaceId" in clause) {
        const cond = clause.workspaceId as null | { in?: string[] };
        if (cond === null) return row.workspaceId === null;
        if (cond?.in) return row.workspaceId !== null && cond.in.includes(row.workspaceId);
      }
      return false;
    });
    if (!anyMatch) return false;
  }
  return true;
}

const projectFindMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
  PROJECTS.filter((p) => matchesWhere(p, where)).map((p) => ({ id: p.id, name: p.name })),
);

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: {
      findMany: vi.fn(async () => currentWorkspaces.map((workspaceId) => ({ workspaceId }))),
    },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "user_test",
        ...create,
      })),
    },
    userRole: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        currentRole
          ? [
              {
                userId: where.userId,
                roleId: `role_${currentRole}`,
                source: "local",
                role: { id: `role_${currentRole}`, key: currentRole },
              },
            ]
          : [],
      ),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    project: { findMany: (args: { where: Record<string, unknown> }) => projectFindMany(args) },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const knowledgeSearch = vi.fn(async (projectId: string) => ({
  hits: [
    {
      chunkId: `${projectId}-chunk-1`,
      documentId: `${projectId}-doc-1`,
      filename: "secrets.md",
      position: 0,
      text: SECRET_TEXT[projectId] ?? `text for ${projectId}`,
      score: 0.9,
      embeddingModel: "test",
    },
  ],
  mode: "hybrid" as const,
  reranked: false,
}));

vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ search: knowledgeSearch }),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { __resetFederatedSearchSingleton } from "../src/lib/rag/federated-search-service.js";

let app: ReturnType<typeof createApp>;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

/** Log in as a caller whose DB-resolved role/workspaces are as given. */
async function loginAs(role: string | null, workspaces: string[]): Promise<string> {
  currentRole = role;
  currentWorkspaces = workspaces;
  return login();
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetFederatedSearchSingleton();
  currentRole = "reader";
  currentWorkspaces = ["ws-b"];
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/search/projects — workspace scoping (#1052)", () => {
  it("does not disclose workspace-A projects to a reader in workspace B", async () => {
    const token = await loginAs("reader", ["ws-b"]);
    const res = await request(app)
      .get("/api/search/projects")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain("proj-a");
    expect(JSON.stringify(res.body)).not.toContain("Alpha");
  });

  it("still returns the caller's OWN workspace projects (no over-blocking)", async () => {
    const token = await loginAs("reader", ["ws-b"]);
    const res = await request(app)
      .get("/api/search/projects")
      .set("Authorization", `Bearer ${token}`);

    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain("proj-b");
  });

  it("keeps pre-migration workspace-less projects visible", async () => {
    const token = await loginAs("reader", []);
    const res = await request(app)
      .get("/api/search/projects")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status, res.text).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(["proj-open"]);
  });

  it("excludes archived projects from the caller's own workspace", async () => {
    const token = await loginAs("reader", ["ws-b"]);
    const res = await request(app)
      .get("/api/search/projects")
      .set("Authorization", `Bearer ${token}`);

    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain("proj-arch");
  });

  it("lets a system admin see every workspace", async () => {
    const token = await loginAs("admin", []);
    const res = await request(app)
      .get("/api/search/projects")
      .set("Authorization", `Bearer ${token}`);

    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["proj-a", "proj-b", "proj-open"]));
  });
});

describe("POST /api/search/federated — cross-tenant chunk disclosure (#1052)", () => {
  it("returns NO chunk text when a workspace-B reader explicitly names workspace-A projects", async () => {
    const token = await loginAs("reader", ["ws-b"]);
    const res = await request(app)
      .post("/api/search/federated")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "password", projectIds: ["proj-a"] });

    expect(res.status).toBe(200);
    expect(res.body.data.hits).toEqual([]);
    expect(res.body.data.projectsSearched).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("WORKSPACE-A-CONFIDENTIAL-CHUNK");
    // The per-project RAG index must never even be queried for another tenant.
    expect(knowledgeSearch).not.toHaveBeenCalled();
  });

  it("omits workspace-A projects from an unscoped (no projectIds) federated search", async () => {
    const token = await loginAs("reader", ["ws-b"]);
    const res = await request(app)
      .post("/api/search/federated")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "password" });

    expect(res.status).toBe(200);
    expect(res.body.data.projectsSearched).not.toContain("proj-a");
    expect(JSON.stringify(res.body)).not.toContain("WORKSPACE-A-CONFIDENTIAL-CHUNK");
    expect(knowledgeSearch.mock.calls.map((c) => c[0])).not.toContain("proj-a");
  });

  it("still returns the caller's OWN results (no over-blocking)", async () => {
    const token = await loginAs("reader", ["ws-b"]);
    const res = await request(app)
      .post("/api/search/federated")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "password", projectIds: ["proj-b"] });

    expect(res.status).toBe(200);
    expect(res.body.data.projectsSearched).toEqual(["proj-b"]);
    expect(res.body.data.hits).toHaveLength(1);
    expect(res.body.data.hits[0].text).toBe("WORKSPACE-B-OWN-CHUNK");
  });

  it("still searches pre-migration workspace-less projects", async () => {
    const token = await loginAs("reader", []);
    const res = await request(app)
      .post("/api/search/federated")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "password" });

    expect(res.status).toBe(200);
    expect(res.body.data.projectsSearched).toEqual(["proj-open"]);
    expect(res.body.data.hits[0].text).toBe("LEGACY-OPEN-CHUNK");
  });

  it("lets a system admin search any workspace", async () => {
    const token = await loginAs("admin", []);
    const res = await request(app)
      .post("/api/search/federated")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "password", projectIds: ["proj-a"] });

    expect(res.status).toBe(200);
    expect(res.body.data.projectsSearched).toEqual(["proj-a"]);
    expect(res.body.data.hits[0].text).toBe("WORKSPACE-A-CONFIDENTIAL-CHUNK");
  });
});
