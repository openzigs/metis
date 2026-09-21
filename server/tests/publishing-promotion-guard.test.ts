/**
 * Issue #257 — defence-in-depth promotion guard at the publishing layer.
 *
 * Publishing must independently reject ticket/artifact creation when the
 * originating analysis still has unresolved (pending) or rejected approvals,
 * even if the upstream orchestrator gate were somehow bypassed. The guard
 * resolves the analysis from the batch's drafts (draft → requirement →
 * analysisId) and re-runs `canCreateTickets`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface DraftRow {
  id: string;
  projectId: string;
  status: string;
  deletedAt: Date | null;
  requirement: { analysisId: string } | null;
}

const drafts = new Map<string, DraftRow>();
// analysisId -> { pending, rejected } approval counts
const approvals = new Map<string, { pending: number; rejected: number }>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    issueDraft: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [...drafts.values()].filter((d) => where.id.in.includes(d.id) && !d.deletedAt),
      ),
    },
    repoConnection: { findFirst: vi.fn(async () => null) },
    // #619 — approval gate off; this file tests the #257 promotion guard.
    project: {
      findUnique: vi.fn(async () => ({ requireApprovedReview: false })),
    },
    publishBatch: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "batch_1",
        startedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      })),
    },
    approvalRequest: {
      count: vi.fn(async ({ where }: { where: { analysisId: string; status: string } }) => {
        const counts = approvals.get(where.analysisId) ?? { pending: 0, rejected: 0 };
        if (where.status === "pending") return counts.pending;
        if (where.status === "rejected") return counts.rejected;
        return 0;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { assertPromotionAllowed, createBatch } =
  await import("../src/lib/publishing/publishing-service.js");

beforeEach(() => {
  drafts.clear();
  approvals.clear();
  vi.clearAllMocks();
});

describe("assertPromotionAllowed (#257)", () => {
  it("is a no-op for the empty set (drafts not traceable to an analysis)", async () => {
    await expect(assertPromotionAllowed([])).resolves.toBeUndefined();
  });

  it("resolves when all analyses have promotion allowed", async () => {
    approvals.set("ana-ok", { pending: 0, rejected: 0 });
    await expect(assertPromotionAllowed(["ana-ok"])).resolves.toBeUndefined();
  });

  it("throws PROMOTION_BLOCKED (409) when an analysis has pending approvals", async () => {
    approvals.set("ana-pending", { pending: 2, rejected: 0 });
    await expect(assertPromotionAllowed(["ana-pending"])).rejects.toMatchObject({
      status: 409,
      code: "PROMOTION_BLOCKED",
    });
  });

  it("throws PROMOTION_BLOCKED when an analysis has rejected approvals", async () => {
    approvals.set("ana-rej", { pending: 0, rejected: 1 });
    await expect(assertPromotionAllowed(["ana-rej"])).rejects.toMatchObject({
      code: "PROMOTION_BLOCKED",
    });
  });
});

describe("createBatch promotion guard (#257)", () => {
  const input = {
    projectId: "proj_1",
    targetOwner: "acme",
    targetRepo: "metis",
    targetBaseUrl: null,
    provider: "github" as const,
    dryRun: false,
    additionalLabels: [],
    milestone: null,
    secretRef: "${vault:gh}",
  };

  it("rejects the batch when a draft's analysis is promotion-blocked", async () => {
    drafts.set("d1", {
      id: "d1",
      projectId: "proj_1",
      status: "approved",
      deletedAt: null,
      requirement: { analysisId: "ana-blocked" },
    });
    approvals.set("ana-blocked", { pending: 1, rejected: 0 });

    await expect(
      createBatch({ actorId: "user_1", input: { ...input, draftIds: ["d1"] } }),
    ).rejects.toMatchObject({ status: 409, code: "PROMOTION_BLOCKED" });
  });

  it("allows the batch when the draft's analysis approvals are resolved", async () => {
    drafts.set("d1", {
      id: "d1",
      projectId: "proj_1",
      status: "approved",
      deletedAt: null,
      requirement: { analysisId: "ana-ok" },
    });
    approvals.set("ana-ok", { pending: 0, rejected: 0 });

    const batch = await createBatch({ actorId: "user_1", input: { ...input, draftIds: ["d1"] } });
    expect(batch.id).toBe("batch_1");
  });

  it("allows the batch when drafts are not traceable to an analysis (upstream gate)", async () => {
    drafts.set("d1", {
      id: "d1",
      projectId: "proj_1",
      status: "approved",
      deletedAt: null,
      requirement: null,
    });
    const batch = await createBatch({ actorId: "user_1", input: { ...input, draftIds: ["d1"] } });
    expect(batch.id).toBe("batch_1");
  });
});
