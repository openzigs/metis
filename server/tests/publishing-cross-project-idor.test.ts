/**
 * /api/projects/:projectId/publishing — cross-project IDOR regression tests
 * (Issue #1072, epic #1051).
 *
 * `publishingRouter()` IS mounted under `/projects/:projectId`, so the upstream
 * catch-all (`projects.ts:94`) verifies the caller may reach the project named
 * in the PATH. That guard is useless on its own for the routes that resolved
 * their resource by bare primary key: the caller passes the path check
 * legitimately — it is their own project — and then acts on another tenant's
 * draft/batch supplied in the id slot.
 *
 * Every test below is constructed so the caller PASSES the path-project check
 * (`proj_mine` lives in their workspace). A test that fails only because the
 * catch-all rejected the request would prove nothing about this defect, so the
 * suite also asserts the negative control: the same caller succeeds against a
 * resource that really does belong to `proj_mine`.
 *
 * Fix shape (per #1055 / #1056): the owning project is pushed into the Prisma
 * `where`, so the scope lives in the query and cannot be forgotten by a later
 * caller. Note the deliberate difference from #1055's admin bypass: here the
 * projectId comes from the REQUEST PATH, not from an authorization lookup, so
 * it narrows the query for system admins too — a batch of `proj_other` is
 * simply not addressable at a `/projects/proj_mine/...` URL.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface DraftRow {
  id: string;
  projectId: string;
  requirementId: string | null;
  parentDraftId: string | null;
  draftType: string;
  title: string;
  body: string;
  labels: string;
  assignees: string;
  storyPoints: number;
  status: string;
  dedupHash: string | null;
  metadata: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface BatchRow {
  id: string;
  projectId: string;
  status: string;
  targetOwner: string;
  targetRepo: string;
  targetBaseUrl: string | null;
  provider: string;
  dryRun: boolean;
  totalDrafts: number;
  publishedCount: number;
  failedCount: number;
  dedupSkipped: number;
  archived: boolean;
  archivedAt: Date | null;
  archiveReason: string | null;
  archivedById: string | null;
  dryRunPlan: string | null;
  startedById: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Caller's own project (path project) → their workspace. */
const MINE = "proj_mine";
/** Another tenant's project — never in the caller's workspace. */
const OTHER = "proj_other";

const drafts = new Map<string, DraftRow>();
const batches = new Map<string, BatchRow>();
/** projectId → workspaceId, consulted by `assertProjectAccess`. */
const projectWorkspaces = new Map<string, string | null>();

function matches(row: { id: string; projectId: string; deletedAt?: Date | null }, where: Where) {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
  if (where.deletedAt === null && row.deletedAt) return false;
  return true;
}

interface Where {
  id?: string;
  projectId?: string;
  deletedAt?: Date | null;
}

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    // The caller is a member of exactly one workspace.
    workspaceMember: { findMany: vi.fn(async () => [{ workspaceId: "ws_caller" }]) },
    user: {
      upsert: vi.fn(async ({ create }: { create: { username: string } }) => ({
        id: `user_${create.username}`,
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (!projectWorkspaces.has(where.id)) return null;
        return {
          workspaceId: projectWorkspaces.get(where.id) ?? null,
          publishDestination: "github",
          jiraConnectionId: null,
          jiraProjectKey: null,
          requireApprovedReview: false,
        };
      }),
    },
    requirement: { findMany: vi.fn(async () => []) },
    reviewRequestItem: { findMany: vi.fn(async () => []) },
    issueDraft: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        [...drafts.values()].filter((d) => matches(d, where)),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Where }) =>
          [...drafts.values()].find((d) => matches(d, where)) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: Where }) =>
          [...drafts.values()].find((d) => matches(d, where)) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DraftRow> }) => {
        const row = drafts.get(where.id);
        if (!row) throw new Error("not found");
        const next = { ...row, ...data, updatedAt: new Date() };
        drafts.set(where.id, next);
        return next;
      }),
    },
    publishBatch: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        [...batches.values()].filter((b) => matches(b, where)),
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const row = [...batches.values()].find((b) => matches(b, where));
        return row ? { ...row, publishedIssues: [] } : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: Where }) => {
        const row = [...batches.values()].find((b) => matches(b, where));
        return row ? { ...row, publishedIssues: [] } : null;
      }),
      create: vi.fn(async ({ data }: { data: BatchRow }) => data),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<BatchRow> }) => {
        const row = batches.get(where.id)!;
        const next = { ...row, ...data };
        batches.set(where.id, next);
        return next;
      }),
    },
    repoConnection: { findFirst: vi.fn(async () => null) },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const archiveImpl = vi.fn(async () => undefined);
