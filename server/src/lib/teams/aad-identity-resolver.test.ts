/**
 * Epic #547 (Phase 1, #549) — AAD → METIS user resolver tests.
 *
 * The security-critical behaviours:
 *   - a MAPPED (tenant, aadObjectId) resolves to its bound METIS user;
 *   - an UNMAPPED sender resolves to null (never silently attributed);
 *   - a CROSS-TENANT aadObjectId (same oid, different tenant) does NOT resolve —
 *     the tenant-scoped key is the isolation boundary;
 *   - a tenant-less / oid-less sender resolves to null;
 *   - a binding to a soft-deleted / disabled user does NOT resolve;
 *   - linkByEmail REUSES the SSO email match (User.email) and is case-insensitive;
 *     a no-match persists NOTHING and reports `no_matching_user`.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  TeamsAadIdentityResolver,
  getTeamsAadIdentityResolver,
  __resetTeamsAadIdentityResolver,
  resolveUserFromAadObjectId,
} from "./aad-identity-resolver.js";

interface UserRow {
  id: string;
  username: string;
  email: string;
  status: string;
  deletedAt: Date | null;
}
interface IdRow {
  id: string;
  workspaceId: string;
  tenantId: string;
  aadObjectId: string;
  userId: string;
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class FakeDb {
  users: UserRow[] = [];
  identities: IdRow[] = [];
  seq = 0;

  /** Workspace memberships (#1431) — a binding may only name a member. */
  members: Array<{ workspaceId: string; userId: string }> = [];
  /** System role assignments (#1431) — `admin` targets need a system-admin caller. */
  roles: Array<{ userId: string; key: string }> = [];

  private activeUser(id: string): UserRow | undefined {
    return this.users.find((u) => u.id === id && u.deletedAt === null && u.status === "active");
  }

  workspaceMember = {
    findFirst: async (args: {
      where: { workspaceId: string; userId: string };
    }): Promise<{ userId: string; user: { id: string; email: string } } | null> => {
      const m = this.members.find(
        (x) => x.workspaceId === args.where.workspaceId && x.userId === args.where.userId,
      );
      const u = m ? this.activeUser(m.userId) : undefined;
      return u ? { userId: u.id, user: { id: u.id, email: u.email } } : null;
    },
    findMany: async (args: {
      where: { workspaceId: string };
    }): Promise<Array<{ user: { id: string; email: string } }>> =>
      this.members
        .filter((x) => x.workspaceId === args.where.workspaceId)
        .map((x) => this.activeUser(x.userId))
        .filter((u): u is UserRow => u !== undefined)
        .map((u) => ({ user: { id: u.id, email: u.email } })),
  };

  userRole = {
    findFirst: async (args: {
      where: { userId: string; role: { key: string } };
    }): Promise<{ userId: string } | null> =>
      this.roles.find((r) => r.userId === args.where.userId && r.key === args.where.role.key) ??
      null,
  };

  private findKey(k: { workspaceId: string; tenantId: string; aadObjectId: string }) {
    return this.identities.find(
      (r) =>
        r.workspaceId === k.workspaceId &&
        r.tenantId === k.tenantId &&
        r.aadObjectId === k.aadObjectId,
    );
  }

  teamsUserIdentity = {
    findUnique: async (args: {
      where: {
        workspaceId_tenantId_aadObjectId: {
          workspaceId: string;
          tenantId: string;
          aadObjectId: string;
        };
      };
      include?: { user: true };
    }): Promise<(IdRow & { user: UserRow | null }) | null> => {
      const row = this.findKey(args.where.workspaceId_tenantId_aadObjectId);
      if (!row) return null;
      const user = this.users.find((u) => u.id === row.userId) ?? null;
      return { ...row, user };
    },
    upsert: async (args: {
      where: {
        workspaceId_tenantId_aadObjectId: {
          workspaceId: string;
          tenantId: string;
          aadObjectId: string;
        };
      };
      create: Omit<IdRow, "id" | "createdAt" | "updatedAt">;
      update: Partial<IdRow>;
    }): Promise<IdRow> => {
      const existing = this.findKey(args.where.workspaceId_tenantId_aadObjectId);
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return existing;
      }
      const row: IdRow = {
        id: `tid_${++this.seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(args.create as Omit<IdRow, "id" | "createdAt" | "updatedAt">),
      };
      this.identities.push(row);
      return row;
    },
    deleteMany: async (args: {
      where: { workspaceId: string; tenantId: string; aadObjectId: string };
    }): Promise<{ count: number }> => {
      const before = this.identities.length;
      const hit = this.findKey(args.where);
      this.identities = this.identities.filter((r) => r !== hit);
      return { count: before - this.identities.length };
    },
  };
}

function makeResolver(): { resolver: TeamsAadIdentityResolver; db: FakeDb } {
  const db = new FakeDb();
  db.users.push({
    id: "u-alice",
    username: "alice",
    email: "alice@corp.com",
    status: "active",
    deletedAt: null,
  });
  db.members.push({ workspaceId: WS, userId: "u-alice" });
  return { resolver: new TeamsAadIdentityResolver(db as unknown as PrismaClient), db };
}

const WS = "ws-1";
const T = "tenant-a";
const OID = "aad-alice";

describe("TeamsAadIdentityResolver (#549)", () => {
  let resolver: TeamsAadIdentityResolver;
  let db: FakeDb;

  beforeEach(() => {
    ({ resolver, db } = makeResolver());
  });

  it("resolves a MAPPED sender to the bound METIS user", async () => {
    const linked = await resolver.linkByEmail({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      email: "alice@corp.com",
    });
    expect(linked).toEqual({ ok: true, userId: "u-alice" });

    const user = await resolver.resolveUserFromAadObjectId(T, OID, WS);
    expect(user).toEqual({ userId: "u-alice", username: "alice", email: "alice@corp.com" });
  });

  it("returns null for an UNMAPPED sender (never silently attributed)", async () => {
    expect(await resolver.resolveUserFromAadObjectId(T, "aad-unknown", WS)).toBeNull();
  });

  it("does NOT resolve a cross-tenant aadObjectId (tenant isolation boundary)", async () => {
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      email: "alice@corp.com",
    });
    // Same oid, DIFFERENT tenant → must not match the binding.
    expect(await resolver.resolveUserFromAadObjectId("tenant-evil", OID, WS)).toBeNull();
  });

  it("returns null when tenantId or aadObjectId is missing", async () => {
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      email: "alice@corp.com",
    });
    expect(await resolver.resolveUserFromAadObjectId(null, OID, WS)).toBeNull();
    expect(await resolver.resolveUserFromAadObjectId("", OID, WS)).toBeNull();
    expect(await resolver.resolveUserFromAadObjectId(T, null, WS)).toBeNull();
    expect(await resolver.resolveUserFromAadObjectId(T, "  ", WS)).toBeNull();
  });

  it("does NOT resolve a binding to a disabled or soft-deleted user", async () => {
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      email: "alice@corp.com",
    });
    db.users[0].status = "disabled";
    expect(await resolver.resolveUserFromAadObjectId(T, OID, WS)).toBeNull();
    db.users[0].status = "active";
    db.users[0].deletedAt = new Date();
    expect(await resolver.resolveUserFromAadObjectId(T, OID, WS)).toBeNull();
  });

  it("linkByEmail reuses the SSO email match and is case-insensitive", async () => {
    const out = await resolver.linkByEmail({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      email: "ALICE@CORP.COM",
    });
    expect(out).toEqual({ ok: true, userId: "u-alice" });
    expect((await resolver.resolveUserFromAadObjectId(T, OID, WS))?.userId).toBe("u-alice");
  });

  it("linkByEmail with NO matching user persists nothing and reports no_matching_user", async () => {
    const out = await resolver.linkByEmail({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      email: "nobody@corp.com",
    });
    expect(out).toEqual({ ok: false, reason: "no_matching_user" });
    expect(db.identities).toHaveLength(0);
    expect(await resolver.resolveUserFromAadObjectId(T, OID, WS)).toBeNull();
  });

  it("linkExplicit binds a known user id and rejects an unknown/disabled one", async () => {
    const ok = await resolver.linkExplicit({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      userId: "u-alice",
    });
    expect(ok).toEqual({ ok: true, userId: "u-alice" });

    const bad = await resolver.linkExplicit({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: "aad-bob",
      userId: "u-ghost",
    });
    expect(bad).toEqual({ ok: false, reason: "no_matching_user" });
  });

  it("re-binding the same (tenant, oid) updates in place (idempotent)", async () => {
    db.users.push({
      id: "u-bob",
      username: "bob",
      email: "bob@corp.com",
      status: "active",
      deletedAt: null,
    });
    db.members.push({ workspaceId: WS, userId: "u-bob" });
    await resolver.linkExplicit({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      userId: "u-alice",
    });
    await resolver.linkExplicit({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      userId: "u-bob",
    });
    expect(db.identities).toHaveLength(1);
    expect((await resolver.resolveUserFromAadObjectId(T, OID, WS))?.userId).toBe("u-bob");
  });

  it("linkByEmail falls back to a case-insensitive scan when the stored email is mixed-case", async () => {
    // Stored email is mixed-case; the exact lowercased findFirst misses, so the
    // CI fallback scan must still bind it.
    db.users.push({
      id: "u-carol",
      username: "carol",
      email: "Carol@Corp.com",
      status: "active",
      deletedAt: null,
    });
    db.members.push({ workspaceId: WS, userId: "u-carol" });
    const out = await resolver.linkByEmail({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: "aad-carol",
      email: "carol@corp.com",
    });
    expect(out).toEqual({ ok: true, userId: "u-carol" });
    expect((await resolver.resolveUserFromAadObjectId(T, "aad-carol", WS))?.userId).toBe("u-carol");
  });

  it("the resolveUserFromAadObjectId free function delegates to the shared singleton", async () => {
    // The convenience free function delegates to the default-Prisma singleton.
    // Spy on the singleton's method so we assert delegation WITHOUT touching a
    // real database (CI runs against a clean DB where the table is unmigrated —
    // see the "Route tests must mock prisma" lesson). The free function must
    // forward both args and return the singleton's result verbatim.
    __resetTeamsAadIdentityResolver();
    const singleton = getTeamsAadIdentityResolver();
    expect(getTeamsAadIdentityResolver()).toBe(singleton);
    const spy = vi
      .spyOn(singleton, "resolveUserFromAadObjectId")
      .mockResolvedValue({ userId: "u-z", username: "z", email: "z@corp.com" });
    const out = await resolveUserFromAadObjectId("tenant-z", "aad-z", "ws-z");
    expect(spy).toHaveBeenCalledWith("tenant-z", "aad-z", "ws-z");
    expect(out).toEqual({ userId: "u-z", username: "z", email: "z@corp.com" });
    spy.mockRestore();
    __resetTeamsAadIdentityResolver();
  });

  it("#1431 — refuses to bind a non-member, by id and by email, persisting nothing", async () => {
    db.users.push({
      id: "u-out",
      username: "out",
      email: "out@corp.com",
      status: "active",
      deletedAt: null,
    });
    db.members.push({ workspaceId: "ws-other", userId: "u-out" });
    const byId = await resolver.linkExplicit({
      workspaceId: WS,
      tenantId: T,
      aadObjectId: OID,
      userId: "u-out",
    });
    const byEmail = await resolver.linkByEmail({
      workspaceId: WS,
      tenantId: T,
      aadObjectId: OID,
      email: "out@corp.com",
    });
    expect(byId).toEqual({ ok: false, reason: "no_matching_user" });
    expect(byEmail).toEqual({ ok: false, reason: "no_matching_user" });
    expect(db.identities).toHaveLength(0);
  });

  it("#1431 — refuses a system-admin member unless the caller is a system admin", async () => {
    db.roles.push({ userId: "u-alice", key: "admin" });
    const params = { workspaceId: WS, tenantId: T, aadObjectId: OID, userId: "u-alice" };
    expect(await resolver.linkExplicit(params)).toEqual({ ok: false, reason: "no_matching_user" });
    expect(await resolver.linkExplicit({ ...params, allowSystemAdminTarget: true })).toEqual({
      ok: true,
      userId: "u-alice",
    });
  });

  it("#1431 — a binding resolves only in its own workspace and only for a current member", async () => {
    await resolver.linkExplicit({
      workspaceId: WS,
      tenantId: T,
      aadObjectId: OID,
      userId: "u-alice",
    });
    expect(await resolver.resolveUserFromAadObjectId(T, OID, "ws-other")).toBeNull();
    expect(await resolver.resolveUserFromAadObjectId(T, OID, "")).toBeNull();

    db.members = [];
    expect(await resolver.resolveUserFromAadObjectId(T, OID, WS)).toBeNull();
  });

  it("#1431 — another workspace's binding of the same identity is never overwritten or unlinked", async () => {
    db.members.push({ workspaceId: "ws-other", userId: "u-alice" });
    await resolver.linkExplicit({
      workspaceId: "ws-other",
      tenantId: T,
      aadObjectId: OID,
      userId: "u-alice",
    });
    await resolver.linkExplicit({
      workspaceId: WS,
      tenantId: T,
      aadObjectId: OID,
      userId: "u-alice",
    });
    expect(db.identities.map((r) => r.workspaceId).sort()).toEqual([WS, "ws-other"]);

    expect(await resolver.unlink(WS, T, OID)).toBe(true);
    expect(db.identities.map((r) => r.workspaceId)).toEqual(["ws-other"]);
  });

  it("unlink removes a binding and is idempotent", async () => {
    await resolver.linkExplicit({
      workspaceId: "ws-1",
      tenantId: T,
      aadObjectId: OID,
      userId: "u-alice",
    });
    expect(await resolver.unlink(WS, T, OID)).toBe(true);
    expect(await resolver.unlink(WS, T, OID)).toBe(false);
    expect(await resolver.resolveUserFromAadObjectId(T, OID, WS)).toBeNull();
  });
});
