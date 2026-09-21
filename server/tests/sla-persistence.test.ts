/**
 * Issue #416 — runSlaCheck persistence tests.
 *
 * Verifies that Notification rows are persisted for assignee and coordinator
 * alongside the socket emits, and that persistence failures do NOT break the flow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmit = vi.fn();
const mockIoTo = vi.fn().mockReturnValue({ emit: mockEmit });
const mockIo = { to: mockIoTo };

const mockPrisma = {
  assignment: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  notification: {
    create: vi.fn(),
  },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: () => mockIo,
}));

const { runSlaCheck } = await import("../src/lib/collaboration/sla-checker.js");

function makeAssignment(overrides: object = {}) {
  return {
    id: "assign-1",
    assigneeId: "user-assignee",
    slaDeadline: new Date(Date.now() - 60_000),
    requirement: {
      id: "req-1",
      title: "My Requirement",
      project: { createdById: "user-coordinator" },
    },
    ...overrides,
  };
}

describe("runSlaCheck — Issue #416 persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.assignment.update.mockResolvedValue({});
    mockPrisma.notification.create.mockResolvedValue({ id: "n-new" });
  });

  it("persists a Notification for the assignee", async () => {
    mockPrisma.assignment.findMany.mockResolvedValue([makeAssignment()]);

    await runSlaCheck();

    const calls = mockPrisma.notification.create.mock.calls.map((c) => c[0].data);
    const assigneeNotif = calls.find((d) => d.userId === "user-assignee");
    expect(assigneeNotif).toBeDefined();
    expect(assigneeNotif?.type).toBe("sla_deadline");
    expect(assigneeNotif?.title).toContain("My Requirement");
  });

  it("persists a Notification for the coordinator when different from assignee", async () => {
    mockPrisma.assignment.findMany.mockResolvedValue([makeAssignment()]);

    await runSlaCheck();

    const calls = mockPrisma.notification.create.mock.calls.map((c) => c[0].data);
    const coordNotif = calls.find((d) => d.userId === "user-coordinator");
    expect(coordNotif).toBeDefined();
    expect(coordNotif?.type).toBe("sla_deadline");
  });

  it("does NOT persist a coordinator notification when assignee === coordinator", async () => {
    mockPrisma.assignment.findMany.mockResolvedValue([
      makeAssignment({
        assigneeId: "user-A",
        requirement: {
          id: "req-1",
          title: "My Requirement",
          project: { createdById: "user-A" },
        },
      }),
    ]);

    await runSlaCheck();

    const calls = mockPrisma.notification.create.mock.calls.map((c) => c[0].data);
    const userANotifs = calls.filter((d) => d.userId === "user-A");
    // Only one notification per person (the assignee row).
    expect(userANotifs).toHaveLength(1);
  });

  it("persists an href pointing to the requirement", async () => {
    mockPrisma.assignment.findMany.mockResolvedValue([makeAssignment()]);

    await runSlaCheck();

    const calls = mockPrisma.notification.create.mock.calls.map((c) => c[0].data);
    const notif = calls.find((d) => d.userId === "user-assignee");
    expect(notif?.href).toContain("req-1");
  });

  it("still emits socket events even when notification persistence fails", async () => {
    mockPrisma.assignment.findMany.mockResolvedValue([makeAssignment()]);
    mockPrisma.notification.create.mockRejectedValue(new Error("DB unavailable"));

    await expect(runSlaCheck()).resolves.toBeUndefined();

    expect(mockIoTo).toHaveBeenCalledWith("user:user-assignee");
    expect(mockEmit).toHaveBeenCalledWith("sla:deadline_expired", expect.any(Object));
  });

  it("marks assignment notifiedAt even when notification persistence fails", async () => {
    mockPrisma.assignment.findMany.mockResolvedValue([makeAssignment()]);
    mockPrisma.notification.create.mockRejectedValue(new Error("DB unavailable"));

    await runSlaCheck();

    expect(mockPrisma.assignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "assign-1" },
        data: expect.objectContaining({ notifiedAt: expect.any(Date) }),
      }),
    );
  });
});
