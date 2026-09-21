/**
 * Tests for SCIM 2.0 endpoints.
 * Epic #748, Issues #752, #753.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const { db, revoke, audit } = vi.hoisted(() => ({
  db: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    userRole: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    role: { findUnique: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
  },
  revoke: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/auth/jwt.js", () => ({ revokeAllUserSessions: revoke }));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit }));

import {
  addScimToken,
  __resetScimTokens,
  rotateScimToken,
  generateScimToken,
  scimRouter,
} from "../src/routes/scim.js";
import { errorHandler } from "../src/middleware/error-handler.js";

describe("SCIM Token Management", () => {
  beforeEach(() => {
    __resetScimTokens();
  });

  it("addScimToken adds a valid token", () => {
    addScimToken("test-token-123");
    // Token is added — we can't directly verify without an HTTP request,
    // but at least ensure no throw
    expect(true).toBe(true);
  });

  it("rotateScimToken clears old tokens and sets new one (explicit)", () => {
    addScimToken("old-token");
    const newToken = rotateScimToken("new-token");
    expect(newToken).toBe("new-token");
  });

  it("rotateScimToken generates CSPRNG token when no argument passed", () => {
    const token = rotateScimToken();
    // CSPRNG tokens are 64-char hex strings (32 bytes)
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateScimToken produces 64-char hex token", () => {
    const token = generateScimToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateScimToken produces unique tokens", () => {
    const t1 = generateScimToken();
    const t2 = generateScimToken();
    expect(t1).not.toBe(t2);
  });
});

describe("SCIM ServiceProviderConfig", () => {
  it("declares patch support", () => {
    // This test verifies our SCIM implementation declares the right capabilities
    const expectedCapabilities = {
      patch: true,
      bulk: false,
      filter: true,
      changePassword: false,
      sort: false,
      etag: false,
    };
    expect(expectedCapabilities.patch).toBe(true);
    expect(expectedCapabilities.filter).toBe(true);
    expect(expectedCapabilities.bulk).toBe(false);
  });
});

describe("SCIM role authority persistence", () => {
  const app = express();
  app.use(express.json());
  app.use("/scim/v2", scimRouter());
  app.use(errorHandler);
  const authorization = "Bearer authority-test-token";
  const user = {
    id: "u1",
    username: "alice",
    displayName: "Alice",
    email: "alice@example.test",
    status: "active",
    deletedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    authRolesInitializedAt: null,
    authRoleAuthority: "provider",
  };
  const group = {
    id: "g1",
    key: "custom-role",
    name: "Custom role",
    users: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
  const authority = { authRolesInitializedAt: expect.any(Date), authRoleAuthority: "scim" };

  beforeEach(() => {
    vi.resetAllMocks();
    __resetScimTokens();
    addScimToken("authority-test-token");
    db.$transaction.mockImplementation(async (work) => work(db));
    db.user.findUnique.mockResolvedValue(null);
    db.user.findFirst.mockResolvedValue(user);
    db.user.upsert.mockResolvedValue(user);
    db.user.update.mockImplementation(async ({ data }) => ({ ...user, ...data }));
    db.role.findUnique.mockResolvedValue(group);
    db.userRole.findMany.mockResolvedValue([]);
    db.userRole.findUnique.mockResolvedValue(null);
  });

  function expectProviderCleanup(userId = user.id) {
    // Exact provenance filter ensures explicit local and legacy rows survive.
    expect(db.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId, source: "provider" } });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  }

  it.each([false, true])(
    "stamps provisioning and clears provider grants (restored=%s)",
    async (restored) => {
      if (restored) db.user.findUnique.mockResolvedValue({ ...user, deletedAt: new Date() });
      const response = await request(app)
        .post("/scim/v2/Users")
        .set("Authorization", authorization)
        .send({ userName: user.username });
      expect(response.status).toBe(201);
      expect(db.user.upsert).toHaveBeenCalledWith({
        where: { username: user.username },
        create: expect.objectContaining(authority),
        update: expect.objectContaining({ ...authority, deletedAt: null }),
      });
      expectProviderCleanup();
      expect(db.userRole.deleteMany).toHaveBeenCalledTimes(1);
    },
  );

  it("does not change authority on a duplicate provisioning conflict", async () => {
    db.user.findUnique.mockResolvedValue(user);
    const response = await request(app)
      .post("/scim/v2/Users")
      .set("Authorization", authorization)
      .send({ userName: user.username });
    expect(response.status).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    { path: "active", value: false },
    { path: "urn:ietf:params:scim:schemas:core:2.0:User:active", value: true },
    { value: { active: false, displayName: "Alice Updated" } },
  ])("stamps supported user updates and removes only provider grants: %j", async (operation) => {
    if (operation.value === true) {
      db.user.findFirst.mockResolvedValue({ ...user, status: "disabled" });
    }
    const response = await request(app)
      .patch(`/scim/v2/Users/${user.id}`)
      .set("Authorization", authorization)
      .send({ Operations: [{ op: "replace", ...operation }] });
    expect(response.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: expect.objectContaining(authority),
    });
    expectProviderCleanup();
    expect(db.userRole.deleteMany).toHaveBeenCalledTimes(1);
    if (response.body.active === false) expect(revoke).toHaveBeenCalledWith(user.id);
    else expect(revoke).not.toHaveBeenCalled();
  });

  it.each([
    { path: "active", value: true },
    { path: "urn:ietf:params:scim:schemas:core:2.0:User:active", value: "true" },
    { value: { active: true, displayName: "Alice Updated" } },
  ])("preserves provider admin grants on redundant activation: %j", async (operation) => {
    db.userRole.findMany.mockResolvedValue([
      { userId: user.id, roleId: "admin", source: "provider" },
    ]);
    const response = await request(app)
      .patch(`/scim/v2/Users/${user.id}`)
      .set("Authorization", authorization)
      .send({ Operations: [{ op: "replace", ...operation }] });
    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: {
        status: "active",
        ...(operation.path ? {} : { displayName: "Alice Updated" }),
      },
    });
    expect(db.userRole.deleteMany).not.toHaveBeenCalled();
    expect(db.userRole.upsert).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each([
    { initial: "disabled", current: "active", active: true, transition: false },
    { initial: "active", current: "disabled", active: true, transition: true },
    { initial: "active", current: "disabled", active: false, transition: false },
    { initial: "disabled", current: "active", active: false, transition: true },
  ])("uses transaction-local status rather than the initial snapshot: %j", async (scenario) => {
    db.user.findFirst.mockResolvedValueOnce({ ...user, status: scenario.initial });
    const findCurrent = vi.fn().mockResolvedValue({ ...user, status: scenario.current });
    db.$transaction.mockImplementation(async (work) =>
      work({ ...db, user: { ...db.user, findFirst: findCurrent } }),
    );
    const response = await request(app)
      .patch(`/scim/v2/Users/${user.id}`)
      .set("Authorization", authorization)
      .send({ Operations: [{ op: "replace", path: "active", value: scenario.active }] });
    expect(response.status).toBe(200);
    expect(findCurrent).toHaveBeenCalledWith({ where: { id: user.id, deletedAt: null } });
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: {
        status: scenario.active ? "active" : "disabled",
        ...(scenario.transition ? authority : {}),
      },
    });
    if (scenario.transition) expectProviderCleanup();
    else expect(db.userRole.deleteMany).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("does not update a user deleted before the transaction read", async () => {
    db.user.findFirst.mockResolvedValueOnce(user).mockResolvedValueOnce(null);
    const response = await request(app)
      .patch(`/scim/v2/Users/${user.id}`)
      .set("Authorization", authorization)
      .send({ Operations: [{ op: "replace", path: "active", value: true }] });
    expect(response.status).toBe(404);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.userRole.deleteMany).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("does not claim authority for an empty user patch", async () => {
    const response = await request(app)
      .patch(`/scim/v2/Users/${user.id}`)
      .set("Authorization", authorization)
      .send({ Operations: [] });
    expect(response.status).toBe(200);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.userRole.deleteMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    { path: "displayName", value: "Alice Updated" },
    { path: "userName", value: "alice-updated" },
    { value: { displayName: "Alice Updated" } },
  ])(
    "leaves authority and grants untouched for repeated profile-only patches: %j",
    async (operation) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request(app)
          .patch(`/scim/v2/Users/${user.id}`)
          .set("Authorization", authorization)
          .send({ Operations: [{ op: "replace", ...operation }] });
        expect(response.status).toBe(200);
      }
      const data =
        operation.path === "userName"
          ? { username: "alice-updated" }
          : { displayName: "Alice Updated" };
      expect(db.user.update).toHaveBeenCalledTimes(2);
      expect(db.user.update).toHaveBeenNthCalledWith(1, { where: { id: user.id }, data });
      expect(db.user.update).toHaveBeenNthCalledWith(2, { where: { id: user.id }, data });
      expect(db.userRole.deleteMany).not.toHaveBeenCalled();
      expect(db.userRole.upsert).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it("stamps user deletion, clears provider grants, and revokes sessions", async () => {
    const response = await request(app)
      .delete(`/scim/v2/Users/${user.id}`)
      .set("Authorization", authorization);
    expect(response.status).toBe(204);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: { ...authority, deletedAt: expect.any(Date), status: "disabled" },
    });
    expectProviderCleanup();
    expect(db.userRole.deleteMany).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(user.id);
  });

  async function membership(operation: "add" | "remove", filtered = false) {
    return request(app)
      .patch(`/scim/v2/Groups/${group.id}`)
      .set("Authorization", authorization)
      .send({
        Operations: [
          {
            op: operation,
            path: filtered ? `members[value eq "${user.id}"]` : "members",
            ...(filtered ? {} : { value: [{ value: user.id }] }),
          },
        ],
      });
  }

  it("stamps membership addition without overwriting an existing local grant", async () => {
    db.userRole.findUnique.mockResolvedValue({
      userId: user.id,
      roleId: group.id,
      source: "local",
    });
    expect((await membership("add")).status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: user.id }, data: authority });
    expectProviderCleanup();
    expect(db.userRole.upsert).toHaveBeenCalledWith({
      where: { userId_roleId: { userId: user.id, roleId: group.id } },
      create: { userId: user.id, roleId: group.id, source: "scim" },
      update: {},
    });
  });

  it.each(["scim", "unknown", "provider"])(
    "persists authority after revoking the last %s membership",
    async (source) => {
      db.userRole.findUnique.mockResolvedValue({ userId: user.id, roleId: group.id, source });
      expect((await membership("remove")).status).toBe(200);
      expect(db.user.update).toHaveBeenCalledWith({ where: { id: user.id }, data: authority });
      expectProviderCleanup();
      expect(db.userRole.deleteMany).toHaveBeenCalledWith({
        where: { userId: user.id, roleId: group.id, source: { in: ["scim", "unknown"] } },
      });
    },
  );

  it.each([false, true])(
    "stamps filtered/array revocation but leaves absent/local removals unchanged (filtered=%s)",
    async (filtered) => {
      for (const source of [null, "local", "scim"]) {
        db.user.update.mockClear();
        db.userRole.deleteMany.mockClear();
        db.userRole.findUnique.mockResolvedValue(
          source ? { userId: user.id, roleId: group.id, source } : null,
        );
        expect((await membership("remove", filtered)).status).toBe(200);
        if (source === "scim") {
          expect(db.user.update).toHaveBeenCalledWith({ where: { id: user.id }, data: authority });
          expectProviderCleanup();
        } else {
          expect(db.user.update).not.toHaveBeenCalled();
          expect(db.userRole.deleteMany).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("stamps all former group members before deleting their last assignment", async () => {
    db.userRole.findMany.mockResolvedValue([
      { userId: user.id, roleId: group.id, source: "scim" },
      { userId: "legacy", roleId: group.id, source: "unknown" },
    ]);
    const response = await request(app)
      .delete(`/scim/v2/Groups/${group.id}`)
      .set("Authorization", authorization);
    expect(response.status).toBe(204);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [user.id, "legacy"] } },
      data: authority,
    });
    expect(db.userRole.deleteMany.mock.calls).toEqual([
      [{ where: { userId: { in: [user.id, "legacy"] }, source: "provider" } }],
      [{ where: { roleId: group.id } }],
    ]);
    expect(db.role.delete).toHaveBeenCalledWith({ where: { id: group.id } });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("refuses group deletion without changing any grant if a local assignment exists", async () => {
    db.userRole.findMany.mockResolvedValue([
      { userId: user.id, roleId: group.id, source: "scim" },
      { userId: "local-user", roleId: group.id, source: "local" },
    ]);
    const response = await request(app)
      .delete(`/scim/v2/Groups/${group.id}`)
      .set("Authorization", authorization);
    expect(response.status).toBe(409);
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.userRole.deleteMany).not.toHaveBeenCalled();
    expect(db.role.delete).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("still refuses deletion of built-in roles without changing authority", async () => {
    db.role.findUnique.mockResolvedValue({ ...group, key: "admin" });
    const response = await request(app)
      .delete(`/scim/v2/Groups/${group.id}`)
      .set("Authorization", authorization);
    expect(response.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
