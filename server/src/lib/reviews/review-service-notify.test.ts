/**
 * Epic #609 / Issue #621 — review-service → notification dispatch wiring tests.
 *
 * Asserts the POST-COMMIT contract: `submitReview` / `recordDecision` fire the
 * fire-and-forget notification dispatch ONLY after their guarded transaction
 * has committed — never inside it, and never when it rolls back — so a
 * notification failure can never break (and a rolled-back transition can never
 * leak) a review state change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Prisma double ----------------------------------------------------------
const mockPrisma = {
  requirement: { findMany: vi.fn(), updateMany: vi.fn() },
  generatedDocument: { findMany: vi.fn() },
  generatedDocumentVersion: { findFirst: vi.fn() },
  reviewRequest: { findUnique: vi.fn(), updateMany: vi.fn() },
  reviewRequestItem: { update: vi.fn() },
  reviewerAssignment: { updateMany: vi.fn(), findMany: vi.fn() },
  baseline: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock("../prisma.js", () => ({ prisma: mockPrisma }));

// ---- Notify double ----------------------------------------------------------
const dispatchReviewSubmitted = vi.fn();
const dispatchReviewDecision = vi.fn();
vi.mock("./notify.js", () => ({
  dispatchReviewSubmitted: (...a: unknown[]) => dispatchReviewSubmitted(...a),
  dispatchReviewDecision: (...a: unknown[]) => dispatchReviewDecision(...a),
}));

const { submitReview, recordDecision } = await import("./review-service.js");

// ---- Fixtures ----------------------------------------------------------------

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev-1",
    projectId: "proj-1",
    title: "Sprint 4 sign-off",
    status: "in_review",
    policy: "all",
    quorum: null,
    requestedById: "user-req",
    items: [
      {
        id: "item-1",
        requirementId: "req-1",
        generatedDocumentId: null,
        pinnedVersion: 2,
      },
    ],
    assignments: [
      {
        id: "asg-1",
        reviewerId: "rev-a",
        decision: "pending",
        reviewer: { id: "rev-a", username: "alice", displayName: "Alice Reviewer" },
      },
      {
        id: "asg-2",
        reviewerId: "rev-b",
        decision: "pending",
        reviewer: { id: "rev-b", username: "bob", displayName: null },
      },
    ],
    ...overrides,
  };
}

// True while the `$transaction` callback is running — records, per dispatch
// call, whether it fired inside the (still-uncommitted) transaction.
let inTransaction = false;
const dispatchedInTx: boolean[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  inTransaction = false;
  dispatchedInTx.length = 0;
  dispatchReviewSubmitted.mockImplementation(() => dispatchedInTx.push(inTransaction));
  dispatchReviewDecision.mockImplementation(() => dispatchedInTx.push(inTransaction));

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => {
    inTransaction = true;
    try {
      return await fn(mockPrisma);
    } finally {
      inTransaction = false;
    }
  });
  mockPrisma.requirement.findMany.mockResolvedValue([{ id: "req-1", version: 3 }]);
  mockPrisma.requirement.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.generatedDocument.findMany.mockResolvedValue([]);
  mockPrisma.reviewRequest.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.reviewRequestItem.update.mockResolvedValue({});
  mockPrisma.reviewerAssignment.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

describe("submitReview → dispatchReviewSubmitted", () => {
  it("dispatches to all assigned reviewers AFTER the transaction commits", async () => {
    const review = makeReview({ status: "draft" });
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(review);

    await submitReview("user-req", "rev-1", false);

    expect(dispatchReviewSubmitted).toHaveBeenCalledTimes(1);
    expect(dispatchReviewSubmitted).toHaveBeenCalledWith({
      reviewId: "rev-1",
      projectId: "proj-1",
      title: "Sprint 4 sign-off",
      actorId: "user-req",
      reviewerIds: ["rev-a", "rev-b"],
    });
    expect(dispatchedInTx).toEqual([false]); // post-commit, not inside the tx
  });

  it("does NOT dispatch when the guarded status write loses the race (rollback)", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "draft" }));
    mockPrisma.reviewRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(submitReview("user-req", "rev-1", false)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(dispatchReviewSubmitted).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when the transition itself is illegal", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "approved" }));

    await expect(submitReview("user-req", "rev-1", false)).rejects.toBeTruthy();
    expect(dispatchReviewSubmitted).not.toHaveBeenCalled();
  });
});

describe("recordDecision → dispatchReviewDecision", () => {
  it("dispatches a non-terminal decision (outcome null) after commit", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    // Other reviewer still pending → aggregate stays pending under `all`.
    mockPrisma.reviewerAssignment.findMany.mockResolvedValue([
      { decision: "approved" },
      { decision: "pending" },
    ]);

    await recordDecision("rev-a", "rev-1", "approved", "LGTM");

    expect(dispatchReviewDecision).toHaveBeenCalledTimes(1);
    expect(dispatchReviewDecision).toHaveBeenCalledWith({
      reviewId: "rev-1",
      projectId: "proj-1",
      title: "Sprint 4 sign-off",
      requestedById: "user-req",
      reviewerId: "rev-a",
      reviewerName: "Alice Reviewer",
      decision: "approved",
      outcome: null,
      baselineId: null,
    });
    expect(dispatchedInTx).toEqual([false]);
  });

  it("dispatches the terminal approval with the created baselineId", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    mockPrisma.reviewerAssignment.findMany.mockResolvedValue([
      { decision: "approved" },
      { decision: "approved" },
    ]);
    mockPrisma.baseline.create.mockResolvedValue({ id: "base-9" });

    await recordDecision("rev-a", "rev-1", "approved");

    expect(dispatchReviewDecision).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "approved", baselineId: "base-9" }),
    );
  });

  it("falls back to the username label when the reviewer has no display name", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    mockPrisma.reviewerAssignment.findMany.mockResolvedValue([
      { decision: "pending" },
      { decision: "rejected" },
    ]);

    await recordDecision("rev-b", "rev-1", "rejected");

    expect(dispatchReviewDecision).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerId: "rev-b", reviewerName: "bob", outcome: "rejected" }),
    );
  });

  it("does NOT dispatch when the decision transaction rolls back (double decision)", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    mockPrisma.reviewerAssignment.updateMany.mockResolvedValue({ count: 0 });

    await expect(recordDecision("rev-a", "rev-1", "approved")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(dispatchReviewDecision).not.toHaveBeenCalled();
  });
});
