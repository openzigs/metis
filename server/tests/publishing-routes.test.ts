/**
 * /api/projects/:projectId/publishing — route layer integration tests.
 *
 * Brings up the Express app with mocked Prisma + a fully stubbed publishing
 * pipeline so we can exercise authentication, RBAC, schema validation, the
 * cross-project guard, archive ownership checks, and error mapping. Lib
 * tests already cover publisher mechanics; here we focus exclusively on
 * the route surface so the file's coverage actually reflects what the
 * layer is responsible for.
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

interface RepoConnRow {
  id: string;
  projectId: string;
  ownerOrOrg: string;
  repoName: string;
  deletedAt: Date | null;
}

const drafts = new Map<string, DraftRow>();
const batches = new Map<string, BatchRow>();
const repoConns = new Map<string, RepoConnRow>();
let n = 0;

// #619 — mutable approval-gate state (defaults preserve pre-gate behavior).
let requireApprovedReview = false;
let gateProjectLookupThrows = false;
/** requirementId -> current version (live requirements in proj_test_001). */
const gateRequirements = new Map<string, number>();
/** approved review pins: requirementId -> pinnedVersion. */
const gateApprovedPins = new Map<string, number>();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({ id: `user_${create.username}`, ...create }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      // #619 — gate off by default so pre-existing route tests keep their
      // original (ungated) behavior; gate cases mutate the state above.
      findUnique: vi.fn(async () => {
        if (gateProjectLookupThrows) throw new Error("db down");
        return {
          publishDestination: "github",
          jiraConnectionId: null,
          jiraProjectKey: null,
          requireApprovedReview,
        };
      }),
    },
    requirement: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .filter((id) => gateRequirements.has(id))
          .map((id) => ({ id, version: gateRequirements.get(id)! })),
      ),
    },
    reviewRequestItem: {
      findMany: vi.fn(async ({ where }: { where: { requirementId: { in: string[] } } }) =>
        where.requirementId.in
          .filter((id) => gateApprovedPins.has(id))
          .map((id) => ({ requirementId: id, pinnedVersion: gateApprovedPins.get(id)! })),
      ),
    },
    issueDraft: {
      findMany: vi.fn(
        async ({ where }: { where: { projectId?: string; id?: { in: string[] } } }) => {
          let rows = [...drafts.values()].filter((d) => !d.deletedAt);
          if (where.projectId) rows = rows.filter((d) => d.projectId === where.projectId);
          if (where.id?.in) rows = rows.filter((d) => where.id!.in!.includes(d.id));
          return rows;
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => drafts.get(where.id) ?? null,
      ),
      // #1072 — approveDraft scopes the lookup by { id, projectId }.
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
        const row = drafts.get(where.id);
        if (!row) return null;
        return where.projectId !== undefined && row.projectId !== where.projectId ? null : row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DraftRow> }) => {
        const r = drafts.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() };
        drafts.set(where.id, next);
        return next;
      }),
    },
    publishBatch: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string; archived?: boolean } }) => {
        return [...batches.values()].filter(
          (b) =>
            b.projectId === where.projectId &&
            (where.archived === undefined ? true : b.archived === where.archived),
        );
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = batches.get(where.id);
        if (!row) return null;
        return { ...row, publishedIssues: [] };
      }),
      // #1072 — getBatch/archiveBatch scope the lookup by { id, projectId }.
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
        const row = batches.get(where.id);
        if (!row) return null;
        if (where.projectId !== undefined && row.projectId !== where.projectId) return null;
        return { ...row, publishedIssues: [] };
      }),
      create: vi.fn(async ({ data }: { data: Partial<BatchRow> }) => {
        n += 1;
        const row: BatchRow = {
          id: `batch_${n}`,
          projectId: "proj_test_001",
          status: "pending",
          targetOwner: "acme",
          targetRepo: "metis",
          targetBaseUrl: null,
          provider: "github",
          dryRun: false,
          totalDrafts: 0,
          publishedCount: 0,
          failedCount: 0,
          dedupSkipped: 0,
          archived: false,
          archivedAt: null,
          archiveReason: null,
          archivedById: null,
          dryRunPlan: null,
          startedById: "user_admin",
          startedAt: new Date(),
          completedAt: null,
          errorMessage: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(data as BatchRow),
        };
        batches.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<BatchRow> }) => {
        const r = batches.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() };
        batches.set(where.id, next);
        return next;
      }),
    },
    repoConnection: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            ownerOrOrg: string;
            repoName: string;
            projectId: { not: string };
          };
        }) => {
          for (const r of repoConns.values()) {
            if (r.deletedAt) continue;
            if (
              r.ownerOrOrg === where.ownerOrOrg &&
              r.repoName === where.repoName &&
              r.projectId !== where.projectId.not
            )
              return r;
          }
          return null;
        },
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

