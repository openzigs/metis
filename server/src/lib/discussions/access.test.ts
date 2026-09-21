/**
 * Epic #475 (Phase 1, #477) — thread membership / authorization tests.
 *
 * `canAccessThread` is the single source of truth shared by the REST routes and
 * the socket `subscribe:thread` handler. It resolves the thread's `projectId`
 * and delegates to the existing `actorCanAccessProject` project-access guard
 * (member-or-admin), mirroring `server/src/lib/socket/server.ts:134`. Denials are
 * audited by the delegate; soft-deleted / missing threads are treated as
 * NOT FOUND (no project lookup, no membership leak).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hermetic prisma double — only the call shape canAccessThread uses.
const findFirst = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: { discussionThread: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

// Spy on the delegated project-access guard.
const actorCanAccessProject = vi.fn();
const audit = vi.fn();
vi.mock("../scheduler/project-access.js", () => ({
  actorCanAccessProject: (...a: unknown[]) => actorCanAccessProject(...a),
}));
vi.mock("../audit/audit-service.js", () => ({ audit: (...a: unknown[]) => audit(...a) }));

const { canAccessThread, resolveThreadProjectId } = await import("./access.js");

const member = { id: "u-member", role: "member" as const };
const admin = { id: "u-admin", role: "admin" as const };

describe("canAccessThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a member of the thread's project", async () => {
    findFirst.mockResolvedValue({ id: "t1", projectId: "p1" });
    actorCanAccessProject.mockResolvedValue(true);

    const result = await canAccessThread(member, "t1");

    expect(result).toEqual({ ok: true, projectId: "p1" });
    // Soft-deleted threads excluded.
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "t1", deletedAt: null },
      select: { id: true, projectId: true },
    });
    expect(actorCanAccessProject).toHaveBeenCalledWith(
      member,
      "p1",
      expect.objectContaining({ action: "discussion.thread.access" }),
    );
  });

  it("denies a non-member (delegate returns false → forbidden)", async () => {
    findFirst.mockResolvedValue({ id: "t1", projectId: "p1" });
    actorCanAccessProject.mockResolvedValue(false);

    const result = await canAccessThread(member, "t1");

    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("allows an admin (delegate short-circuits to true)", async () => {
    findFirst.mockResolvedValue({ id: "t1", projectId: "p1" });
    actorCanAccessProject.mockResolvedValue(true);

    const result = await canAccessThread(admin, "t1");

    expect(result).toEqual({ ok: true, projectId: "p1" });
  });

  it("treats a missing thread as not found (no project lookup, audited)", async () => {
    findFirst.mockResolvedValue(null);

    const result = await canAccessThread(member, "ghost");

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(actorCanAccessProject).not.toHaveBeenCalled();
    // A not-found probe is audited so it is traceable.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussion.thread.access.denied",
        metadata: expect.objectContaining({ reason: "thread-not-found" }),
      }),
    );
  });

  it("treats a soft-deleted thread as not found (findFirst filters deletedAt)", async () => {
    // The deletedAt:null filter means a soft-deleted row simply does not return.
    findFirst.mockResolvedValue(null);

    const result = await canAccessThread(member, "deleted");

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(actorCanAccessProject).not.toHaveBeenCalled();
  });
});

describe("resolveThreadProjectId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the projectId of a live thread", async () => {
    findFirst.mockResolvedValue({ id: "t1", projectId: "p1" });
    await expect(resolveThreadProjectId("t1")).resolves.toBe("p1");
  });

  it("returns null for a missing / soft-deleted thread", async () => {
    findFirst.mockResolvedValue(null);
    await expect(resolveThreadProjectId("ghost")).resolves.toBeNull();
  });
});
