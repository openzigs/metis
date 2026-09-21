/**
 * Epic #609 / Issue #617 — Review-request REST API tests.
 *
 * Covers: RBAC (real `requirePermission` against the shared registry),
 * self-approval prevention, assignment-scoped decisions, double-decision
 * conflicts, all/quorum aggregation edges, atomic approval → baseline
 * creation, version pinning at submit, mass-assignment resistance, and the
 * audit trail on every transition + decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ---- Mocks -----------------------------------------------------------------

const mockPrisma = {
  project: { findUnique: vi.fn() },
  requirement: { findMany: vi.fn(), updateMany: vi.fn() },
  generatedDocument: { findMany: vi.fn() },
  generatedDocumentVersion: { findFirst: vi.fn() },
  user: { findMany: vi.fn() },
  reviewRequest: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  reviewRequestItem: { update: vi.fn() },
  reviewerAssignment: { updateMany: vi.fn(), findMany: vi.fn() },
  baseline: { create: vi.fn() },
  auditLog: { findMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

// #621 — review notification fan-out is fire-and-forget and tested in its own
// suites (src/lib/reviews/notify.test.ts + review-service-notify.test.ts);
// stub it here so route tests stay hermetic (no socket registry / stray warns).
vi.mock("../src/lib/reviews/notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));

// Keep the REAL `buildAuditLogData` (the service persists sign-off evidence
// via `tx.auditLog.create`) but spy on the fire-and-forget `audit()` queue so
// tests can assert sign-off records do NOT go through it.
const auditSpy = vi.fn();
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/audit/audit-service.js")>();
  return { ...actual, audit: auditSpy };
});

// Mutable test-user — mutate `role`/`userId` between tests. The REAL
// `requirePermission` middleware runs against the shared RBAC registry.
const testUser = {
  userId: "user-req",
  username: "alice",
  role: "coordinator",
  permissions: [],
};

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: typeof testUser }).user = { ...testUser };
    next();
  },
}));

const { projectReviewsRouter, reviewsRouter } = await import("../src/routes/reviews.js");

// ---- App factory -----------------------------------------------------------

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/reviews", projectReviewsRouter());
  app.use("/reviews", reviewsRouter());
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { statusCode?: number; code?: string; message?: string };
      res.status(e.statusCode ?? 500).json({
        error: { code: e.code ?? "INTERNAL", message: e.message ?? "?" },
      });
    },
  );
  return app;
}

// ---- Fixtures ---------------------------------------------------------------

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    reviewRequestId: "rev-1",
    requirementId: "req-1",
    generatedDocumentId: null,
    pinnedVersion: 2,
    ...overrides,
  };
}

function makeAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: "asg-1",
    reviewRequestId: "rev-1",
    reviewerId: "user-rev-1",
    decision: "pending",
    note: null,
    decidedAt: null,
    ...overrides,
  };
}

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev-1",
    projectId: "proj-1",
    title: "Sprint 4 sign-off",
    description: "",
    status: "in_review",
    policy: "all",
    quorum: null,
    requestedById: "user-req",
    dueAt: null,
    decidedAt: null,
    items: [makeItem()],
    assignments: [makeAssignment()],
    ...overrides,
  };
}

const VALID_CREATE_BODY = {
  title: "Sprint 4 sign-off",
  reviewerIds: ["user-rev-1", "user-rev-2"],
  items: [{ requirementId: "req-1" }],
};

function primeCreateMocks() {
  mockPrisma.project.findUnique.mockResolvedValue({ id: "proj-1" });
  mockPrisma.requirement.findMany.mockResolvedValue([{ id: "req-1", version: 3 }]);
  mockPrisma.generatedDocument.findMany.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([{ id: "user-rev-1" }, { id: "user-rev-2" }]);
  mockPrisma.reviewRequest.create.mockImplementation(({ data }: { data: never }) =>
    Promise.resolve(makeReview({ status: "draft", ...(data as object) })),
  );
}

let app: ReturnType<typeof createApp>;

// True while the `$transaction` callback is executing — lets tests assert an
// `auditLog.create` happened INSIDE the transaction (not fire-and-forget after).
let inTransaction = false;
const auditCreateInTx: boolean[] = [];

/** Every `auditLog.create` call: data + whether it ran inside the transaction. */
function auditRows(): Array<Record<string, unknown> & { metadata: unknown; inTx: boolean }> {
  return mockPrisma.auditLog.create.mock.calls.map(([arg], i) => {
    const data = (arg as { data: Record<string, unknown> }).data;
    return {
      ...data,
      metadata: typeof data.metadata === "string" ? JSON.parse(data.metadata) : null,
      inTx: auditCreateInTx[i],
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  testUser.userId = "user-req";
  testUser.role = "coordinator";
  inTransaction = false;
  auditCreateInTx.length = 0;
  mockPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    if (typeof fn !== "function") return Promise.all(fn as Promise<unknown>[]);
    inTransaction = true;
    try {
      return await (fn as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
    } finally {
      inTransaction = false;
    }
  });
  mockPrisma.auditLog.create.mockImplementation(({ data }: { data: object }) => {
    auditCreateInTx.push(inTransaction);
    return Promise.resolve({ id: `audit-${auditCreateInTx.length}`, ...data });
  });
  mockPrisma.reviewerAssignment.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.reviewerAssignment.findMany.mockResolvedValue([{ decision: "pending" }]);
  mockPrisma.requirement.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.reviewRequest.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.reviewRequest.update.mockImplementation(({ data }: { data: object }) =>
    Promise.resolve(makeReview(data as Record<string, unknown>)),
  );
  mockPrisma.reviewRequestItem.update.mockResolvedValue(makeItem());
  app = createApp();
});

// ---- Create -----------------------------------------------------------------

describe("POST /projects/:projectId/reviews", () => {
  it("creates a draft review with items, assignments, and provisional pins", async () => {
    primeCreateMocks();

    const res = await request(app).post("/projects/proj-1/reviews").send(VALID_CREATE_BODY);

    expect(res.status).toBe(201);
    const createArg = mockPrisma.reviewRequest.create.mock.calls[0][0];
    expect(createArg.data.projectId).toBe("proj-1");
    expect(createArg.data.requestedById).toBe("user-req");
    expect(createArg.data.items.create).toEqual([
      { requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 3 },
    ]);
    expect(createArg.data.assignments.create).toEqual([
      { reviewerId: "user-rev-1" },
      { reviewerId: "user-rev-2" },
    ]);
    // Audit evidence commits in the same transaction as the create.
    expect(auditRows()).toContainEqual(
      expect.objectContaining({ action: "review.create", actorId: "user-req", inTx: true }),
    );
  });

  it("ignores privileged fields in the body (no mass assignment)", async () => {
    primeCreateMocks();

    const res = await request(app)
      .post("/projects/proj-1/reviews")
      .send({
        ...VALID_CREATE_BODY,
        status: "approved",
        requestedById: "evil-user",
        decidedAt: "2024-01-01T00:00:00Z",
      });

    expect(res.status).toBe(201);
    const createArg = mockPrisma.reviewRequest.create.mock.calls[0][0];
    expect(createArg.data.requestedById).toBe("user-req");
    expect(createArg.data.status).toBeUndefined();
    expect(createArg.data.decidedAt).toBeUndefined();
  });

  it("404s when the project does not exist", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);

    const res = await request(app).post("/projects/nope/reviews").send(VALID_CREATE_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("404s when a requirement item is not in the project (IDOR guard)", async () => {
    primeCreateMocks();
    mockPrisma.requirement.findMany.mockResolvedValue([]); // not found in THIS project

    const res = await request(app).post("/projects/proj-1/reviews").send(VALID_CREATE_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REVIEW_ITEM_NOT_FOUND");
  });

  it("rejects a reviewer list containing the requester (self-review)", async () => {
    primeCreateMocks();

    const res = await request(app)
      .post("/projects/proj-1/reviews")
      .send({ ...VALID_CREATE_BODY, reviewerIds: ["user-rev-1", "user-req"] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SELF_REVIEW_FORBIDDEN");
    expect(mockPrisma.reviewRequest.create).not.toHaveBeenCalled();
  });

  it("400s on an unsatisfiable quorum", async () => {
    primeCreateMocks();

    const res = await request(app)
      .post("/projects/proj-1/reviews")
      .send({ ...VALID_CREATE_BODY, policy: "quorum", quorum: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REVIEW_POLICY");
  });

  it("400s when an item references both a requirement and a document", async () => {
    primeCreateMocks();

    const res = await request(app)
      .post("/projects/proj-1/reviews")
      .send({
        ...VALID_CREATE_BODY,
        items: [{ requirementId: "req-1", generatedDocumentId: "doc-1" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400s when a reviewer id does not resolve to an active user", async () => {
    primeCreateMocks();
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-rev-1" }]);

    const res = await request(app).post("/projects/proj-1/reviews").send(VALID_CREATE_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REVIEWER_NOT_FOUND");
  });

  it("pins spec documents to their latest generated version", async () => {
    primeCreateMocks();
    mockPrisma.requirement.findMany.mockResolvedValue([]);
    mockPrisma.generatedDocument.findMany.mockResolvedValue([{ id: "doc-1" }]);
    mockPrisma.generatedDocumentVersion.findFirst.mockResolvedValue({ version: 7 });

    const res = await request(app)
      .post("/projects/proj-1/reviews")
      .send({ ...VALID_CREATE_BODY, items: [{ generatedDocumentId: "doc-1" }] });

    expect(res.status).toBe(201);
    const createArg = mockPrisma.reviewRequest.create.mock.calls[0][0];
    expect(createArg.data.items.create).toEqual([
      { requirementId: null, generatedDocumentId: "doc-1", pinnedVersion: 7 },
    ]);
  });

  it("403s for a reader (RBAC: review.create)", async () => {
    testUser.role = "reader";

    const res = await request(app).post("/projects/proj-1/reviews").send(VALID_CREATE_BODY);

    expect(res.status).toBe(403);
    expect(mockPrisma.reviewRequest.create).not.toHaveBeenCalled();
  });
});

// ---- Submit -----------------------------------------------------------------

describe("POST /reviews/:reviewId/submit", () => {
  it("moves draft → in_review, re-pins versions, and resets decisions", async () => {
    const review = makeReview({
      status: "draft",
      items: [makeItem({ pinnedVersion: 1 })],
      assignments: [makeAssignment({ decision: "approved" })],
    });
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(review);
    mockPrisma.requirement.findMany.mockResolvedValue([{ id: "req-1", version: 5 }]);

    const res = await request(app).post("/reviews/rev-1/submit").send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.reviewRequestItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { pinnedVersion: 5 },
    });
    expect(mockPrisma.reviewerAssignment.updateMany).toHaveBeenCalledWith({
      where: { reviewRequestId: "rev-1" },
      data: { decision: "pending", note: null, decidedAt: null },
    });
    // Guarded status write: only fires while the review is still in `draft`.
    expect(mockPrisma.reviewRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "rev-1", status: "draft" },
      data: { status: "in_review", decidedAt: null },
    });
    expect(mockPrisma.requirement.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["req-1"] } },
      data: { reviewStatus: "draft" },
    });
    expect(auditRows()).toContainEqual(
      expect.objectContaining({ action: "review.submit", inTx: true }),
    );
  });

  it("409s when the submit loses to a concurrent status change (guarded write)", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "draft" }));
    mockPrisma.requirement.findMany.mockResolvedValue([{ id: "req-1", version: 5 }]);
    mockPrisma.reviewRequest.updateMany.mockResolvedValue({ count: 0 }); // e.g. concurrent close

    const res = await request(app).post("/reviews/rev-1/submit").send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REVIEW_STATE_CHANGED");
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("403s when the caller is not the requester (and lacks review.admin)", async () => {
    testUser.userId = "user-other";
    testUser.role = "developer"; // has review.create but NOT review.admin
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "draft" }));

    const res = await request(app).post("/reviews/rev-1/submit").send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_REQUESTER");
  });

  it("allows a review.admin holder to submit on the requester's behalf", async () => {
    testUser.userId = "user-other";
    testUser.role = "admin";
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "draft" }));
    mockPrisma.requirement.findMany.mockResolvedValue([{ id: "req-1", version: 2 }]);

    const res = await request(app).post("/reviews/rev-1/submit").send({});

    expect(res.status).toBe(200);
  });

  it("409s on an illegal transition (already in_review)", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "in_review" }));

    const res = await request(app).post("/reviews/rev-1/submit").send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ILLEGAL_REVIEW_TRANSITION");
  });

  it("404s when the review does not exist", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(null);

    const res = await request(app).post("/reviews/nope/submit").send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REVIEW_NOT_FOUND");
  });

  it("409s when a requirement in scope has been deleted since drafting", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "draft" }));
    mockPrisma.requirement.findMany.mockResolvedValue([]); // gone

    const res = await request(app).post("/reviews/rev-1/submit").send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REVIEW_SCOPE_STALE");
  });
});

