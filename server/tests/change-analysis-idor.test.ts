/**
 * `/api/projects/:projectId/change-analyses` — cross-project IDOR regression
 * tests (Issue #1073, epic #1051).
 *
 * `changeAnalysisRouter()` IS mounted under `/projects/:projectId`, but its
 * `/:id` handlers resolved the change analysis (and the nested `:changeId`) by
 * bare primary key, so the path project was never consulted. A legitimate
 * member of project B could put B in the path — satisfying every project-level
 * check — and another tenant's analysis id in the resource slot.
 *
 * That is what these tests pin, and it is why the caller below is always a
 * genuine member of the PATH project: a test that only exercises an
 * unreachable path project would pass on the upstream `/projects/:id/:sub`
 * catch-all alone (`projects.ts:94`) and prove nothing about this router.
 *
 *   • the caller is a member of workspace `ws_b`, and addresses `proj_b`;
 *   • `ca_a` / `rc_a` belong to `proj_a`, a workspace-A project;
 *   • every route that takes an id must therefore 404 on `ca_a`, on read AND
 *     on the review WRITE, without reaching the mutation;
 *   • a same-project analysis paired with a FOREIGN `changeId` is rejected too
 *     — scoping the analysis alone still leaves the nested id unbound;
 *   • the out-of-tenant 404 is identical to the unknown-id 404, so the error
 *     channel is not an existence oracle;
 *   • same-project callers still succeed (over-blocking is the worse failure);
 *   • system admins bypass the workspace check, and pre-migration
 *     null-`workspaceId` projects stay open to any authenticated caller.
 *
 * Prisma is mocked but the change-analysis engine is REAL, so these assertions
 * cover the actual `where` clauses the fix adds — the tenant scope has to live
 * in the query, not only in the router.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ChangeAnalysisRow {
  id: string;
  projectId: string;
  baseAnalysisId: string;
  headAnalysisId: string;
  status: string;
  summary: string | null;
  totalChanges: number;
  additions: number;
  removals: number;
  modifications: number;
  startedById: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RequirementChangeRow {
  id: string;
  changeAnalysisId: string;
  changeType: string;
  severity: string;
  impactScore: number;
  requirementId: string | null;
  previousRequirementId: string | null;
  title: string;
  previousTitle: string | null;
  body: string;
  previousBody: string | null;
  diffSummary: string | null;
  reviewStatus: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

function changeAnalysis(id: string, projectId: string): ChangeAnalysisRow {
  return {
    id,
    projectId,
    baseAnalysisId: `${id}_base`,
    headAnalysisId: `${id}_head`,
    status: "completed",
    summary: "1 change detected",
    totalChanges: 1,
    additions: 1,
    removals: 0,
    modifications: 0,
    startedById: "user_1",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:01:00Z"),
    errorMessage: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:01:00Z"),
  };
}

function requirementChange(id: string, changeAnalysisId: string): RequirementChangeRow {
  return {
    id,
    changeAnalysisId,
    changeType: "added",
    severity: "low",
    impactScore: 0.4,
    requirementId: "req_1",
    previousRequirementId: null,
    title: "New requirement",
    previousTitle: null,
    body: "body",
    previousBody: null,
    diffSummary: "New functional requirement added",
    reviewStatus: "pending",
    reviewedById: null,
    reviewedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/**
 * `ca_a` / `rc_a` belong to workspace-A's project; `ca_b` / `rc_b` to the
 * caller's own project. `project.findUnique` is what `assertProjectAccess`
 * consults for the PATH project.
 */
