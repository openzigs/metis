/**
 * #1574 — every review state change tells the review's project room, after the
 * transaction committed, so an open review page re-reads its status and
 * decisions without a reload. A transition that rolled back or was refused
 * tells nobody.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = {
  requirement: { findMany: vi.fn(), updateMany: vi.fn() },
  generatedDocument: { findMany: vi.fn() },
  generatedDocumentVersion: { findFirst: vi.fn() },
  reviewRequest: { findUnique: vi.fn(), updateMany: vi.fn() },
  reviewRequestItem: {
    update: vi.fn(),
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  reviewerAssignment: { updateMany: vi.fn(), findMany: vi.fn() },
  baseline: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock("../prisma.js", () => ({
  prisma: mockPrisma,
  resolveDatabaseProvider: () => "sqlite" as const,
}));
vi.mock("./notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));
const emitReviewChanged = vi.fn();
vi.mock("./review-events.js", () => ({
  emitReviewChanged: (...a: unknown[]) => emitReviewChanged(...a),
}));

const { submitReview, recordDecision, withdrawReview, closeReview } =
  await import("./review-service.js");

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev-1",
    projectId: "proj-1",
    title: "Sprint 4 sign-off",
    status: "in_review",
    policy: "all",
    quorum: null,
    requestedById: "user-req",
    items: [{ id: "item-1", requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 2 }],
    assignments: [
      {
        id: "asg-1",
        reviewerId: "rev-a",
        decision: "pending",
        reviewer: { id: "rev-a", username: "alice", displayName: "Alice Reviewer" },
      },
    ],
    ...overrides,
  };
}

let inTransaction = false;
const emittedInTx: boolean[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  inTransaction = false;
  emittedInTx.length = 0;
  emitReviewChanged.mockImplementation(() => emittedInTx.push(inTransaction));
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
  mockPrisma.reviewerAssignment.findMany.mockResolvedValue([{ decision: "rejected" }]);
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

describe("review state changes reach the project room (#1574)", () => {
  it("submit", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "draft" }));
    await submitReview("user-req", "rev-1", false);
    expect(emitReviewChanged).toHaveBeenCalledWith("proj-1", "rev-1");
    expect(emittedInTx).toEqual([false]);
  });

  it("a decision, including the outcome it reached", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    await recordDecision("rev-a", "rev-1", "rejected", "Change the refresh requirement");
    expect(emitReviewChanged).toHaveBeenCalledWith("proj-1", "rev-1");
    expect(emittedInTx).toEqual([false]);
  });

  it("withdraw", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    await withdrawReview("user-req", "rev-1", false);
    expect(emitReviewChanged).toHaveBeenCalledWith("proj-1", "rev-1");
    expect(emittedInTx).toEqual([false]);
  });

  it("close", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview({ status: "approved" }));
    await closeReview("user-req", "rev-1", false);
    expect(emitReviewChanged).toHaveBeenCalledWith("proj-1", "rev-1");
  });

  it("not a decision whose transaction rolled back", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    mockPrisma.reviewerAssignment.updateMany.mockResolvedValue({ count: 0 });
    await expect(recordDecision("rev-a", "rev-1", "approved")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(emitReviewChanged).not.toHaveBeenCalled();
  });

  it("not a withdraw the server refused", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue(makeReview());
    await expect(withdrawReview("rev-a", "rev-1", false)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(emitReviewChanged).not.toHaveBeenCalled();
  });
});
