import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), update: vi.fn() },
  userRole: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  role: { upsert: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
import {
  reconcileTrustedLoginRole,
  resolveEffectiveRole,
  resolveEffectiveRoleFromRows,
} from "./durable-roles.js";

const initialized = new Date("2026-09-17T00:00:00Z");
const login = { userId: "u1", providerRole: "admin" as const, authRolesInitializedAt: null };
const row = (key: string, source = "provider") => ({ source, role: { key } });

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (fn) => fn(db));
  db.user.findFirst.mockResolvedValue({ authRolesInitializedAt: null });
  db.userRole.findMany.mockResolvedValue([]);
  db.role.upsert.mockImplementation(async ({ where }) => ({ id: `role-${where.key}` }));
});

describe("durable auth provenance", () => {
  it.each(["local", "scim", "unknown", undefined])(
    "uses highest valid explicit role (%s), not provider admin or row order",
    (source) => {
      const roles = [
        row("reader", "scim"),
        { source, role: { key: "coordinator" } },
        row("invalid", "local"),
        row("admin"),
      ];
      expect(resolveEffectiveRoleFromRows(roles)).toEqual({
        role: "coordinator",
        hasExplicitOverride: true,
      });
      expect(resolveEffectiveRoleFromRows(roles.reverse()).role).toBe("coordinator");
    },
  );

  it("fails closed for malformed explicit roles rather than elevating from provider", () => {
    expect(resolveEffectiveRoleFromRows([row("invalid", "local"), row("admin")])).toEqual({
      role: "reader",
      hasExplicitOverride: true,
    });
  });

  it.each([null, initialized])(
    "keeps explicit overrides independent of the caller's marker (%s)",
    async (marker) => {
      db.userRole.findMany.mockResolvedValue([row("coordinator", "scim"), row("admin")]);
      expect(await reconcileTrustedLoginRole({ ...login, authRolesInitializedAt: marker })).toBe(
        "coordinator",
      );
      expect(db.userRole.deleteMany).not.toHaveBeenCalled();
      expect(db.userRole.create).not.toHaveBeenCalled();
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { authRolesInitializedAt: expect.any(Date) },
      });
    },
  );

  it.each([null, initialized])(
    "does not recreate revoked provider admin, even with stale initial marker (%s)",
    async (marker) => {
      // Every other prerequisite for a provider grant is satisfied. The only
      // refusal is the authoritative marker read inside the transaction.
      db.user.findFirst.mockResolvedValue({ authRolesInitializedAt: initialized });
      expect(await reconcileTrustedLoginRole({ ...login, authRolesInitializedAt: marker })).toBe(
        "reader",
      );
      expect(db.userRole.create).not.toHaveBeenCalled();
      expect(db.userRole.deleteMany).not.toHaveBeenCalled();
      expect(db.user.update).not.toHaveBeenCalled();
    },
  );

  it("initializes a first provider grant and records provider provenance", async () => {
    expect(await reconcileTrustedLoginRole(login)).toBe("admin");
    expect(db.userRole.create).toHaveBeenCalledWith({
      data: { userId: "u1", roleId: "role-admin", source: "provider" },
    });
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { authRolesInitializedAt: expect.any(Date) },
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it.each(["scim", "explicit", "revoked"])(
    "blocks provider-only drift at login and live resolution under %s authority",
    async (authRoleAuthority) => {
      for (const marker of [null, initialized]) {
        db.user.findFirst.mockResolvedValue({ authRoleAuthority, authRolesInitializedAt: marker });
        db.userRole.findMany.mockResolvedValue([row("admin")]);
        expect(await reconcileTrustedLoginRole(login)).toBe("reader");
        expect(await resolveEffectiveRole("u1")).toEqual({
          role: "reader",
          hasExplicitOverride: true,
        });
      }
      expect(db.userRole.create).not.toHaveBeenCalled();
      expect(db.userRole.deleteMany).not.toHaveBeenCalled();
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.user.findFirst).toHaveBeenCalledWith({
        where: { id: "u1" },
        select: { authRoleAuthority: true },
      });
    },
  );

  it.each(["scim", "explicit", "revoked"])(
    "preserves the highest explicit grant under %s authority",
    async (authRoleAuthority) => {
      db.user.findFirst.mockResolvedValue({
        authRoleAuthority,
        authRolesInitializedAt: initialized,
      });
      db.userRole.findMany.mockResolvedValue([
        row("admin"),
        row("reader", "scim"),
        row("developer", "unknown"),
        row("coordinator", "local"),
      ]);
      expect(await reconcileTrustedLoginRole(login)).toBe("coordinator");
      expect((await resolveEffectiveRole("u1")).role).toBe("coordinator");
      expect(db.userRole.create).not.toHaveBeenCalled();
      expect(db.userRole.deleteMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["admin", "reader"],
    ["reader", "admin"],
  ] as const)(
    "reconciles provider %s to current %s after initialization",
    async (oldRole, providerRole) => {
      db.user.findFirst.mockResolvedValue({ authRolesInitializedAt: initialized });
      db.userRole.findMany.mockResolvedValue([row(oldRole)]);
      expect(
        await reconcileTrustedLoginRole({
          ...login,
          providerRole,
          authRolesInitializedAt: initialized,
        }),
      ).toBe(providerRole);
      expect(db.userRole.deleteMany).toHaveBeenCalledWith({
        where: { userId: "u1", source: "provider" },
      });
      expect(db.userRole.create).toHaveBeenCalledWith({
        data: { userId: "u1", roleId: `role-${providerRole}`, source: "provider" },
      });
    },
  );

  it("reads concurrent explicit assignments in the transaction, not the login snapshot", async () => {
    const tx = {
      ...db,
      userRole: { ...db.userRole, findMany: vi.fn().mockResolvedValue([row("reader", "scim")]) },
    };
    db.userRole.findMany.mockResolvedValue([row("admin")]);
    db.$transaction.mockImplementation(async (fn) => fn(tx));
    expect(await reconcileTrustedLoginRole(login)).toBe("reader");
    expect(tx.userRole.findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      include: { role: true },
    });
    expect(db.userRole.findMany).not.toHaveBeenCalled();
    expect(db.userRole.create).not.toHaveBeenCalled();
  });

  it("propagates transaction conflicts instead of issuing provider permissions", async () => {
    db.$transaction.mockRejectedValue(
      Object.assign(new Error("write conflict"), { code: "P2034" }),
    );
    await expect(reconcileTrustedLoginRole(login)).rejects.toMatchObject({ code: "P2034" });
  });

  it("does not overwrite a concurrent explicit assignment on unique conflict", async () => {
    db.userRole.create.mockRejectedValue(
      Object.assign(new Error("unique conflict"), { code: "P2002" }),
    );
    await expect(reconcileTrustedLoginRole(login)).rejects.toMatchObject({ code: "P2002" });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("bootstraps the fixed-vocabulary role row so a fresh database can still log in", async () => {
    // Nothing seeds `roles`; a lookup-or-throw here 500s the very first login.
    await expect(reconcileTrustedLoginRole(login)).resolves.toBe("admin");
    expect(db.role.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "admin" },
        update: {},
        create: { key: "admin", name: "admin", isSystem: true },
      }),
    );
    expect(db.userRole.create).toHaveBeenCalledWith({
      data: { userId: "u1", roleId: "role-admin", source: "provider" },
    });
  });

  it("rejects an inactive/deleted user before any grant", async () => {
    db.user.findFirst.mockResolvedValue(null);
    await expect(reconcileTrustedLoginRole(login)).rejects.toThrow("Login user is unavailable");
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: "u1", status: "active", deletedAt: null },
      select: { authRolesInitializedAt: true, authRoleAuthority: true },
    });
    expect(db.userRole.create).not.toHaveBeenCalled();
  });

  it("uses the same canonical resolution for live auth", async () => {
    db.userRole.findMany.mockResolvedValue([
      row("reader", "scim"),
      row("coordinator", "local"),
      row("admin"),
    ]);
    expect(await resolveEffectiveRole("u1")).toEqual({
      role: "coordinator",
      hasExplicitOverride: true,
    });
  });
});