const { prismaMock, state } = vi.hoisted(() => {
  const analyses = new Map<string, Record<string, unknown>>();
  const changeAnalyses = new Map<string, Record<string, unknown>>();
  const requirementChanges = new Map<string, Record<string, unknown>>();
  const projectWorkspaces = new Map<string, string | null>();

  interface ChangeAnalysisWhere {
    id?: string;
    projectId?: string;
  }
  interface RequirementChangeWhere {
    id?: string;
    changeAnalysisId?: string;
    changeAnalysis?: { projectId?: string };
  }

  const matchesChangeAnalysis = (
    row: Record<string, unknown>,
    where: ChangeAnalysisWhere,
  ): boolean =>
    (where.id === undefined || row.id === where.id) &&
    (where.projectId === undefined || row.projectId === where.projectId);

  const matchesRequirementChange = (
    row: Record<string, unknown>,
    where: RequirementChangeWhere,
  ): boolean => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.changeAnalysisId !== undefined && row.changeAnalysisId !== where.changeAnalysisId) {
      return false;
    }
    const wantedProject = where.changeAnalysis?.projectId;
    if (wantedProject !== undefined) {
      const parent = changeAnalyses.get(String(row.changeAnalysisId));
      if (!parent || parent.projectId !== wantedProject) return false;
    }
    return true;
  };

  return {
    state: { analyses, changeAnalyses, requirementChanges, projectWorkspaces },
    prismaMock: {
      $queryRawUnsafe: vi.fn(async () => 1),
      workspaceMember: { findMany: vi.fn(async () => [{ workspaceId: "ws_b" }]) },
      user: {
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
          id: "user_1",
          ...create,
        })),
      },
      userRole: {},
      auditLog: { create: vi.fn(async () => ({})) },
      project: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          projectWorkspaces.has(where.id)
            ? { id: where.id, workspaceId: projectWorkspaces.get(where.id) ?? null }
            : null,
        ),
      },
      analysis: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
          const row = analyses.get(where.id);
          if (!row) return null;
          if (where.projectId !== undefined && row.projectId !== where.projectId) return null;
          return row;
        }),
      },
      changeAnalysis: {
        findFirst: vi.fn(async ({ where }: { where: ChangeAnalysisWhere }) => {
          const row = [...changeAnalyses.values()].find((r) => matchesChangeAnalysis(r, where));
          if (!row) return null;
          return {
            ...row,
            changes: [...requirementChanges.values()].filter((c) => c.changeAnalysisId === row.id),
          };
        }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          const row = changeAnalyses.get(where.id);
          if (!row) return null;
          return {
            ...row,
            changes: [...requirementChanges.values()].filter((c) => c.changeAnalysisId === row.id),
          };
        }),
        findMany: vi.fn(async ({ where }: { where: { projectId: string } }) =>
          [...changeAnalyses.values()].filter((r) => r.projectId === where.projectId),
        ),
        create: vi.fn(async () => changeAnalysis("ca_new", "proj_b")),
        update: vi.fn(async () => changeAnalysis("ca_new", "proj_b")),
      },
      requirementChange: {
        findFirst: vi.fn(
          async ({ where }: { where: RequirementChangeWhere }) =>
            [...requirementChanges.values()].find((r) => matchesRequirementChange(r, where)) ??
            null,
        ),
        findUnique: vi.fn(
          async ({ where }: { where: { id: string } }) => requirementChanges.get(where.id) ?? null,
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
            ...requirementChanges.get(where.id),
            ...data,
          }),
        ),
      },
    },
  };
});

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  return { prisma: withRouteAuth(prismaMock) };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();

  state.projectWorkspaces.clear();
  // The caller is a genuine member of ws_b, so `proj_b` in the path passes
  // every project-level check. `proj_a` belongs to another tenant.
  state.projectWorkspaces.set("proj_b", "ws_b");
  state.projectWorkspaces.set("proj_a", "ws_a");
  state.projectWorkspaces.set("proj_legacy", null);

  state.changeAnalyses.clear();
  state.changeAnalyses.set("ca_a", changeAnalysis("ca_a", "proj_a") as never);
  state.changeAnalyses.set("ca_b", changeAnalysis("ca_b", "proj_b") as never);
  state.changeAnalyses.set("ca_legacy", changeAnalysis("ca_legacy", "proj_legacy") as never);

  state.requirementChanges.clear();
  state.requirementChanges.set("rc_a", requirementChange("rc_a", "ca_a") as never);
  state.requirementChanges.set("rc_b", requirementChange("rc_b", "ca_b") as never);

  state.analyses.clear();
  state.analyses.set("an_alpha_0001", {
    id: "an_alpha_0001",
    projectId: "proj_a",
    status: "completed",
  } as never);
  state.analyses.set("an_alpha_0002", {
    id: "an_alpha_0002",
    projectId: "proj_a",
    status: "completed",
  } as never);

  prismaMock.workspaceMember.findMany.mockResolvedValue([{ workspaceId: "ws_b" }]);
});

afterEach(() => vi.clearAllMocks());

