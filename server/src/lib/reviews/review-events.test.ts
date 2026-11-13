/**
 * #1574 — `review:changed` emitter.
 *
 * Who among the reviewers may hear it (#2394) is proven against a real
 * database in `server/tests/review-changed-audience-2394.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn();
const to = vi.fn((_rooms: string[]) => ({ emit }));
let io: { to: typeof to } | null = { to };
vi.mock("../socket/registry.js", () => ({ getSocketServer: () => io }));

const mockPrisma = {
  project: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
};
vi.mock("../prisma.js", () => ({ prisma: mockPrisma }));

const { emitReviewChanged } = await import("./review-events.js");

beforeEach(() => {
  vi.clearAllMocks();
  io = { to };
  mockPrisma.project.findUnique.mockResolvedValue({
    workspaceId: "ws1",
    deletedAt: null,
    workspace: { deletedAt: null },
  });
  mockPrisma.user.findMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }]);
});

describe("emitReviewChanged", () => {
  it("emits identifiers only to the review's project room", async () => {
    await emitReviewChanged("p1", "rev-1");
    expect(to).toHaveBeenCalledWith(["project:p1"]);
    expect(emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emit.mock.calls[0]!;
    expect(name).toBe("review:changed");
    expect(Object.keys(payload).sort()).toEqual(["projectId", "reviewId", "ts"]);
    expect(payload).toMatchObject({ projectId: "p1", reviewId: "rev-1" });
    // No reviewers, no access lookup.
    expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("also reaches each reviewer's own room, in one broadcast (#2370)", async () => {
    // A reviewer off the project's pages is in no project room; their
    // sidebar count must still hear a withdraw, close or settling decision.
    await emitReviewChanged("p1", "rev-1", ["u1", "u2"]);
    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith(["project:p1", "user:u1", "user:u2"]);
    // One emit over the union of rooms: a socket in several is sent it once.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toMatchObject({ projectId: "p1", reviewId: "rev-1" });
  });

  it("leaves out a reviewer who can no longer open the project (#2394)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "u2" }]);
    await emitReviewChanged("p1", "rev-1", ["u1", "u2"]);
    expect(to).toHaveBeenCalledWith(["project:p1", "user:u2"]);
    expect(mockPrisma.user.findMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: ["u1", "u2"] } },
    });
  });

  it("reaches the project room alone when the access lookup fails (#2394)", async () => {
    // Fail closed for the user rooms; the project room's join was already judged.
    mockPrisma.project.findUnique.mockRejectedValue(new Error("db down"));
    await expect(emitReviewChanged("p1", "rev-1", ["u1"])).resolves.toBeUndefined();
    expect(to).toHaveBeenCalledWith(["project:p1"]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("does nothing before the socket server is registered", async () => {
    io = null;
    await expect(emitReviewChanged("p1", "rev-1", ["u1"])).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
  });

  it("never throws when the emit fails", async () => {
    to.mockImplementationOnce(() => {
      throw new Error("adapter down");
    });
    await expect(emitReviewChanged("p1", "rev-1")).resolves.toBeUndefined();
  });
});
