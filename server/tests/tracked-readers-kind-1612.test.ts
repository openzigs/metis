/**
 * Issue #1612 (review fix) — `kind` / `nfrCategory` are tracked fields, so every
 * reader that replays version diffs from the requirement's CURRENT row must
 * select them. A reader whose hand-listed select misses a tracked column sees
 * `null` as the current value and reconstructs every past version wrong.
 *
 * The stand-in database honours `select` like Prisma does (a column not asked
 * for is absent from the row), so the read-back is only right if the production
 * select is right. Covers the two readers the first cut missed: the history
 * route (timeline, export) and baseline snapshots / compare.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// #2491 — the source filter is pinned over a real database in
// tests/source-redaction-2491.sqlite.test.ts; here nothing is restricted.
vi.mock("../src/lib/analysis/source-redaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/analysis/source-redaction.js")>()),
  restrictedIds: async () => new Set<string>(),
  restrictedRequirementIds: async () => new Set<string>(),
}));
import express from "express";
import request from "supertest";

/** The requirement as stored NOW: classified at v2 as non-functional/security. */
const STORED = {
  id: "req-1",
  projectId: "proj-1",
  version: 2,
  sourceDecision: null,
  title: "Title",
  body: "Body",
  priority: "high",
  type: "feature",
  labels: "[]",
  storyPoints: 3,
  acceptanceCriteria: "[]",
  kind: "non-functional",
  nfrCategory: "security",
  deletedAt: null,
};

const VERSIONS = [
  {
    requirementId: "req-1",
    version: 2,
    changedFields: JSON.stringify({
      kind: { from: null, to: "non-functional" },
      nfrCategory: { from: null, to: "security" },
    }),
    actorId: "user-1",
    reason: null,
    createdAt: new Date("2026-02-01T00:00:00Z"),
  },
];

function project(row: Record<string, unknown>, select: Record<string, boolean>) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => select[k]));
}

const mockPrisma = {
  requirement: {
    // Honours the project scope in `where`, as the database would (#1118).
    findUnique: vi.fn(
      async (args: { where: { projectId?: string }; select: Record<string, boolean> }) =>
        args.where.projectId && args.where.projectId !== STORED.projectId
          ? null
          : project(STORED, args.select),
    ),
    findMany: vi.fn(async (args: { select: Record<string, boolean> }) => [
      project(STORED, args.select),
    ]),
  },
  requirementVersion: { findMany: vi.fn(async () => VERSIONS) },
  reviewRequestItem: { findMany: vi.fn(async () => []) },
  project: { findUnique: vi.fn(async () => ({ requireApprovedReview: false })) },
  // #1580 — GET /history names each version's actor.
  user: { findMany: vi.fn(async () => []) },
  baseline: {
    findUnique: vi.fn(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      projectId: "proj-1",
      reviewRequestId: null,
      name: args.where.id,
      description: null,
      createdAt: new Date("2026-03-01T00:00:00Z"),
      createdBy: null,
      reviewRequest: null,
      // A pins v1 (before the classification), B pins v2 (after it).
      items: [
        {
          requirementId: "req-1",
          version: args.where.id === "base-a" ? 1 : 2,
          createdAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    })),
  },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
let caller: { userId: string; role: string; workspaces: string[] } = {
  userId: "user-1",
  role: "admin",
  workspaces: [],
};
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: unknown }).user = { ...caller, permissions: [] };
    next();
  },
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { requirementHistoryRouter } = await import("../src/routes/requirement-history.js");
const { getBaselineContents, compareBaselines } =
  await import("../src/lib/reviews/baseline-service.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");

/**
 * The project `requireRequirementAccess` resolved for the caller (#1118), which
 * the route narrows its read to. `null` ⇒ no scope resolved (an admin).
 */
let resolvedProjectId: string | null = null;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (resolvedProjectId) {
      (req as unknown as { requirementProjectId: string }).requirementProjectId = resolvedProjectId;
    }
    next();
  });
  a.use("/requirements", requirementHistoryRouter());
  a.use(errorHandler);
  return a;
}

describe("#1612 — tracked kind survives the history and baseline read paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    caller = { userId: "user-1", role: "admin", workspaces: [] };
    resolvedProjectId = null;
  });

  // #1636 — this replaces a "non-admin reader" case that ran exactly the
  // admin request below (permissions are stubbed here). A non-admin's read is
  // narrowed to the project their access resolved to: inside it they see the
  // real kind, and a requirement of another project is not found.
  it("a non-admin reader sees the real kind in their project, and 404s outside it", async () => {
    caller = { userId: "user-2", role: "reader", workspaces: ["ws-1"] };
    resolvedProjectId = "proj-1";
    const res = await request(app()).get("/requirements/req-1/history");
    expect(res.status).toBe(200);
    const v2 = res.body.data.versions.find((v: { version: number }) => v.version === 2);
    expect(v2.snapshot.kind).toBe("non-functional");

    resolvedProjectId = "proj-other";
    const outside = await request(app()).get("/requirements/req-1/history");
    expect(outside.status).toBe(404);
    expect(mockPrisma.requirement.findUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: "proj-other" }) }),
    );
  });

  it("GET /history reports the kind each version really had", async () => {
    const res = await request(app()).get("/requirements/req-1/history");
    expect(res.status).toBe(200);
    const v2 = res.body.data.versions.find((v: { version: number }) => v.version === 2);
    expect(v2.snapshot.kind).toBe("non-functional");
    expect(v2.snapshot.nfrCategory).toBe("security");
  });

  it("history export (JSON) carries the real kind, not null", async () => {
    const res = await request(app()).get("/requirements/req-1/history/export?format=json");
    const v2 = JSON.parse(res.text).versions.find((v: { version: number }) => v.version === 2);
    expect(v2.snapshot.kind).toBe("non-functional");
    expect(v2.snapshot.nfrCategory).toBe("security");
  });

  it("a baseline snapshot replays kind as of the pinned version", async () => {
    const contents = (await getBaselineContents("base-b")) as {
      items: Array<{ snapshot: { kind: unknown; nfrCategory: unknown } }>;
    };
    expect(contents.items[0].snapshot.kind).toBe("non-functional");
    expect(contents.items[0].snapshot.nfrCategory).toBe("security");
    const before = (await getBaselineContents("base-a")) as typeof contents;
    expect(before.items[0].snapshot.kind).toBeNull();
  });

  it("compareBaselines shows the classification that really changed between pins", async () => {
    const result = await compareBaselines("base-a", "base-b");
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].changedFields).toMatchObject({
      kind: { from: null, to: "non-functional" },
      nfrCategory: { from: null, to: "security" },
    });
  });
});
