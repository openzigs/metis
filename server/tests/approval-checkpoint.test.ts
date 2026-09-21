/**
 * Tests for ApprovalCheckpoint (Epic #597 / Issue #626).
 *
 * Uses in-memory Prisma stubs following the pattern from analysis-service.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface ApprovalRequestRow {
  id: string;
  analysisId: string;
  type: string;
  itemId: string;
  status: string;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}

let rows: ApprovalRequestRow[] = [];
let idCounter = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    approvalRequest: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        idCounter++;
        const row: ApprovalRequestRow = {
          id: `approval-${idCounter}`,
          analysisId: data.analysisId as string,
          type: data.type as string,
          itemId: data.itemId as string,
          status: (data.status as string) ?? "pending",
          reviewerId: null,
          reviewNote: null,
          createdAt: new Date(),
          reviewedAt: null,
        };
        rows.push(row);
        return Promise.resolve(row);
      }),
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        let filtered = rows.filter((r) => r.analysisId === where.analysisId);
        if (where.status) filtered = filtered.filter((r) => r.status === where.status);
        return Promise.resolve(filtered);
      }),
      findFirst: vi.fn(({ where }: { where: { id: string; analysisId: string } }) => {
        return Promise.resolve(
          rows.find((r) => r.id === where.id && r.analysisId === where.analysisId) ?? null,
        );
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) return Promise.resolve(null);
        if (data.status !== undefined) row.status = data.status as string;
        if (data.reviewerId !== undefined) row.reviewerId = data.reviewerId as string;
        if (data.reviewNote !== undefined) row.reviewNote = data.reviewNote as string | null;
        if (data.reviewedAt !== undefined) row.reviewedAt = data.reviewedAt as Date;
        return Promise.resolve(row);
      }),
      count: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        let filtered = rows.filter((r) => r.analysisId === where.analysisId);
        if (where.status) filtered = filtered.filter((r) => r.status === where.status);
        return Promise.resolve(filtered.length);
      }),
    },
  },
}));

// Must import AFTER mock setup
const {
  createApprovalRequests,
  listApprovalRequests,
  reviewApprovalRequest,
  areAllApprovalsResolved,
  canCreateTickets,
  DEFAULT_APPROVAL_POLICY,
} = await import("../src/lib/analysis/approval-checkpoint.js");

describe("ApprovalCheckpoint", () => {
  beforeEach(() => {
    rows = [];
    idCounter = 0;
  });

  describe("createApprovalRequests", () => {
    it("creates approval requests for items matching policy", async () => {
      const items = [
        { type: "evidence" as const, itemId: "evidence-1" },
        { type: "requirement" as const, itemId: "req-1" },
      ];

      const created = await createApprovalRequests("analysis-1", items);

      expect(created).toHaveLength(2);
      expect(created[0]!.type).toBe("evidence");
      expect(created[0]!.status).toBe("pending");
      expect(created[1]!.type).toBe("requirement");
    });

    it("filters out items disabled by policy", async () => {
      const items = [
        { type: "evidence" as const, itemId: "evidence-1" },
        { type: "clarification" as const, itemId: "clarify-1" },
        { type: "requirement" as const, itemId: "req-1" },
      ];

      const created = await createApprovalRequests("analysis-1", items, {
        requireEvidenceApproval: false,
        requireClarificationApproval: false,
        requireRequirementApproval: true,
      });

      expect(created).toHaveLength(1);
      expect(created[0]!.type).toBe("requirement");
    });

    it("returns empty when no items match policy", async () => {
      const items = [{ type: "clarification" as const, itemId: "c-1" }];

      const created = await createApprovalRequests("analysis-1", items);
      // Default policy disables clarification approval
      expect(created).toHaveLength(0);
    });

    it("returns empty for empty items array", async () => {
      const created = await createApprovalRequests("analysis-1", []);
      expect(created).toHaveLength(0);
    });
  });

  describe("listApprovalRequests", () => {
    it("lists all approval requests for an analysis", async () => {
      await createApprovalRequests("analysis-1", [
        { type: "evidence" as const, itemId: "e-1" },
        { type: "requirement" as const, itemId: "r-1" },
      ]);

      const list = await listApprovalRequests("analysis-1");
      expect(list).toHaveLength(2);
    });

    it("filters by status", async () => {
      await createApprovalRequests("analysis-1", [
        { type: "evidence" as const, itemId: "e-1" },
        { type: "requirement" as const, itemId: "r-1" },
      ]);

      // Approve one
      await reviewApprovalRequest("analysis-1", "approval-1", {
        status: "approved",
        reviewerId: "user-1",
      });

      const pending = await listApprovalRequests("analysis-1", "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.status).toBe("pending");
    });

    it("returns empty array for unknown analysis", async () => {
      const list = await listApprovalRequests("unknown");
      expect(list).toHaveLength(0);
    });
  });

  describe("reviewApprovalRequest", () => {
    it("approves a pending request", async () => {
      await createApprovalRequests("analysis-1", [{ type: "evidence" as const, itemId: "e-1" }]);

      const reviewed = await reviewApprovalRequest("analysis-1", "approval-1", {
        status: "approved",
        reviewerId: "user-1",
        reviewNote: "Looks good",
      });

      expect(reviewed.status).toBe("approved");
      expect(reviewed.reviewerId).toBe("user-1");
      expect(reviewed.reviewNote).toBe("Looks good");
      expect(reviewed.reviewedAt).toBeInstanceOf(Date);
    });

    it("rejects a pending request", async () => {
      await createApprovalRequests("analysis-1", [{ type: "evidence" as const, itemId: "e-1" }]);

      const reviewed = await reviewApprovalRequest("analysis-1", "approval-1", {
        status: "rejected",
        reviewerId: "user-1",
        reviewNote: "Insufficient evidence",
      });

      expect(reviewed.status).toBe("rejected");
    });

    it("throws when request not found", async () => {
      await expect(
        reviewApprovalRequest("analysis-1", "nonexistent", {
          status: "approved",
          reviewerId: "user-1",
        }),
      ).rejects.toThrow("not found");
    });

    it("throws when analysisId does not match (IDOR prevention)", async () => {
      await createApprovalRequests("analysis-1", [{ type: "evidence" as const, itemId: "e-1" }]);

      await expect(
        reviewApprovalRequest("analysis-other", "approval-1", {
          status: "approved",
          reviewerId: "user-1",
        }),
      ).rejects.toThrow("not found");
    });

    it("throws when request already reviewed", async () => {
      await createApprovalRequests("analysis-1", [{ type: "evidence" as const, itemId: "e-1" }]);

      await reviewApprovalRequest("analysis-1", "approval-1", {
        status: "approved",
        reviewerId: "user-1",
      });

      await expect(
        reviewApprovalRequest("analysis-1", "approval-1", {
          status: "rejected",
          reviewerId: "user-2",
        }),
      ).rejects.toThrow("already approved");
    });
  });

  describe("areAllApprovalsResolved", () => {
    it("returns true when no approvals exist", async () => {
      const result = await areAllApprovalsResolved("analysis-1");
      expect(result).toBe(true);
    });

    it("returns false when pending approvals exist", async () => {
      await createApprovalRequests("analysis-1", [{ type: "evidence" as const, itemId: "e-1" }]);

      const result = await areAllApprovalsResolved("analysis-1");
      expect(result).toBe(false);
    });

    it("returns true when all approvals are resolved", async () => {
      await createApprovalRequests("analysis-1", [{ type: "evidence" as const, itemId: "e-1" }]);

      await reviewApprovalRequest("analysis-1", "approval-1", {
        status: "approved",
        reviewerId: "user-1",
      });

      const result = await areAllApprovalsResolved("analysis-1");
      expect(result).toBe(true);
    });
  });

  describe("canCreateTickets", () => {
    it("allows when no approvals exist", async () => {
      const result = await canCreateTickets("analysis-1");
      expect(result.allowed).toBe(true);
      expect(result.pendingCount).toBe(0);
      expect(result.rejectedCount).toBe(0);
    });

    it("blocks when pending approvals exist", async () => {
      await createApprovalRequests("analysis-1", [{ type: "evidence" as const, itemId: "e-1" }]);

      const result = await canCreateTickets("analysis-1");
      expect(result.allowed).toBe(false);
      expect(result.pendingCount).toBe(1);
    });

    it("blocks when rejected approvals exist", async () => {
      await createApprovalRequests("analysis-1", [{ type: "evidence" as const, itemId: "e-1" }]);

      await reviewApprovalRequest("analysis-1", "approval-1", {
        status: "rejected",
        reviewerId: "user-1",
      });

      const result = await canCreateTickets("analysis-1");
      expect(result.allowed).toBe(false);
      expect(result.rejectedCount).toBe(1);
    });

    it("allows when all approved", async () => {
      await createApprovalRequests("analysis-1", [
        { type: "evidence" as const, itemId: "e-1" },
        { type: "requirement" as const, itemId: "r-1" },
      ]);

      await reviewApprovalRequest("analysis-1", "approval-1", {
        status: "approved",
        reviewerId: "user-1",
      });
      await reviewApprovalRequest("analysis-1", "approval-2", {
        status: "approved",
        reviewerId: "user-1",
      });

      const result = await canCreateTickets("analysis-1");
      expect(result.allowed).toBe(true);
    });
  });

  describe("DEFAULT_APPROVAL_POLICY", () => {
    it("requires evidence approval by default", () => {
      expect(DEFAULT_APPROVAL_POLICY.requireEvidenceApproval).toBe(true);
    });

    it("does not require clarification approval by default", () => {
      expect(DEFAULT_APPROVAL_POLICY.requireClarificationApproval).toBe(false);
    });

    it("requires requirement approval by default", () => {
      expect(DEFAULT_APPROVAL_POLICY.requireRequirementApproval).toBe(true);
    });
  });
});