// ---- Decision ---------------------------------------------------------------

describe("POST /reviews/:reviewId/decision", () => {
  function primeDecision(review: ReturnType<typeof makeReview>) {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(review);
  }

  /** Fresh rows returned by the IN-TRANSACTION re-read of all assignments. */
  function primeFreshAssignments(...decisions: string[]) {
    mockPrisma.reviewerAssignment.findMany.mockResolvedValue(
      decisions.map((decision) => ({ decision })),
    );
  }

  it("records an approval that leaves the review pending (all-policy, 2 reviewers)", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        assignments: [makeAssignment(), makeAssignment({ id: "asg-2", reviewerId: "user-rev-2" })],
      }),
    );
    primeFreshAssignments("approved", "pending");

    const res = await request(app)
      .post("/reviews/rev-1/decision")
      .send({ decision: "approved", note: "LGTM" });

    expect(res.status).toBe(200);
    expect(res.body.data.aggregate).toBe("pending");
    expect(res.body.data.status).toBe("in_review");
    expect(mockPrisma.reviewerAssignment.updateMany).toHaveBeenCalledWith({
      where: { id: "asg-1", decision: "pending" },
      data: expect.objectContaining({ decision: "approved", note: "LGTM" }),
    });
    // Review status untouched; no baseline.
    expect(mockPrisma.reviewRequest.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.baseline.create).not.toHaveBeenCalled();
    expect(auditRows()).toContainEqual(
      expect.objectContaining({
        action: "review.decision",
        inTx: true,
        metadata: expect.objectContaining({
          decision: "approved",
          pinnedItems: [{ requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 2 }],
        }),
      }),
    );
  });

  it("final approval flips the review to approved and creates the baseline atomically", async () => {
    testUser.userId = "user-rev-2";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        assignments: [
          makeAssignment({ decision: "approved", decidedAt: new Date() }),
          makeAssignment({ id: "asg-2", reviewerId: "user-rev-2" }),
        ],
      }),
    );
    primeFreshAssignments("approved", "approved");
    mockPrisma.baseline.create.mockResolvedValue({ id: "base-1" });

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.data.aggregate).toBe("approved");
    expect(res.body.data.status).toBe("approved");
    expect(res.body.data.baselineId).toBe("base-1");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // Guarded transition: only fires while the review is still in_review.
    expect(mockPrisma.reviewRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "rev-1", status: "in_review" },
      data: expect.objectContaining({ status: "approved" }),
    });
    expect(mockPrisma.requirement.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["req-1"] } },
      data: { reviewStatus: "approved" },
    });
    const baselineArg = mockPrisma.baseline.create.mock.calls[0][0];
    expect(baselineArg.data.projectId).toBe("proj-1");
    expect(baselineArg.data.reviewRequestId).toBe("rev-1");
    expect(baselineArg.data.createdById).toBe("user-rev-2");
    expect(baselineArg.data.items.create).toEqual([{ requirementId: "req-1", version: 2 }]);
    // Sign-off evidence commits INSIDE the decision transaction — never
    // fire-and-forget (M1: a lost audit row is an integrity defect).
    const rows = auditRows();
    expect(rows).toContainEqual(
      expect.objectContaining({ action: "review.decision", actorId: "user-rev-2", inTx: true }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        action: "review.approved",
        inTx: true,
        metadata: expect.objectContaining({ baselineId: "base-1" }),
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ action: "baseline.create", targetId: "base-1", inTx: true }),
    );
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("two distinct reviewers race (all-policy): the in-transaction re-read sees the other reviewer's committed approval", async () => {
    // H1 regression: BOTH requests read a stale snapshot where the OTHER
    // assignment is still pending. Without the in-transaction re-read both
    // would compute aggregate=pending and the review would be stuck forever.
    testUser.userId = "user-rev-2";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        assignments: [makeAssignment(), makeAssignment({ id: "asg-2", reviewerId: "user-rev-2" })],
      }),
    );
    // Fresh in-transaction rows: reviewer 1's approval has committed meanwhile.
    primeFreshAssignments("approved", "approved");
    mockPrisma.baseline.create.mockResolvedValue({ id: "base-race" });

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.data.aggregate).toBe("approved");
    expect(res.body.data.status).toBe("approved");
    expect(res.body.data.baselineId).toBe("base-race");
    // The aggregate must come from rows re-read INSIDE the transaction.
    expect(mockPrisma.reviewerAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { reviewRequestId: "rev-1" } }),
    );
  });

  it("409s and creates no baseline when the final transition loses to a concurrent state change", async () => {
    // H1 regression: quorum(1)/2 double-approve or a concurrent withdraw —
    // the loser's guarded status write matches 0 rows and must roll back.
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        policy: "quorum",
        quorum: 1,
        assignments: [makeAssignment(), makeAssignment({ id: "asg-2", reviewerId: "user-rev-2" })],
      }),
    );
    primeFreshAssignments("approved", "pending");
    mockPrisma.reviewRequest.updateMany.mockResolvedValue({ count: 0 }); // lost the race

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REVIEW_STATE_CHANGED");
    expect(mockPrisma.baseline.create).not.toHaveBeenCalled();
    expect(mockPrisma.requirement.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("approves a docs-only review with baselineId null (documents are not baseline-pinnable)", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        items: [makeItem({ requirementId: null, generatedDocumentId: "doc-1" })],
      }),
    );
    primeFreshAssignments("approved");

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");
    expect(res.body.data.baselineId).toBeNull();
    expect(mockPrisma.baseline.create).not.toHaveBeenCalled();
    // The audit row records WHY there is no baseline.
    expect(auditRows()).toContainEqual(
      expect.objectContaining({
        action: "review.approved",
        metadata: expect.objectContaining({ baselineId: null }),
      }),
    );
  });

  it("a rejection under the all-policy flips the review to rejected (no baseline)", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(makeReview());
    primeFreshAssignments("rejected");

    const res = await request(app)
      .post("/reviews/rev-1/decision")
      .send({ decision: "rejected", note: "Missing NFRs" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("rejected");
    expect(mockPrisma.requirement.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["req-1"] } },
      data: { reviewStatus: "rejected" },
    });
    expect(mockPrisma.baseline.create).not.toHaveBeenCalled();
    expect(auditRows()).toContainEqual(
      expect.objectContaining({ action: "review.rejected", inTx: true }),
    );
  });

  it("quorum(1 of 2): a single approval approves the review immediately", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        policy: "quorum",
        quorum: 1,
        assignments: [makeAssignment(), makeAssignment({ id: "asg-2", reviewerId: "user-rev-2" })],
      }),
    );
    primeFreshAssignments("approved", "pending");
    mockPrisma.baseline.create.mockResolvedValue({ id: "base-1" });

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");
  });

  it("quorum(2 of 3): a lone rejection leaves the review in_review", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        policy: "quorum",
        quorum: 2,
        assignments: [
          makeAssignment(),
          makeAssignment({ id: "asg-2", reviewerId: "user-rev-2" }),
          makeAssignment({ id: "asg-3", reviewerId: "user-rev-3" }),
        ],
      }),
    );
    primeFreshAssignments("rejected", "pending", "pending");

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "rejected" });

    expect(res.status).toBe(200);
    expect(res.body.data.aggregate).toBe("pending");
    expect(res.body.data.status).toBe("in_review");
    expect(mockPrisma.reviewRequest.updateMany).not.toHaveBeenCalled();
  });

  it("quorum(2 of 3): a second rejection makes approval impossible → rejected", async () => {
    testUser.userId = "user-rev-2";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        policy: "quorum",
        quorum: 2,
        assignments: [
          makeAssignment({ decision: "rejected", decidedAt: new Date() }),
          makeAssignment({ id: "asg-2", reviewerId: "user-rev-2" }),
          makeAssignment({ id: "asg-3", reviewerId: "user-rev-3" }),
        ],
      }),
    );
    primeFreshAssignments("rejected", "rejected", "pending");

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "rejected" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("rejected");
  });

  it("403s a user who is not an assigned reviewer", async () => {
    testUser.userId = "user-stranger";
    testUser.role = "developer";
    primeDecision(makeReview());

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_A_REVIEWER");
  });

  it("gives a non-reviewer the same 403 on a non-in_review review (no status leak)", async () => {
    // L1: the assignment check runs BEFORE the status check, so a review.decide
    // holder probing arbitrary ids cannot learn a review's current status.
    testUser.userId = "user-stranger";
    testUser.role = "developer";
    primeDecision(makeReview({ status: "approved" }));

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_A_REVIEWER");
  });

  it("403s the requester even if somehow assigned (self-approval prevention)", async () => {
    testUser.userId = "user-req";
    primeDecision(
      makeReview({
        assignments: [makeAssignment({ reviewerId: "user-req" })],
      }),
    );

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SELF_APPROVAL_FORBIDDEN");
    expect(mockPrisma.reviewerAssignment.updateMany).not.toHaveBeenCalled();
  });

  it("409s a double decision", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(
      makeReview({
        assignments: [makeAssignment({ decision: "approved", decidedAt: new Date() })],
      }),
    );

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "rejected" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DECISION_ALREADY_RECORDED");
  });

  it("409s when a concurrent decision won the race (updateMany count 0)", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(makeReview());
    mockPrisma.reviewerAssignment.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DECISION_ALREADY_RECORDED");
  });

  it("409s when the review is not in_review", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    primeDecision(makeReview({ status: "draft" }));

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REVIEW_NOT_IN_REVIEW");
  });

  it("400s an invalid decision value", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "maybe" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("403s a reader (RBAC: review.decide)", async () => {
    testUser.role = "reader";

    const res = await request(app).post("/reviews/rev-1/decision").send({ decision: "approved" });

    expect(res.status).toBe(403);
  });
});

