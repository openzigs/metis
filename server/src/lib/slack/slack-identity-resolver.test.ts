/**
 * Issue #579 — Slack identity resolver tests. Proves the email-match linkage
 * (reusing the SSO key), idempotent re-binding, team-scoped isolation, and that
 * an unmapped/disabled sender resolves to null (never silently attributed).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  SlackIdentityResolver,
  getSlackIdentityResolver,
  __resetSlackIdentityResolver,
} from "./slack-identity-resolver.js";

interface UserRow {
  id: string;
  username: string;
  email: string;
  status: string;
  deletedAt: Date | null;
}

interface BindingRow {
  id: string;
  workspaceId: string;
  slackTeamId: string;
  slackUserId: string;
  userId: string;
  email: string | null;
}

class FakeDb {
  users: UserRow[] = [];
  bindings: BindingRow[] = [];
  private seq = 0;

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

  private findKey(k: { workspaceId: string; slackTeamId: string; slackUserId: string }) {
    return this.bindings.find(
      (x) =>
        x.workspaceId === k.workspaceId &&
        x.slackTeamId === k.slackTeamId &&
        x.slackUserId === k.slackUserId,
    );
  }

  slackUserIdentity = {
    findUnique: async (args: {
      where: {
        workspaceId_slackTeamId_slackUserId: {
          workspaceId: string;
          slackTeamId: string;
          slackUserId: string;
        };
      };
      include?: { user?: boolean };
    }): Promise<(BindingRow & { user: UserRow | null }) | null> => {
      const b = this.findKey(args.where.workspaceId_slackTeamId_slackUserId);
      if (!b) return null;
      const user = this.users.find((u) => u.id === b.userId) ?? null;
      return { ...b, user };
    },
    upsert: async (args: {
      where: {
        workspaceId_slackTeamId_slackUserId: {
          workspaceId: string;
          slackTeamId: string;
          slackUserId: string;
        };
      };
      create: Omit<BindingRow, "id">;
      update: Partial<BindingRow>;
    }): Promise<BindingRow> => {
      const existing = this.findKey(args.where.workspaceId_slackTeamId_slackUserId);
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: BindingRow = { id: `b_${++this.seq}`, ...args.create };
      this.bindings.push(row);
      return row;
    },
    deleteMany: async (args: {
      where: { workspaceId: string; slackTeamId: string; slackUserId: string };
    }): Promise<{ count: number }> => {
      const before = this.bindings.length;
      const hit = this.findKey(args.where);
      this.bindings = this.bindings.filter((x) => x !== hit);
      return { count: before - this.bindings.length };
    },
  };
}

describe("SlackIdentityResolver (#579)", () => {
  let db: FakeDb;
  let resolver: SlackIdentityResolver;

  beforeEach(() => {
    db = new FakeDb();
    db.users.push({
      id: "u-1",
      username: "alice",
      email: "alice@example.com",
      status: "active",
      deletedAt: null,
    });
    // Every user a test creates is a member of ws-1 (the binding workspace).
    for (const userId of ["u-1", "u-2", "u-mixed"]) {
      db.members.push({ workspaceId: "ws-1", userId });
    }
    resolver = new SlackIdentityResolver(db as never);
  });

  it("links a Slack user to a METIS user by matching email (SSO key)", async () => {
    const res = await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "alice@example.com",
    });
    expect(res).toEqual({ ok: true, userId: "u-1" });
    const resolved = await resolver.resolveUserFromSlackId("T1", "U1", "ws-1");
    expect(resolved).toEqual({ userId: "u-1", username: "alice", email: "alice@example.com" });
  });

  it("matches email case-insensitively (Slack profile may differ in case)", async () => {
    const res = await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "ALICE@EXAMPLE.COM",
    });
    expect(res.ok).toBe(true);
  });

  it("returns no_matching_user when the email matches nobody", async () => {
    const res = await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "stranger@example.com",
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_user" });
    expect(await resolver.resolveUserFromSlackId("T1", "U1", "ws-1")).toBeNull();
  });

  it("resolves to null for a team-less or user-less sender", async () => {
    expect(await resolver.resolveUserFromSlackId(null, "U1", "ws-1")).toBeNull();
    expect(await resolver.resolveUserFromSlackId("T1", null, "ws-1")).toBeNull();
    expect(await resolver.resolveUserFromSlackId("", "", "ws-1")).toBeNull();
  });

  it("is team-scoped — the same slackUserId under another team does not resolve", async () => {
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "alice@example.com",
    });
    expect(await resolver.resolveUserFromSlackId("T-OTHER", "U1", "ws-1")).toBeNull();
  });

  it("re-binding the same (team,user) updates in place (idempotent)", async () => {
    db.users.push({
      id: "u-2",
      username: "bob",
      email: "bob@example.com",
      status: "active",
      deletedAt: null,
    });
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "alice@example.com",
    });
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "bob@example.com",
    });
    expect(db.bindings).toHaveLength(1);
    expect((await resolver.resolveUserFromSlackId("T1", "U1", "ws-1"))?.userId).toBe("u-2");
  });

  it("does not resolve a binding to a soft-deleted/disabled user", async () => {
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "alice@example.com",
    });
    db.users[0].status = "disabled";
    expect(await resolver.resolveUserFromSlackId("T1", "U1", "ws-1")).toBeNull();
  });

  it("linkExplicit binds to a given active user id", async () => {
    const res = await resolver.linkExplicit({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      userId: "u-1",
    });
    expect(res).toEqual({ ok: true, userId: "u-1" });
    expect((await resolver.resolveUserFromSlackId("T1", "U1", "ws-1"))?.userId).toBe("u-1");
  });

  it("linkExplicit refuses an unknown/inactive user id", async () => {
    const res = await resolver.linkExplicit({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      userId: "nope",
    });
    expect(res).toEqual({ ok: false, reason: "no_matching_user" });
  });

  it("linkByEmail/linkExplicit reject blank inputs", async () => {
    expect(
      await resolver.linkByEmail({
        workspaceId: "ws",
        slackTeamId: "",
        slackUserId: "U",
        email: "a@b",
      }),
    ).toEqual({ ok: false, reason: "no_matching_user" });
    expect(
      await resolver.linkExplicit({
        workspaceId: "ws",
        slackTeamId: "T",
        slackUserId: "",
        userId: "u-1",
      }),
    ).toEqual({ ok: false, reason: "no_matching_user" });
  });

  it("falls back to a case-insensitive match when the exact-email lookup misses", async () => {
    // Stored email differs ONLY in case, so the exact findFirst misses and the
    // findMany case-insensitive fallback (line 114) resolves it.
    db.users.push({
      id: "u-mixed",
      username: "carol",
      email: "Carol.Smith@Example.com",
      status: "active",
      deletedAt: null,
    });
    const res = await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U-carol",
      email: "carol.smith@example.com",
    });
    expect(res).toEqual({ ok: true, userId: "u-mixed" });
  });

  it("exposes a process-wide singleton via getSlackIdentityResolver", () => {
    __resetSlackIdentityResolver();
    const a = getSlackIdentityResolver();
    const b = getSlackIdentityResolver();
    expect(a).toBe(b);
    __resetSlackIdentityResolver();
    expect(getSlackIdentityResolver()).not.toBe(a);
  });

  it("#1431 — refuses to bind a non-member, by id and by email, persisting nothing", async () => {
    db.users.push({
      id: "u-out",
      username: "out",
      email: "out@example.com",
      status: "active",
      deletedAt: null,
    });
    db.members.push({ workspaceId: "ws-other", userId: "u-out" });
    const base = { workspaceId: "ws-1", slackTeamId: "T1", slackUserId: "U1" };
    expect(await resolver.linkExplicit({ ...base, userId: "u-out" })).toEqual({
      ok: false,
      reason: "no_matching_user",
    });
    expect(await resolver.linkByEmail({ ...base, email: "out@example.com" })).toEqual({
      ok: false,
      reason: "no_matching_user",
    });
    expect(db.bindings).toHaveLength(0);
  });

  it("#1431 — by email, binds the member whose stored email matches the request's case exactly", async () => {
    for (const [id, email] of [
      ["u-dup-low", "dup@example.com"],
      ["u-dup-mixed", "Dup@Example.com"],
    ] as const) {
      db.users.push({ id, username: id, email, status: "active", deletedAt: null });
      db.members.push({ workspaceId: "ws-1", userId: id });
    }
    const base = { workspaceId: "ws-1", slackTeamId: "T1", slackUserId: "U1" };
    expect(await resolver.linkByEmail({ ...base, email: "Dup@Example.com" })).toEqual({
      ok: true,
      userId: "u-dup-mixed",
    });
  });

  it("#1431 — refuses a system-admin member unless the caller is a system admin", async () => {
    db.roles.push({ userId: "u-1", key: "admin" });
    const params = { workspaceId: "ws-1", slackTeamId: "T1", slackUserId: "U1", userId: "u-1" };
    expect((await resolver.linkExplicit(params)).ok).toBe(false);
    expect((await resolver.linkExplicit({ ...params, allowSystemAdminTarget: true })).ok).toBe(
      true,
    );
  });

  it("#1431 — a binding resolves only in its own workspace and only for a current member", async () => {
    await resolver.linkExplicit({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      userId: "u-1",
    });
    expect(await resolver.resolveUserFromSlackId("T1", "U1", "ws-other")).toBeNull();
    expect(await resolver.resolveUserFromSlackId("T1", "U1", "")).toBeNull();
    db.members = [];
    expect(await resolver.resolveUserFromSlackId("T1", "U1", "ws-1")).toBeNull();
  });

  it("#1431 — another workspace's binding is never overwritten or unlinked", async () => {
    db.members.push({ workspaceId: "ws-other", userId: "u-1" });
    for (const workspaceId of ["ws-other", "ws-1"]) {
      await resolver.linkExplicit({
        workspaceId,
        slackTeamId: "T1",
        slackUserId: "U1",
        userId: "u-1",
      });
    }
    expect(db.bindings.map((b) => b.workspaceId).sort()).toEqual(["ws-1", "ws-other"]);
    expect(await resolver.unlink("ws-1", "T1", "U1")).toBe(true);
    expect(db.bindings.map((b) => b.workspaceId)).toEqual(["ws-other"]);
  });

  it("unlink removes a binding and is idempotent", async () => {
    await resolver.linkExplicit({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      userId: "u-1",
    });
    expect(await resolver.unlink("ws-1", "T1", "U1")).toBe(true);
    expect(await resolver.unlink("ws-1", "T1", "U1")).toBe(false);
    expect(await resolver.resolveUserFromSlackId("T1", "U1", "ws-1")).toBeNull();
  });
});
