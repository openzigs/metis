/**
 * Epic #202 (#214) — DB-durable approval state + restart survival.
 *
 * The `ApprovalRequest` Prisma model is the single durable home for HITL
 * approval state. These tests prove that approval requests and their reviews
 * persist in the backing store and survive a *simulated process restart* — the
 * approval-checkpoint module is re-imported against a fresh module registry,
 * but the same durable row store (standing in for Postgres) is reused. State is
 * therefore read back from the store, never from in-process memory that the old
 * module instance might have cached.
 *
 * The shared `store` is module-scoped (outside `vi.mock`) precisely so it
 * outlives `vi.resetModules()` the way a real database outlives a process.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
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

// Durable backing store — survives module resets (stands in for Postgres).
const store: Row[] = [];
let idCounter = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    approvalRequest: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        idCounter++;
        const row: Row = {
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
        store.push(row);
        return Promise.resolve(row);
      }),
      findMany: vi.fn(
        ({ where, orderBy: _orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
          let filtered = store.filter((r) => r.analysisId === where.analysisId);
          if (where.status) filtered = filtered.filter((r) => r.status === where.status);
          return Promise.resolve(filtered.map((r) => ({ ...r })));
        },
      ),
      findFirst: vi.fn(({ where }: { where: { id: string; analysisId: string } }) =>
        Promise.resolve(
          store.find((r) => r.id === where.id && r.analysisId === where.analysisId) ?? null,
        ),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.find((r) => r.id === where.id);
        if (!row) return Promise.resolve(null);
        if (data.status !== undefined) row.status = data.status as string;
        if (data.reviewerId !== undefined) row.reviewerId = data.reviewerId as string;
        if (data.reviewNote !== undefined) row.reviewNote = data.reviewNote as string | null;
        if (data.reviewedAt !== undefined) row.reviewedAt = data.reviewedAt as Date;
        return Promise.resolve({ ...row });
      }),
      count: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        let filtered = store.filter((r) => r.analysisId === where.analysisId);
        if (where.status) filtered = filtered.filter((r) => r.status === where.status);
        return Promise.resolve(filtered.length);
      }),
    },
  },
}));

/** Freshly import the service module — simulates loading it in a new process. */
async function loadService() {
  vi.resetModules();
  return import("../src/lib/analysis/approval-checkpoint.js");
}

describe("approval state survives restart (#214)", () => {
  beforeEach(() => {
    store.length = 0;
    idCounter = 0;
  });

  it("reads back pending requests created before a restart from the DB, not memory", async () => {
    // ── Process #1: create approval requests.
    const svc1 = await loadService();
    await svc1.createApprovalRequests("analysis-restart", [
      { type: "evidence", itemId: "ev-1" },
      { type: "requirement", itemId: "req-1" },
    ]);

    // ── Process #2: a *fresh* module instance with no in-memory carry-over.
    const svc2 = await loadService();
    const rows = await svc2.listApprovalRequests("analysis-restart");

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.itemId).sort()).toEqual(["ev-1", "req-1"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    // canCreateTickets must reflect the persisted pending rows after restart.
    const status = await svc2.canCreateTickets("analysis-restart");
    expect(status.allowed).toBe(false);
    expect(status.pendingCount).toBe(2);
  });

  it("persists a review across a restart (status/reviewer/note read back from DB)", async () => {
    // ── Process #1: create + approve.
    const svc1 = await loadService();
    await svc1.createApprovalRequests("analysis-review", [{ type: "requirement", itemId: "r-1" }]);
    await svc1.reviewApprovalRequest("analysis-review", "approval-1", {
      status: "approved",
      reviewerId: "reviewer-7",
      reviewNote: "verified durable",
    });

    // ── Process #2: review must be durable.
    const svc2 = await loadService();
    const [row] = await svc2.listApprovalRequests("analysis-review");
    expect(row?.status).toBe("approved");
    expect(row?.reviewerId).toBe("reviewer-7");
    expect(row?.reviewNote).toBe("verified durable");
    expect(row?.reviewedAt).toBeInstanceOf(Date);

    // With the sole approval resolved, promotion is unblocked after restart.
    const status = await svc2.canCreateTickets("analysis-review");
    expect(status.allowed).toBe(true);
  });

  it("can resume an indefinitely-paused approval: pending → (restart) → approve → unblocked", async () => {
    // ── Process #1: create, leave pending (simulates an indefinite pause).
    const svc1 = await loadService();
    await svc1.createApprovalRequests("analysis-resume", [{ type: "requirement", itemId: "r-1" }]);
    expect((await svc1.canCreateTickets("analysis-resume")).allowed).toBe(false);

    // ── Process #2: resume after restart and approve.
    const svc2 = await loadService();
    expect(await svc2.areAllApprovalsResolved("analysis-resume")).toBe(false);
    await svc2.reviewApprovalRequest("analysis-resume", "approval-1", {
      status: "approved",
      reviewerId: "reviewer-1",
    });

    // ── Process #3: the resolution is durable; promotion is now allowed.
    const svc3 = await loadService();
    expect(await svc3.areAllApprovalsResolved("analysis-resume")).toBe(true);
    expect((await svc3.canCreateTickets("analysis-resume")).allowed).toBe(true);
  });
});
