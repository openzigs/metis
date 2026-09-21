import { describe, expect, it, vi } from "vitest";
import { withRouteAuth } from "./route-auth-prisma.js";

const fixture = withRouteAuth({
  user: {
    upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
      id: `user_${create.username}`,
      ...create,
    })),
  },
  userRole: {},
  workspaceMember: { findMany: vi.fn(async () => [{ workspaceId: "ws_test" }]) },
});

async function addUser(username = "admin") {
  return fixture.user.upsert({
    create: {
      username,
      status: "active",
      deletedAt: null,
      authRolesInitializedAt: null,
    },
  });
}

describe("route auth Prisma fixture", () => {
  it("starts each case without users or grants", async () => {
    expect(await fixture.user.findFirst({ where: { id: "user_admin" } })).toBeNull();
    expect(await fixture.userRole.findMany({ where: { userId: "user_admin" } })).toEqual([]);
  });

  it("persists initialization across repeated login upserts and keeps users distinct", async () => {
    await addUser();
    const marker = new Date();
    await fixture.user.update({
      where: { id: "user_admin" },
      data: { authRolesInitializedAt: marker },
    });
    expect((await addUser()).authRolesInitializedAt).toEqual(marker);
    expect((await addUser("reader")).authRolesInitializedAt).toBeNull();
    await fixture.user.update({ where: { id: "user_admin" }, data: { status: "disabled" } });
    expect((await addUser()).status).toBe("disabled");
  });

  it("runs interactive transactions against the same data used by relation reads", async () => {
    await addUser();
    await fixture.$transaction(
      async (tx) => {
        const role = await tx.role.findFirst({ where: { key: "admin" } });
        expect(role).toEqual({ id: "role_admin", key: "admin" });
        await tx.userRole.create({
          data: { userId: "user_admin", roleId: role!.id, source: "provider" },
        });
        await tx.user.update({
          where: { id: "user_admin" },
          data: { authRolesInitializedAt: new Date() },
        });
      },
      { isolationLevel: "Serializable" },
    );
    const user = await fixture.user.findFirst({
      where: { id: "user_admin", status: "active", deletedAt: null },
      include: { roles: true, workspaceMemberships: true },
    });
    expect(user).toMatchObject({
      authRolesInitializedAt: expect.any(Date),
      roles: [{ source: "provider", role: { key: "admin" } }],
      workspaceMemberships: [{ workspaceId: "ws_test" }],
    });
    expect(await fixture.userRole.findFirst({ where: { userId: "user_admin" } })).toMatchObject({
      source: "provider",
      role: { key: "admin" },
    });
    expect(await fixture.userRole.findFirst({ where: { userId: "absent" } })).toBeNull();
  });

  it("filters role deletes by user and provenance", async () => {
    for (const data of [
      { userId: "user_admin", roleId: "role_admin", source: "provider" },
      { userId: "user_admin", roleId: "role_reader", source: "scim" },
      { userId: "user_other", roleId: "role_admin", source: "provider" },
    ])
      await fixture.userRole.create({ data });
    expect(
      await fixture.userRole.deleteMany({ where: { userId: "user_admin", source: "provider" } }),
    ).toEqual({ count: 1 });
    expect(await fixture.userRole.findMany({ where: { userId: "user_admin" } })).toMatchObject([
      { source: "scim", role: { key: "reader" } },
    ]);
    expect(await fixture.userRole.findMany({ where: { userId: "user_other" } })).toHaveLength(1);
  });

  it("rolls back grants and markers when a transaction fails", async () => {
    await addUser();
    await expect(
      fixture.$transaction(async (tx) => {
        await tx.userRole.create({
          data: { userId: "user_admin", roleId: "role_admin", source: "provider" },
        });
        await tx.user.update({
          where: { id: "user_admin" },
          data: { authRolesInitializedAt: new Date() },
        });
        throw new Error("transaction aborted");
      }),
    ).rejects.toThrow("transaction aborted");
    expect(await fixture.userRole.findMany({ where: { userId: "user_admin" } })).toEqual([]);
    expect(await fixture.user.findFirst({ where: { id: "user_admin" } })).toMatchObject({
      authRolesInitializedAt: null,
    });
  });

  it("rejects unknown users, roles, and duplicate assignments rather than granting access", async () => {
    expect(await fixture.role.findFirst({ where: { key: "unknown" } })).toBeNull();
    await expect(fixture.user.update({ where: { id: "absent" }, data: {} })).rejects.toThrow(
      "user not found",
    );
    await expect(
      fixture.userRole.create({
        data: { userId: "user_admin", roleId: "absent", source: "local" },
      }),
    ).rejects.toThrow("role not found");
    const data = { userId: "user_admin", roleId: "role_reader", source: "local" };
    await fixture.userRole.create({ data });
    await expect(fixture.userRole.create({ data })).rejects.toThrow("Duplicate");
  });

  it("does not return disabled or deleted users for an active-user lookup", async () => {
    await addUser();
    const query = { where: { id: "user_admin", status: "active", deletedAt: null } };
    await fixture.user.update({ where: { id: "user_admin" }, data: { status: "disabled" } });
    expect(await fixture.user.findFirst(query)).toBeNull();
    await fixture.user.update({
      where: { id: "user_admin" },
      data: { status: "active", deletedAt: new Date() },
    });
    expect(await fixture.user.findFirst(query)).toBeNull();
  });

  it("retains batch transaction results", async () => {
    expect(await fixture.$transaction([Promise.resolve(1), Promise.resolve(2)])).toEqual([1, 2]);
  });
});