// ---- Withdraw / close --------------------------------------------------------

describe("POST /reviews/:reviewId/withdraw", () => {
  it("lets the requester withdraw an in_review review back to draft", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());

    const res = await request(app).post("/reviews/rev-1/withdraw").send({});

    expect(res.status).toBe(200);
    // Guarded write: a review that concurrently left in_review is not stomped.
    expect(mockPrisma.reviewRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "rev-1", status: "in_review" },
      data: expect.objectContaining({ status: "draft", decidedAt: null }),
    });
    expect(mockPrisma.requirement.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["req-1"] } },
      data: { reviewStatus: "draft" },
    });
    expect(auditRows()).toContainEqual(
      expect.objectContaining({ action: "review.withdraw", inTx: true }),
    );
  });

  it("409s when the withdraw loses to a concurrent final decision (guarded write)", async () => {
    // H1(c) regression: a decision that finalized between our read and our
    // write must NOT be silently overwritten back to draft (and vice versa).
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    mockPrisma.reviewRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post("/reviews/rev-1/withdraw").send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REVIEW_STATE_CHANGED");
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("403s a non-requester without review.admin", async () => {
    testUser.userId = "user-other";
    testUser.role = "developer";
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());

    const res = await request(app).post("/reviews/rev-1/withdraw").send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_REQUESTER");
  });

  it("allows a coordinator (review.admin) to withdraw another user's review", async () => {
    testUser.userId = "user-other";
    testUser.role = "coordinator";
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());

    const res = await request(app).post("/reviews/rev-1/withdraw").send({});

    expect(res.status).toBe(200);
  });

  it("409s when withdrawing from draft", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "draft" }));

    const res = await request(app).post("/reviews/rev-1/withdraw").send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ILLEGAL_REVIEW_TRANSITION");
  });
});

