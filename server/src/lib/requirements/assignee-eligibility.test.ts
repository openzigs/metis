/**
 * #1432 — the assignee rule's plumbing: blank input, the active-user filter,
 * the admin role passed to the access rule, and `eligibleAssigneeIds` checking
 * each distinct user once, in parallel. The rule's real-database behaviour is
 * pinned in `tests/requirement-assignee-scope-1432.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindFirst = vi.fn();
const roleFindFirst = vi.fn();
const canAccess = vi.fn();

vi.mock("../prisma.js", () => ({
  prisma: { user: { findFirst: userFindFirst }, userRole: { findFirst: roleFindFirst } },
}));
vi.mock("../discussions/access.js", () => ({
  canAccessProjectDiscussions: (...args: unknown[]) => canAccess(...args),
}));

const { isEligibleAssignee, eligibleAssigneeIds } = await import("./assignee-eligibility.js");

beforeEach(() => {
  userFindFirst.mockReset().mockImplementation(async ({ where }) => ({ id: where.id }));
  roleFindFirst.mockReset().mockResolvedValue(null);
  canAccess.mockReset().mockResolvedValue(true);
});

describe("isEligibleAssignee", () => {
  it("refuses blank input without a query", async () => {
    expect(await isEligibleAssignee("", "p")).toBe(false);
    expect(await isEligibleAssignee("u", "")).toBe(false);
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("requires an active, non-deleted user", async () => {
    userFindFirst.mockResolvedValue(null);
    expect(await isEligibleAssignee("u", "p")).toBe(false);
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u", deletedAt: null, status: "active" } }),
    );
    expect(canAccess).not.toHaveBeenCalled();
  });

  it("asks the access rule as admin only when the user holds the admin role", async () => {
    await isEligibleAssignee("u", "p");
    expect(canAccess).toHaveBeenLastCalledWith({ id: "u", role: "reader" }, "p");
    roleFindFirst.mockResolvedValue({ userId: "u" });
    await isEligibleAssignee("u", "p");
    expect(canAccess).toHaveBeenLastCalledWith({ id: "u", role: "admin" }, "p");
  });

  it("returns the access rule's answer", async () => {
    canAccess.mockResolvedValue(false);
    expect(await isEligibleAssignee("u", "p")).toBe(false);
  });
});

describe("eligibleAssigneeIds", () => {
  it("checks each distinct user once and keeps only the eligible ones", async () => {
    canAccess.mockImplementation(async (actor: { id: string }) => actor.id !== "b");
    const result = await eligibleAssigneeIds(["a", "b", "a", "c", "b"], "p");
    expect([...result].sort()).toEqual(["a", "c"]);
    expect(userFindFirst.mock.calls.map(([arg]) => arg.where.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("runs the checks in parallel, not one after another", async () => {
    // Every lookup is held until all three have started: a sequential loop
    // would wait on the first forever (and time out).
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((r) => (release = r));
    userFindFirst.mockImplementation(async ({ where }) => {
      started += 1;
      if (started === 3) release();
      await allStarted;
      return { id: where.id };
    });
    const result = await eligibleAssigneeIds(["a", "b", "c"], "p");
    expect(started).toBe(3);
    expect(result.size).toBe(3);
  });

  it("is empty for no users", async () => {
    expect((await eligibleAssigneeIds([], "p")).size).toBe(0);
  });
});