vi.mock("../src/lib/publishing/publisher.js", () => ({
  runBatch: vi.fn(async () => ({ status: "completed" })),
  archiveBatch: (...args: unknown[]) => archiveImpl(...(args as [])),
  configurePublisher: vi.fn(),
}));

vi.mock("../src/lib/publishing/draft-generator.js", () => ({
  generateDrafts: vi.fn(async () => ({
    total: 1,
    epics: 1,
    features: 0,
    upserted: 1,
    refreshed: 0,
  })),
}));

import request from "supertest";
import type { Test } from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function seedDraft(id: string, projectId: string): DraftRow {
  const row: DraftRow = {
    id,
    projectId,
    requirementId: null,
    parentDraftId: null,
    draftType: "feature",
    title: id,
    body: "body",
    labels: "[]",
    assignees: "[]",
    storyPoints: 1,
    status: "draft",
    dedupHash: null,
    metadata: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  drafts.set(id, row);
  return row;
}

function seedBatch(id: string, projectId: string, startedById = "user_coordinator"): BatchRow {
  const row: BatchRow = {
    id,
    projectId,
    status: "completed",
    targetOwner: "acme",
    targetRepo: "metis",
    targetBaseUrl: null,
    provider: "github",
    dryRun: true,
    totalDrafts: 0,
    publishedCount: 0,
    failedCount: 0,
    dedupSkipped: 0,
    archived: false,
    archivedAt: null,
    archiveReason: null,
    archivedById: null,
    dryRunPlan: null,
    startedById,
    startedAt: new Date(),
    completedAt: new Date(),
    errorMessage: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  batches.set(id, row);
  return row;
}

/**
 * The three bare-id routes. `foreign` addresses another tenant's resource
 * through the caller's OWN project path; `own` addresses the caller's.
 */
const idRoutes: ReadonlyArray<{
  name: string;
  send: (token: string, path: string) => Test;
  ownPath: string;
  foreignPath: string;
  unknownPath: string;
}> = [
  {
    name: "POST /drafts/:id/approve",
    send: (t, p) => request(app).post(p).set("Authorization", `Bearer ${t}`).send({}),
    ownPath: `/api/projects/${MINE}/publishing/drafts/draft_mine/approve`,
    foreignPath: `/api/projects/${MINE}/publishing/drafts/draft_other/approve`,
    unknownPath: `/api/projects/${MINE}/publishing/drafts/draft_ghost/approve`,
  },
  {
    name: "GET /batches/:id",
    send: (t, p) => request(app).get(p).set("Authorization", `Bearer ${t}`),
    ownPath: `/api/projects/${MINE}/publishing/batches/batch_mine`,
    foreignPath: `/api/projects/${MINE}/publishing/batches/batch_other`,
    unknownPath: `/api/projects/${MINE}/publishing/batches/batch_ghost`,
  },
  {
    name: "POST /batches/:id/archive",
    send: (t, p) =>
      request(app)
        .post(p)
        .set("Authorization", `Bearer ${t}`)
        .send({ reason: "cleanup", closeIssues: false }),
    ownPath: `/api/projects/${MINE}/publishing/batches/batch_mine/archive`,
    foreignPath: `/api/projects/${MINE}/publishing/batches/batch_other/archive`,
    unknownPath: `/api/projects/${MINE}/publishing/batches/batch_ghost/archive`,
  },
];

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  drafts.clear();
  batches.clear();
  projectWorkspaces.clear();
  projectWorkspaces.set(MINE, "ws_caller");
  projectWorkspaces.set(OTHER, "ws_other");
  seedDraft("draft_mine", MINE);
  seedDraft("draft_other", OTHER);
  // The caller owns their batch, so a 403 owner check can never be what
  // produces the cross-project 404 below.
  seedBatch("batch_mine", MINE);
  seedBatch("batch_other", OTHER);
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("path-project check alone does not protect the bare-id routes", () => {
  it("the caller legitimately passes the upstream catch-all for their own project", async () => {
    // Negative control for the whole file: if this ever 404s, every assertion
    // below would pass for the wrong reason.
    const token = await login("coordinator");
    const res = await request(app)
      .get(`/api/projects/${MINE}/publishing/drafts`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { id: string }) => d.id)).toEqual(["draft_mine"]);
  });
});