// Stub the publisher pipeline — route tests don't exercise GitHub I/O.
vi.mock("../src/lib/publishing/publisher.js", () => ({
  runBatch: vi.fn(async () => ({ status: "completed" })),
  archiveBatch: vi.fn(async () => undefined),
  configurePublisher: vi.fn(),
  // #1104 (D) — the plan builder behind the pre-publish confirmation. Route
  // tests only care that the endpoint is reachable, authorized and inert.
  PREVIEW_PLAN_BATCH_ID: "preview-unsaved",
  previewBatchPlan: vi.fn(async () => ({
    batchId: "preview-unsaved",
    targetOwner: "acme",
    targetRepo: "metis",
    targetBaseUrl: "https://api.github.com",
    provider: "github",
    totalActions: 2,
    estimatedDurationMs: 2000,
    actions: [
      { kind: "label.upsert", labels: ["metis-generated"] },
      { kind: "issue.create", draftId: "draft_test_001", title: "T", body: "SECRET BODY" },
    ],
    credentialResolved: true,
    credentialCheck: "resolved",
    credentialErrorCode: null,
  })),
}));

// Stub the draft generator — not under test here.
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
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function seedDraft(id: string, status = "approved", over: Partial<DraftRow> = {}): DraftRow {
  const d: DraftRow = {
    id,
    projectId: "proj_test_001",
    requirementId: null,
    parentDraftId: null,
    draftType: "feature",
    title: id,
    body: "body",
    labels: "[]",
    assignees: "[]",
    storyPoints: 1,
    status,
    dedupHash: null,
    metadata: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  drafts.set(id, d);
  return d;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  drafts.clear();
  batches.clear();
  repoConns.clear();
  n = 0;
  requireApprovedReview = false;
  gateProjectLookupThrows = false;
  gateRequirements.clear();
  gateApprovedPins.clear();
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("auth gate", () => {
  it("rejects unauthenticated drafts list with 401", async () => {
    const res = await request(app).get("/api/projects/proj_test_001/publishing/drafts");
    expect(res.status).toBe(401);
  });
});

describe("GET /drafts", () => {
  it("admin sees drafts for the project (RBAC: issue.draft)", async () => {
    seedDraft("draft_test_001", "draft");
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_test_001/publishing/drafts")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("draft_test_001");
  });

  it("reader is rejected with 403", async () => {
    const token = await login("reader");
    const res = await request(app)
      .get("/api/projects/proj_test_001/publishing/drafts")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /drafts/generate", () => {
  it("developer can generate drafts (issue.draft)", async () => {
    const token = await login("developer");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/drafts/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({
        analysisId: "analysis_test_001",
        targetOwner: "acme",
        targetRepo: "metis",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.summary.total).toBe(1);
  });

  it("rejects invalid payload (zod 400)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/drafts/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ analysisId: "", targetOwner: "", targetRepo: "x" });
    expect(res.status).toBe(400);
  });

  it("reader is denied (RBAC)", async () => {
    const token = await login("reader");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/drafts/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ analysisId: "analysis_test_001", targetOwner: "acme", targetRepo: "metis" });
    expect(res.status).toBe(403);
  });
});

describe("POST /drafts/:id/approve", () => {
  it("approves a draft (issue.draft)", async () => {
    seedDraft("draft_test_002", "draft");
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/drafts/draft_test_002/approve")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");
  });

  it("404 when the draft does not exist", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/drafts/nope/approve")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /batches", () => {
  it("lists batches for the project (issue.preview)", async () => {
    batches.set("batch_seeded_001", {
      id: "batch_seeded_001",
      projectId: "proj_test_001",
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
      startedById: "user_admin",
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("includeArchived=true honoured", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_test_001/publishing/batches?includeArchived=true")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /batches/:id", () => {
  it("returns a batch detail with publishedIssues array", async () => {
    batches.set("batch_one_001", {
      id: "batch_one_001",
      projectId: "proj_test_001",
      status: "completed",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      dryRun: false,
      totalDrafts: 1,
      publishedCount: 1,
      failedCount: 0,
      dedupSkipped: 0,
      archived: false,
      archivedAt: null,
      archiveReason: null,
      archivedById: null,
      dryRunPlan: null,
      startedById: "user_admin",
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_test_001/publishing/batches/batch_one_001")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.publishedIssues).toEqual([]);
  });

  it("404 when missing", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_test_001/publishing/batches/missing")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /batches", () => {
  beforeEach(() => seedDraft("draft_test_x01", "approved"));

  it("dry-run path: developer (issue.preview) can create a 201 batch", async () => {
    const token = await login("developer");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send({
        targetOwner: "acme",
        targetRepo: "metis",
        provider: "github",
        dryRun: true,
        draftIds: ["draft_test_x01"],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.run.status).toBe("completed");
  });

  it("live publish: developer (no issue.publish) → 403", async () => {
    const token = await login("developer");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send({
        targetOwner: "acme",
        targetRepo: "metis",
        provider: "github",
        dryRun: false,
        draftIds: ["draft_test_x01"],
        secretRef: "${vault:gh}",
      });
    expect(res.status).toBe(403);
  });

  it("live publish: coordinator with issue.publish can run", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send({
        targetOwner: "acme",
        targetRepo: "metis",
        provider: "github",
        dryRun: false,
        draftIds: ["draft_test_x01"],
        secretRef: "${vault:gh}",
      });
    expect(res.status).toBe(201);
  });

  it("cross-project repo without confirmCrossProject → 409", async () => {
    repoConns.set("rc1", {
      id: "rc1",
      projectId: "proj_test_002",
      ownerOrOrg: "acme",
      repoName: "metis",
      deletedAt: null,
    });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send({
        targetOwner: "acme",
        targetRepo: "metis",
        provider: "github",
        dryRun: true,
        draftIds: ["draft_test_x01"],
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REPO_CROSS_PROJECT");
  });

  it("cross-project repo WITH confirmCrossProject=true → 201", async () => {
    repoConns.set("rc1", {
      id: "rc1",
      projectId: "proj_test_002",
      ownerOrOrg: "acme",
      repoName: "metis",
      deletedAt: null,
    });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send({
        targetOwner: "acme",
        targetRepo: "metis",
        provider: "github",
        dryRun: true,
        draftIds: ["draft_test_x01"],
        metadata: { confirmCrossProject: true },
      });
    expect(res.status).toBe(201);
  });

  it("zod validation error → 400 on missing draftIds", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send({
        targetOwner: "acme",
        targetRepo: "metis",
        provider: "github",
        dryRun: true,
        draftIds: [],
      });
    expect(res.status).toBe(400);
  });
});

// #1104 (D) — the confirmation's data source.
describe("POST /batches/preview", () => {
  const body = {
    targetOwner: "acme",
    targetRepo: "metis",
    provider: "github",
    dryRun: false,
    draftIds: ["draft_test_001"],
    additionalLabels: [],
    secretRef: "${vault:gh}",
  };

  it("returns the plan and creates no batch row", async () => {
    seedDraft("draft_test_001");
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/preview")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.targetOwner).toBe("acme");
    expect(res.body.data.totalActions).toBe(2);
    // The confirmation is not allowed to be the thing that writes.
    expect(batches.size).toBe(0);
  });

  it("strips issue bodies from the returned plan", async () => {
    seedDraft("draft_test_001");
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/preview")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("SECRET BODY");
  });

  it("developer (issue.preview) may preview even though they cannot publish", async () => {
    seedDraft("draft_test_001");
    const token = await login("developer");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/preview")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(res.status).toBe(200);
  });

  it("reader (no issue.preview) is rejected with 403", async () => {
    const token = await login("reader");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/preview")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(res.status).toBe(403);
  });

  it("invalid payload → 400 (zod)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...body, draftIds: [] });
    expect(res.status).toBe(400);
  });
});

// #1104 (F) — the remedy for a stranded batch.
describe("POST /batches/:id/cancel", () => {
  function seedStranded(over: Partial<BatchRow> = {}): void {
    batches.set("batch_stranded", {
      id: "batch_stranded",
      projectId: "proj_test_001",
      status: "pending",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      dryRun: false,
      totalDrafts: 14,
      publishedCount: 0,
      failedCount: 0,
      dedupSkipped: 0,
      archived: false,
      archivedAt: null,
      archiveReason: null,
      archivedById: null,
      dryRunPlan: null,
      startedById: "user_coordinator",
      startedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
      completedAt: null,
      errorMessage: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
  }

  it("the batch owner can cancel a stranded pending batch", async () => {
    seedStranded();
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_stranded/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("cancelled");
  });

  it("refuses a batch that may still be in flight with 409", async () => {
    seedStranded({ status: "running", startedAt: new Date() });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_stranded/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BATCH_IN_FLIGHT");
    expect(batches.get("batch_stranded")!.status).toBe("running");
  });

  it("developer (no issue.publish) is rejected at the route layer with 403", async () => {
    seedStranded();
    const token = await login("developer");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_stranded/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("404s for a batch belonging to another project", async () => {
    seedStranded({ projectId: "proj_other" });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_stranded/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /batches/:id/archive", () => {
  beforeEach(() => {
    batches.set("batch_arc_001", {
      id: "batch_arc_001",
      projectId: "proj_test_001",
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
      startedById: "user_coordinator",
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("admin can archive any batch", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_arc_001/archive")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "cleanup", closeIssues: false });
    expect(res.status).toBe(200);
  });

  it("the batch owner (coordinator who started it) can archive it", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_arc_001/archive")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "owner cleanup", closeIssues: false });
    expect(res.status).toBe(200);
  });

  it("a non-owner coordinator who has issue.publish is still rejected at the service layer (F5)", async () => {
    // Switch the batch's startedById so the logged-in coordinator is NOT the owner.
    batches.get("batch_arc_001")!.startedById = "someone_else";
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_arc_001/archive")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "nope", closeIssues: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PUBLISH_BATCH_FORBIDDEN");
  });

  it("developer (no issue.publish) is rejected at the route layer with 403", async () => {
    const token = await login("developer");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_arc_001/archive")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "nope", closeIssues: false });
    expect(res.status).toBe(403);
  });

  it("invalid payload → 400 (zod)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches/batch_arc_001/archive")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "" });
    expect(res.status).toBe(400);
  });
});

describe("error mapping", () => {
  it("PublishError.404 from the service surfaces as 404 with no token leak", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/drafts/missing/approve")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("vault:");
  });
});

// ---------------------------------------------------------------------------
// #619 — approval gate (requireApprovedReview) on the publishing routes
// ---------------------------------------------------------------------------

describe("approval gate (#619)", () => {
  const batchBody = {
    targetOwner: "acme",
    targetRepo: "metis",
    provider: "github",
    dryRun: false,
    draftIds: ["draft_gate_1"],
    secretRef: "${vault:gh}",
  };

  it("blocks a LIVE batch with 409 APPROVAL_REQUIRED when the requirement has no approved review", async () => {
    requireApprovedReview = true;
    gateRequirements.set("req_1", 1); // exists, but no approved pin
    seedDraft("draft_gate_1", "approved", { requirementId: "req_1" });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send(batchBody);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(res.body.error.details.requirementIds).toEqual(["req_1"]);
  });

  it("blocks a STALE approval (approved at v1, requirement now v2)", async () => {
    requireApprovedReview = true;
    gateRequirements.set("req_1", 2);
    gateApprovedPins.set("req_1", 1);
    seedDraft("draft_gate_1", "approved", { requirementId: "req_1" });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send(batchBody);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
  });

  it("blocks an UNLINKED draft (no requirement) when the gate is on", async () => {
    requireApprovedReview = true;
    seedDraft("draft_gate_1", "approved"); // requirementId null, no metadata
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send(batchBody);
    expect(res.status).toBe(409);
    expect(res.body.error.details.unlinkedDraftIds).toEqual(["draft_gate_1"]);
  });

  it("allows a LIVE batch when the approval pins the CURRENT version", async () => {
    requireApprovedReview = true;
    gateRequirements.set("req_1", 3);
    gateApprovedPins.set("req_1", 3);
    seedDraft("draft_gate_1", "approved", { requirementId: "req_1" });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send(batchBody);
    expect(res.status).toBe(201);
  });

  it("dry-run batches are exempt (pure preview, no external writes)", async () => {
    requireApprovedReview = true;
    seedDraft("draft_gate_1", "approved"); // would be blocked live
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...batchBody, dryRun: true, secretRef: undefined });
    expect(res.status).toBe(201);
  });

  it("blocks POST /drafts/:id/approve when the gate is on and the review is missing", async () => {
    requireApprovedReview = true;
    gateRequirements.set("req_1", 1);
    seedDraft("draft_gate_1", "draft", { requirementId: "req_1" });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/drafts/draft_gate_1/approve")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
  });

  it("FAIL CLOSED: a gate-check error blocks the live batch with 503", async () => {
    requireApprovedReview = true;
    gateProjectLookupThrows = true;
    seedDraft("draft_gate_1", "approved", { requirementId: "req_1" });
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send(batchBody);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("APPROVAL_GATE_UNAVAILABLE");
  });

  it("gate off: live publish of an unreviewed draft still works (regression)", async () => {
    requireApprovedReview = false;
    seedDraft("draft_gate_1", "approved");
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/publishing/batches")
      .set("Authorization", `Bearer ${token}`)
      .send(batchBody);
    expect(res.status).toBe(201);
  });
});