describe("POST /reviews/:reviewId/close", () => {
  it("closes a review without touching requirement reviewStatus", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "approved" }));

    const res = await request(app).post("/reviews/rev-1/close").send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.reviewRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "rev-1", status: "approved" },
      data: expect.objectContaining({ status: "closed" }),
    });
    expect(mockPrisma.requirement.updateMany).not.toHaveBeenCalled();
    expect(auditRows()).toContainEqual(
      expect.objectContaining({ action: "review.close", inTx: true }),
    );
  });

  it("403s a stranger without review.admin", async () => {
    testUser.userId = "user-other";
    testUser.role = "developer";
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());

    const res = await request(app).post("/reviews/rev-1/close").send({});

    expect(res.status).toBe(403);
  });

  it("409s when the review is already closed", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "closed" }));

    const res = await request(app).post("/reviews/rev-1/close").send({});

    expect(res.status).toBe(409);
  });
});

// ---- Queues / detail ----------------------------------------------------------

describe("GET /reviews", () => {
  it("filters the reviewer queue with assignee=me&status=in_review", async () => {
    testUser.userId = "user-rev-1";
    testUser.role = "developer";
    mockPrisma.reviewRequest.findMany.mockResolvedValue([makeReview()]);
    mockPrisma.reviewRequest.count.mockResolvedValue(1);

    const res = await request(app).get("/reviews?assignee=me&status=in_review");

    expect(res.status).toBe(200);
    expect(res.body.data.reviews).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
    const where = mockPrisma.reviewRequest.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("in_review");
    expect(where.assignments).toEqual({ some: { reviewerId: "user-rev-1" } });
  });

  it("filters by requester=me", async () => {
    mockPrisma.reviewRequest.findMany.mockResolvedValue([]);
    mockPrisma.reviewRequest.count.mockResolvedValue(0);

    const res = await request(app).get("/reviews?requester=me");

    expect(res.status).toBe(200);
    const where = mockPrisma.reviewRequest.findMany.mock.calls[0][0].where;
    expect(where.requestedById).toBe("user-req");
  });

  it("400s an unknown status filter", async () => {
    const res = await request(app).get("/reviews?status=bogus");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /reviews/:reviewId", () => {
  it("returns detail with items, assignments, and the audit history", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    mockPrisma.auditLog.findMany.mockResolvedValue([
      { id: "a1", action: "review.create", actorId: "user-req", ts: new Date(), metadata: null },
    ]);

    const res = await request(app).get("/reviews/rev-1");

    expect(res.status).toBe(200);
    expect(res.body.data.review.id).toBe("rev-1");
    expect(res.body.data.history).toHaveLength(1);
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { targetType: "review_request", targetId: "rev-1" },
      }),
    );
  });

  it("404s an unknown review", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(null);

    const res = await request(app).get("/reviews/nope");

    expect(res.status).toBe(404);
  });
});

describe("GET /projects/:projectId/reviews", () => {
  it("lists reviews scoped to the project", async () => {
    mockPrisma.reviewRequest.findMany.mockResolvedValue([makeReview()]);
    mockPrisma.reviewRequest.count.mockResolvedValue(1);

    const res = await request(app).get("/projects/proj-1/reviews");

    expect(res.status).toBe(200);
    const where = mockPrisma.reviewRequest.findMany.mock.calls[0][0].where;
    expect(where.projectId).toBe("proj-1");
  });
});