describe("cross-project resource ids → 404", () => {
  for (const route of idRoutes) {
    it(`${route.name} refuses another project's id`, async () => {
      const token = await login("coordinator");
      const res = await route.send(token, route.foreignPath);
      expect(res.status).toBe(404);
    });
  }

  it("never mutates the foreign draft", async () => {
    const token = await login("coordinator");
    await route(0).send(token, route(0).foreignPath);
    expect(drafts.get("draft_other")!.status).toBe("draft");
  });

  it("never reaches the archive implementation for a foreign batch", async () => {
    const token = await login("coordinator");
    const res = await route(2).send(token, route(2).foreignPath);
    expect(res.status).toBe(404);
    expect(archiveImpl).not.toHaveBeenCalled();
    expect(batches.get("batch_other")!.archived).toBe(false);
  });

  it("leaks no batch detail for a foreign id", async () => {
    const token = await login("coordinator");
    const res = await route(1).send(token, route(1).foreignPath);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("batch_other");
  });

  for (const r of idRoutes) {
    it(`${r.name} answers a foreign id exactly like an unknown id`, async () => {
      const token = await login("coordinator");
      const foreign = await r.send(token, r.foreignPath);
      const unknown = await r.send(token, r.unknownPath);
      expect(foreign.status).toBe(unknown.status);
      expect(foreign.body.error).toEqual(unknown.body.error);
    });
  }

  it("narrows for system admins too — the path project scopes the query", async () => {
    // Distinct from #1055/#1056: the projectId here is the REQUEST PATH, not a
    // resolved authorization scope, so admin's authz bypass does not widen it.
    const token = await login("admin");
    const res = await route(1).send(token, route(1).foreignPath);
    expect(res.status).toBe(404);
  });
});

describe("same-project callers still succeed (over-blocking regression)", () => {
  it("approves the caller's own draft", async () => {
    const token = await login("coordinator");
    const res = await route(0).send(token, route(0).ownPath);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");
    expect(drafts.get("draft_mine")!.status).toBe("approved");
  });

  it("reads the caller's own batch", async () => {
    const token = await login("coordinator");
    const res = await route(1).send(token, route(1).ownPath);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("batch_mine");
    expect(res.body.data.publishedIssues).toEqual([]);
  });

  it("archives the caller's own batch", async () => {
    const token = await login("coordinator");
    const res = await route(2).send(token, route(2).ownPath);
    expect(res.status).toBe(200);
    expect(archiveImpl).toHaveBeenCalled();
  });

  it("keeps the batch-owner check (403, not 404) for an in-project non-owner", async () => {
    // The ownership rule (F5) must survive the scoping change: a same-project
    // caller who did not start the batch still gets the ownership 403.
    seedBatch("batch_mine", MINE, "someone_else");
    const token = await login("coordinator");
    const res = await route(2).send(token, route(2).ownPath);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PUBLISH_BATCH_FORBIDDEN");
  });

  it("keeps pre-migration null-workspace projects open", async () => {
    projectWorkspaces.set(MINE, null);
    const token = await login("coordinator");
    const res = await route(1).send(token, route(1).ownPath);
    expect(res.status).toBe(200);
  });

  it("admins still act on resources addressed by their real project path", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get(`/api/projects/${OTHER}/publishing/batches/batch_other`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("batch_other");
  });
});

function route(i: number) {
  return idRoutes[i];
}
