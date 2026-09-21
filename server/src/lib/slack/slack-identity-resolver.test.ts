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

  user = {
    findFirst: async (args: {
      where: {
        id?: string;
        email?: { equals: string };
        deletedAt?: null;
        status?: string;
      };
      select?: unknown;
    }): Promise<Pick<UserRow, "id" | "email"> | null> => {
      const u = this.users.find(
        (x) =>
          (args.where.id ? x.id === args.where.id : true) &&
          (args.where.email ? x.email === args.where.email.equals : true) &&
          (args.where.deletedAt === null ? x.deletedAt === null : true) &&
          (args.where.status ? x.status === args.where.status : true),
      );
      return u ? { id: u.id, email: u.email } : null;
    },
    findMany: async (): Promise<Pick<UserRow, "id" | "email">[]> => {
      return this.users
        .filter((u) => u.deletedAt === null && u.status === "active")
        .map((u) => ({ id: u.id, email: u.email }));
    },
  };

  slackUserIdentity = {
    findUnique: async (args: {
      where: { slackTeamId_slackUserId: { slackTeamId: string; slackUserId: string } };
      include?: { user?: boolean };
    }): Promise<(BindingRow & { user: UserRow | null }) | null> => {
      const { slackTeamId, slackUserId } = args.where.slackTeamId_slackUserId;
      const b = this.bindings.find(
        (x) => x.slackTeamId === slackTeamId && x.slackUserId === slackUserId,
      );
      if (!b) return null;
      const user = this.users.find((u) => u.id === b.userId) ?? null;
      return { ...b, user };
    },
    upsert: async (args: {
      where: { slackTeamId_slackUserId: { slackTeamId: string; slackUserId: string } };
      create: Omit<BindingRow, "id">;
      update: Partial<BindingRow>;
    }): Promise<BindingRow> => {
      const { slackTeamId, slackUserId } = args.where.slackTeamId_slackUserId;
      const existing = this.bindings.find(
        (x) => x.slackTeamId === slackTeamId && x.slackUserId === slackUserId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: BindingRow = { id: `b_${++this.seq}`, ...args.create };
      this.bindings.push(row);
      return row;
    },
    deleteMany: async (args: {
      where: { slackTeamId: string; slackUserId: string };
    }): Promise<{ count: number }> => {
      const before = this.bindings.length;
      this.bindings = this.bindings.filter(
        (x) =>
          !(x.slackTeamId === args.where.slackTeamId && x.slackUserId === args.where.slackUserId),
      );
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
    const resolved = await resolver.resolveUserFromSlackId("T1", "U1");
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
    expect(await resolver.resolveUserFromSlackId("T1", "U1")).toBeNull();
  });

  it("resolves to null for a team-less or user-less sender", async () => {
    expect(await resolver.resolveUserFromSlackId(null, "U1")).toBeNull();
    expect(await resolver.resolveUserFromSlackId("T1", null)).toBeNull();
    expect(await resolver.resolveUserFromSlackId("", "")).toBeNull();
  });

  it("is team-scoped — the same slackUserId under another team does not resolve", async () => {
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "alice@example.com",
    });
    expect(await resolver.resolveUserFromSlackId("T-OTHER", "U1")).toBeNull();
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
    expect((await resolver.resolveUserFromSlackId("T1", "U1"))?.userId).toBe("u-2");
  });

  it("does not resolve a binding to a soft-deleted/disabled user", async () => {
    await resolver.linkByEmail({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      email: "alice@example.com",
    });
    db.users[0].status = "disabled";
    expect(await resolver.resolveUserFromSlackId("T1", "U1")).toBeNull();
  });

  it("linkExplicit binds to a given active user id", async () => {
    const res = await resolver.linkExplicit({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      userId: "u-1",
    });
    expect(res).toEqual({ ok: true, userId: "u-1" });
    expect((await resolver.resolveUserFromSlackId("T1", "U1"))?.userId).toBe("u-1");
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

  it("unlink removes a binding and is idempotent", async () => {
    await resolver.linkExplicit({
      workspaceId: "ws-1",
      slackTeamId: "T1",
      slackUserId: "U1",
      userId: "u-1",
    });
    expect(await resolver.unlink("T1", "U1")).toBe(true);
    expect(await resolver.unlink("T1", "U1")).toBe(false);
    expect(await resolver.resolveUserFromSlackId("T1", "U1")).toBeNull();
  });
});
