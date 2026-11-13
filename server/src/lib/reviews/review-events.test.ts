/**
 * #1574 — `review:changed` emitter.
 *
 * Who among the reviewers may hear it (#2394) is proven against a real
 * database in `server/tests/review-changed-audience-2394.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn();
const except = vi.fn((_room: string) => ({ emit }));
const to = vi.fn((_rooms: string | string[]) => ({ emit, except }));
let io: { to: typeof to } | null = { to };
vi.mock("../socket/registry.js", () => ({ getSocketServer: () => io }));

const mockPrisma = {
  project: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
};
vi.mock("../prisma.js", () => ({ prisma: mockPrisma }));

const { emitReviewChanged, REVIEWER_LOOKUP_TIMEOUT_MS } = await import("./review-events.js");

beforeEach(() => {
  vi.useRealTimers();
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
    expect(to.mock.calls).toEqual([["project:p1"]]);
    expect(emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emit.mock.calls[0]!;
    expect(name).toBe("review:changed");
    expect(Object.keys(payload).sort()).toEqual(["projectId", "reviewId", "ts"]);
    expect(payload).toMatchObject({ projectId: "p1", reviewId: "rev-1" });
    // No reviewers, no access lookup.
    expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("also reaches each reviewer's own room, except sockets already in the project room (#2370)", async () => {
    // A reviewer off the project's pages is in no project room; their
    // sidebar count must still hear a withdraw, close or settling decision.
    await emitReviewChanged("p1", "rev-1", ["u1", "u2"]);
    expect(to.mock.calls).toEqual([["project:p1"], [["user:u1", "user:u2"]]]);
    // A socket in both the project room and a user room is sent it once.
    expect(except).toHaveBeenCalledWith("project:p1");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![1]).toBe(emit.mock.calls[0]![1]);
    expect(emit.mock.calls[1]![1]).toMatchObject({ projectId: "p1", reviewId: "rev-1" });
  });

  it("sends to the project room before the access lookup settles", async () => {
    // A slow lookup must not delay the open review page.
    let release!: (v: unknown) => void;
    mockPrisma.project.findUnique.mockReturnValue(new Promise((r) => (release = r)));
    mockPrisma.user.findMany.mockResolvedValue([{ id: "u1" }]);
    const pending = emitReviewChanged("p1", "rev-1", ["u1"]);
    expect(to.mock.calls).toEqual([["project:p1"]]);
    expect(emit).toHaveBeenCalledTimes(1);
    release({ workspaceId: "ws1", deletedAt: null, workspace: { deletedAt: null } });
    await pending;
    expect(to.mock.calls).toEqual([["project:p1"], [["user:u1"]]]);
  });

  it("skips the personal rooms when the access lookup hangs past the timeout (#2394)", async () => {
    vi.useFakeTimers();
    mockPrisma.project.findUnique.mockReturnValue(new Promise(() => {}));
    const pending = emitReviewChanged("p1", "rev-1", ["u1"]);
    await vi.advanceTimersByTimeAsync(REVIEWER_LOOKUP_TIMEOUT_MS - 1);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();
    expect(to.mock.calls).toEqual([["project:p1"]]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("leaves out a reviewer who can no longer open the project (#2394)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "u2" }]);
    await emitReviewChanged("p1", "rev-1", ["u1", "u2"]);
    expect(to).toHaveBeenLastCalledWith(["user:u2"]);
    expect(mockPrisma.user.findMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: ["u1", "u2"] }, status: "active", deletedAt: null },
    });
  });

  it("asks for system admins only when the project is unknown (#2394)", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);
    mockPrisma.user.findMany.mockResolvedValue([]);
    await emitReviewChanged("p1", "rev-1", ["u1"]);
    expect(mockPrisma.user.findMany.mock.calls[0]![0].where.AND).toEqual([
      { roles: { some: { role: { key: "admin" } } } },
    ]);
    // Nobody qualifies: no personal-room broadcast at all.
    expect(to.mock.calls).toEqual([["project:p1"]]);
  });

  it("reaches the project room alone when the access lookup fails (#2394)", async () => {
    // Fail closed for the user rooms; the project room's join was already judged.
    mockPrisma.project.findUnique.mockRejectedValue(new Error("db down"));
    await expect(emitReviewChanged("p1", "rev-1", ["u1"])).resolves.toBeUndefined();
    expect(to.mock.calls).toEqual([["project:p1"]]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("does nothing before the socket server is registered", async () => {
    io = null;
    await expect(emitReviewChanged("p1", "rev-1", ["u1"])).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
  });

  it("never throws when the project-room emit fails, and still tries the personal rooms", async () => {
    to.mockImplementationOnce(() => {
      throw new Error("adapter down");
    });
    await expect(emitReviewChanged("p1", "rev-1", ["u1"])).resolves.toBeUndefined();
    expect(to).toHaveBeenLastCalledWith(["user:u1"]);
  });

  it("never throws when the personal-room emit fails", async () => {
    except.mockImplementationOnce(() => {
      throw new Error("adapter down");
    });
    await expect(emitReviewChanged("p1", "rev-1", ["u1"])).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
