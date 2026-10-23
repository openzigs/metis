/**
 * Epic #728 / Issue #736 — SLA checker unit tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks -----------------------------------------------------------------

const mockAssignment = {
  findMany: vi.fn(),
  update: vi.fn(),
};

const mockPrisma = {
  assignment: mockAssignment,
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

const mockIoTo = vi.fn().mockReturnValue({ emit: vi.fn() });
const mockIo = { to: mockIoTo };

vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: () => mockIo,
}));

// #1432 — the recipient rule; real-database coverage is in
// requirement-assignee-scope-1432.sqlite.test.ts.
const mockEligible = vi.fn<(userId: string, projectId: string) => Promise<boolean>>();
vi.mock("../src/lib/requirements/assignee-eligibility.js", () => ({
  isEligibleAssignee: (userId: string, projectId: string) => mockEligible(userId, projectId),
}));

const { runSlaCheck } = await import("../src/lib/collaboration/sla-checker.js");

// ---- Helpers ----------------------------------------------------------------

function makeAssignment(overrides: object = {}) {
  return {
    id: "assign-1",
    assigneeId: "user-assignee",
    slaDeadline: new Date(Date.now() - 60_000), // 1 min overdue
    requirement: {
      id: "req-1",
      title: "My Requirement",
      projectId: "proj-1",
      project: { createdById: "user-coordinator" },
    },
    ...overrides,
  };
}

// ---- Tests -----------------------------------------------------------------

describe("runSlaCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssignment.update.mockResolvedValue({});
    mockEligible.mockReset().mockResolvedValue(true);
  });

  it("does nothing when no overdue assignments", async () => {
    mockAssignment.findMany.mockResolvedValue([]);
    await runSlaCheck();
    expect(mockIoTo).not.toHaveBeenCalled();
    expect(mockAssignment.update).not.toHaveBeenCalled();
  });

  it("emits sla:deadline_expired to assignee and coordinator", async () => {
    const assignment = makeAssignment();
    mockAssignment.findMany.mockResolvedValue([assignment]);

    await runSlaCheck();

    // Should emit to both assignee and coordinator rooms.
    expect(mockIoTo).toHaveBeenCalledWith("user:user-assignee");
    expect(mockIoTo).toHaveBeenCalledWith("user:user-coordinator");
  });

  it("does not double-emit when assignee === coordinator", async () => {
    const assignment = makeAssignment({
      assigneeId: "user-A",
      requirement: {
        id: "req-1",
        title: "My Requirement",
        project: { createdById: "user-A" }, // same person
      },
    });
    mockAssignment.findMany.mockResolvedValue([assignment]);

    await runSlaCheck();

    // Should only emit once (to user-A).
    const calls = mockIoTo.mock.calls.filter(([r]) => r === "user:user-A");
    expect(calls).toHaveLength(1);
  });

  it("sets notifiedAt on each processed assignment", async () => {
    mockAssignment.findMany.mockResolvedValue([makeAssignment()]);
    await runSlaCheck();
    expect(mockAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "assign-1" },
        data: expect.objectContaining({ notifiedAt: expect.any(Date) }),
      }),
    );
  });

  it("skips a recipient who can no longer open the project, still marking the row (#1432)", async () => {
    mockEligible.mockImplementation(async (userId: string) => userId !== "user-assignee");
    mockAssignment.findMany.mockResolvedValue([makeAssignment()]);

    await runSlaCheck();

    expect(mockEligible).toHaveBeenCalledWith("user-assignee", "proj-1");
    expect(mockIoTo).not.toHaveBeenCalledWith("user:user-assignee");
    expect(mockIoTo).toHaveBeenCalledWith("user:user-coordinator");
    expect(mockAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "assign-1" } }),
    );
  });

  it("fails closed when the recipient check errors (#1432)", async () => {
    mockEligible.mockRejectedValue(new Error("db down"));
    mockAssignment.findMany.mockResolvedValue([makeAssignment()]);

    await runSlaCheck();

    expect(mockIoTo).not.toHaveBeenCalled();
    expect(mockAssignment.update).toHaveBeenCalled();
  });

  it("continues processing remaining assignments when one fails", async () => {
    const assignments = [
      makeAssignment({ id: "assign-fail" }),
      makeAssignment({ id: "assign-ok" }),
    ];
    mockAssignment.findMany.mockResolvedValue(assignments);
    // First update throws, second succeeds.
    mockAssignment.update.mockRejectedValueOnce(new Error("DB error")).mockResolvedValue({});

    await expect(runSlaCheck()).resolves.toBeUndefined();

    // The second assignment should still be updated.
    expect(mockAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "assign-ok" } }),
    );
  });
});