describe("GET /projects/:projectId/change-analyses/:id — cross-project", () => {
  it("404s a workspace-A analysis addressed through the caller's own project", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/projects/proj_b/change-analyses/ca_a")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CHANGE_ANALYSIS_NOT_FOUND");
  });

  it("scopes the lookup query itself to the path project", async () => {
    const token = await login("coordinator");
    await request(app)
      .get("/api/projects/proj_b/change-analyses/ca_b")
      .set("Authorization", `Bearer ${token}`);

    const call = prismaMock.changeAnalysis.findFirst.mock.calls.at(-1)?.[0] as {
      where: { id: string; projectId: string };
    };
    expect(call.where).toMatchObject({ id: "ca_b", projectId: "proj_b" });
  });

  it("returns an out-of-tenant 404 identical to the unknown-id 404", async () => {
    const token = await login("coordinator");
    const foreign = await request(app)
      .get("/api/projects/proj_b/change-analyses/ca_a")
      .set("Authorization", `Bearer ${token}`);
    const unknown = await request(app)
      .get("/api/projects/proj_b/change-analyses/ca_does_not_exist")
      .set("Authorization", `Bearer ${token}`);

    expect(foreign.status).toBe(unknown.status);
    // `correlationId` is per-request by design; the discriminating part of the
    // envelope is the error itself.
    expect(foreign.body.error).toEqual(unknown.body.error);
  });

  it("still serves a same-project analysis to a legitimate member", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/projects/proj_b/change-analyses/ca_b")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("ca_b");
    expect(res.body.data.changes).toHaveLength(1);
  });

  it("serves a reader (the lowest role holding analysis.read) its own project", async () => {
    const token = await login("reader");
    const own = await request(app)
      .get("/api/projects/proj_b/change-analyses/ca_b")
      .set("Authorization", `Bearer ${token}`);
    const foreign = await request(app)
      .get("/api/projects/proj_b/change-analyses/ca_a")
      .set("Authorization", `Bearer ${token}`);

    expect(own.status).toBe(200);
    expect(foreign.status).toBe(404);
  });

  it("keeps pre-migration null-workspace projects open to authenticated callers", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/projects/proj_legacy/change-analyses/ca_legacy")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("lets a system admin through the workspace check but still scopes the row", async () => {
    const token = await login("admin");
    const addressed = await request(app)
      .get("/api/projects/proj_a/change-analyses/ca_a")
      .set("Authorization", `Bearer ${token}`);
    const misaddressed = await request(app)
      .get("/api/projects/proj_b/change-analyses/ca_a")
      .set("Authorization", `Bearer ${token}`);

    expect(addressed.status).toBe(200);
    expect(misaddressed.status).toBe(404);
  });
});

describe("POST /projects/:projectId/change-analyses/:id/changes/:changeId/review", () => {
  const body = { reviewStatus: "approved" as const };

  it("404s a workspace-A change without performing the write", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_b/change-analyses/ca_a/changes/rc_a/review")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CHANGE_NOT_FOUND");
    expect(prismaMock.requirementChange.update).not.toHaveBeenCalled();
  });

  it("rejects a same-project analysis paired with a foreign changeId", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_b/change-analyses/ca_b/changes/rc_a/review")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(404);
    expect(prismaMock.requirementChange.update).not.toHaveBeenCalled();
  });

  it("rejects a foreign analysis paired with the caller's own changeId", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_b/change-analyses/ca_a/changes/rc_b/review")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(404);
    expect(prismaMock.requirementChange.update).not.toHaveBeenCalled();
  });

  it("binds the change to BOTH the analysis and the path project in the query", async () => {
    const token = await login("coordinator");
    await request(app)
      .post("/api/projects/proj_b/change-analyses/ca_b/changes/rc_b/review")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    const call = prismaMock.requirementChange.findFirst.mock.calls.at(-1)?.[0] as {
      where: { id: string; changeAnalysisId: string; changeAnalysis: { projectId: string } };
    };
    expect(call.where).toMatchObject({
      id: "rc_b",
      changeAnalysisId: "ca_b",
      changeAnalysis: { projectId: "proj_b" },
    });
  });

  it("still lets a legitimate same-project reviewer approve", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_b/change-analyses/ca_b/changes/rc_b/review")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.reviewStatus).toBe("approved");
    expect(prismaMock.requirementChange.update).toHaveBeenCalledTimes(1);
  });

  it("returns an out-of-tenant 404 identical to the unknown-change 404", async () => {
    const token = await login("coordinator");
    const foreign = await request(app)
      .post("/api/projects/proj_b/change-analyses/ca_a/changes/rc_a/review")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    const unknown = await request(app)
      .post("/api/projects/proj_b/change-analyses/ca_b/changes/rc_nope/review")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(foreign.status).toBe(unknown.status);
    // `correlationId` is per-request by design; the discriminating part of the
    // envelope is the error itself.
    expect(foreign.body.error).toEqual(unknown.body.error);
  });
});

describe("the project-scoped routes on the same router stay scoped", () => {
  it("GET / lists only the path project's analyses", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/projects/proj_b/change-analyses")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual(["ca_b"]);
  });

  it("POST / refuses to build an analysis out of another project's runs", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_b/change-analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ baseAnalysisId: "an_alpha_0001", headAnalysisId: "an_alpha_0002" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("BASE_ANALYSIS_NOT_FOUND");
    expect(prismaMock.changeAnalysis.create).not.toHaveBeenCalled();
  });
});

describe("the router carries its own project-scope guard", () => {
  it("404s a path project the caller cannot reach, without touching the resource", async () => {
    // Not the catch-all's doing: this asserts the router itself refuses a
    // workspace-A path project, so the fix does not depend on mount ORDER.
    const { changeAnalysisRouter } = await import("../src/routes/change-analysis.js");
    const express = (await import("express")).default;
    const { errorHandler } = await import("../src/middleware/error-handler.js");

    const solo = express();
    solo.use(express.json());
    solo.use("/projects/:projectId/change-analyses", changeAnalysisRouter());
    solo.use(errorHandler);

    const token = await login("coordinator");
    const res = await request(solo)
      .get("/projects/proj_a/change-analyses/ca_a")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(prismaMock.changeAnalysis.findFirst).not.toHaveBeenCalled();
  });
});
