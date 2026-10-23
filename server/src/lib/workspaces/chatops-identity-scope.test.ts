/**
 * #1431 — unit tests for the ChatOps identity-binding scope rules. The real-DB
 * proof (route + resolvers + command path) is
 * `server/tests/chatops-identity-workspace-scope-1431.sqlite.test.ts`; these pin
 * the helper's own branches without a database.
 */
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { findBindableWorkspaceUser, isActiveWorkspaceMember } from "./chatops-identity-scope.js";

type User = { id: string; email: string };

function fakeDb(opts: { members?: User[]; admins?: string[] } = {}) {
  const members = opts.members ?? [];
  const admins = new Set(opts.admins ?? []);
  const findFirst = vi.fn(async (args: { where: { workspaceId: string; userId: string } }) => {
    if (args.where.workspaceId !== "ws-1") return null;
    const u = members.find((m) => m.id === args.where.userId);
    return u ? { userId: u.id, user: u } : null;
  });
  const findMany = vi.fn(async (args: { where: { workspaceId: string } }) =>
    args.where.workspaceId === "ws-1" ? members.map((user) => ({ user })) : [],
  );
  const roleFind = vi.fn(async (args: { where: { userId: string; role: { key: string } } }) =>
    args.where.role.key === "admin" && admins.has(args.where.userId)
      ? { userId: args.where.userId }
      : null,
  );
  const db = {
    workspaceMember: { findFirst, findMany },
    userRole: { findFirst: roleFind },
  } as unknown as PrismaClient;
  return { db, findFirst, findMany, roleFind };
}

describe("isActiveWorkspaceMember (#1431)", () => {
  it("is true only for a member of the named workspace", async () => {
    const { db } = fakeDb({ members: [{ id: "u-1", email: "a@x.test" }] });
    expect(await isActiveWorkspaceMember(db, "ws-1", "u-1")).toBe(true);
    expect(await isActiveWorkspaceMember(db, "ws-2", "u-1")).toBe(false);
    expect(await isActiveWorkspaceMember(db, "ws-1", "u-2")).toBe(false);
  });

  it("filters on a live workspace and an active user", async () => {
    const { db, findFirst } = fakeDb();
    await isActiveWorkspaceMember(db, "ws-1", "u-1");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "ws-1",
          userId: "u-1",
          workspace: { deletedAt: null },
          user: { deletedAt: null, status: "active" },
        },
      }),
    );
  });

  it("is false without a workspace or user id, without querying", async () => {
    const { db, findFirst } = fakeDb();
    expect(await isActiveWorkspaceMember(db, "", "u-1")).toBe(false);
    expect(await isActiveWorkspaceMember(db, "ws-1", "")).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("findBindableWorkspaceUser (#1431)", () => {
  const alice = { id: "u-alice", email: "alice@x.test" };

  it("returns a member by id, and null for a non-member", async () => {
    const { db } = fakeDb({ members: [alice] });
    expect(await findBindableWorkspaceUser(db, { workspaceId: "ws-1", userId: "u-alice" })).toEqual(
      alice,
    );
    expect(
      await findBindableWorkspaceUser(db, { workspaceId: "ws-2", userId: "u-alice" }),
    ).toBeNull();
  });

  it("matches email case-insensitively among members only", async () => {
    const { db } = fakeDb({ members: [{ id: "u-c", email: "Carol@X.test" }] });
    expect(
      await findBindableWorkspaceUser(db, { workspaceId: "ws-1", email: " CAROL@x.test " }),
    ).toEqual({ id: "u-c", email: "Carol@X.test" });
    expect(
      await findBindableWorkspaceUser(db, { workspaceId: "ws-2", email: "carol@x.test" }),
    ).toBeNull();
  });

  it("prefers an exact email match and refuses an ambiguous case-only one", async () => {
    const exact = { id: "u-low", email: "dup@x.test" };
    const upper = { id: "u-up", email: "DUP@x.test" };
    const other = { id: "u-mix", email: "Dup@x.test" };
    expect(
      await findBindableWorkspaceUser(fakeDb({ members: [upper, exact] }).db, {
        workspaceId: "ws-1",
        email: "dup@x.test",
      }),
    ).toEqual(exact);
    expect(
      await findBindableWorkspaceUser(fakeDb({ members: [upper, other] }).db, {
        workspaceId: "ws-1",
        email: "dup@x.test",
      }),
    ).toBeNull();
  });

  it("prefers the member whose stored email matches the request's case exactly", async () => {
    const lower = { id: "u-low", email: "dup@x.test" };
    const mixed = { id: "u-mixed", email: "Dup@X.test" };
    const { db } = fakeDb({ members: [lower, mixed] });
    expect(
      await findBindableWorkspaceUser(db, { workspaceId: "ws-1", email: " Dup@X.test " }),
    ).toEqual(mixed);
    expect(
      await findBindableWorkspaceUser(db, { workspaceId: "ws-1", email: "dup@x.test" }),
    ).toEqual(lower);
  });

  it("refuses a system-admin member unless the caller allows it", async () => {
    const { db } = fakeDb({ members: [alice], admins: ["u-alice"] });
    expect(
      await findBindableWorkspaceUser(db, { workspaceId: "ws-1", userId: "u-alice" }),
    ).toBeNull();
    expect(
      await findBindableWorkspaceUser(db, {
        workspaceId: "ws-1",
        userId: "u-alice",
        allowSystemAdminTarget: true,
      }),
    ).toEqual(alice);
  });

  it("returns null for a blank workspace, a blank email or no selector", async () => {
    const { db, findFirst, findMany } = fakeDb({ members: [alice] });
    expect(await findBindableWorkspaceUser(db, { workspaceId: " ", userId: "u-alice" })).toBeNull();
    expect(await findBindableWorkspaceUser(db, { workspaceId: "ws-1", email: "  " })).toBeNull();
    expect(await findBindableWorkspaceUser(db, { workspaceId: "ws-1" })).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
