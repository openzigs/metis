import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import type { RoleKey } from "@metis/shared";

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ prisma: db }));

// Intentionally real: requireAuth, issueTokens, admin wrappers, reconciliation
// service and canonical durable-role resolution. Only persistence is mocked.
import { issueTokens } from "../../lib/auth/jwt.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { authReconciliationRouter } from "./auth-reconciliation.js";

const base = "/api/admin/auth/role-reconciliation";
const instant = new Date("2026-09-18T10:00:00.000Z");
const target = { targetId: "target-1", username: "alice" };
const confirmation = {
  ...target,
  expectedFingerprint: "a".repeat(64),
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  decision: "revoked",
  reason: "Verified account revocation request",
};
interface Account {
  id: string;
  username: string;
  status: string;
  deletedAt: Date | null;
  authRolesInitializedAt: Date | null;
  authRoleAuthority: string;
  updatedAt: Date;
}
interface Assignment {
  userId: string;
  roleId: string;
  role: { key: string };
  source: string;
  assignedAt: Date;
}
const role = (userId: string, key = "admin", source = "local"): Assignment => ({
  userId,
  roleId: `role-${key}`,
  role: { key },
  source,
  assignedAt: instant,
});
let actor: Account | null;
let targetUser: Account | null;
let roles: Assignment[];
const tx = {
  user: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  userRole: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  role: { findUnique: vi.fn() },
  auditLog: { findUnique: vi.fn(), create: vi.fn() },
};

function app(globalJson = false) {
  const instance = express();
  // Reproduce app.ts parser ordering separately from the isolated router fixture.
  if (globalJson) instance.use(express.json({ limit: "1mb" }));
  instance.use(cookieParser());
  instance.use(base, authReconciliationRouter());
  instance.use(errorHandler);
  return instance;
}

function tokens(claim: RoleKey = "admin", userId = "admin-1") {
  return issueTokens({
    userId,
    username: "administrator",
    role: claim,
    permissions: [],
    workspaces: [],
  });
}

function post(endpoint: string, body: unknown, token = tokens().accessToken) {
  return request(app())
    .post(`${base}/${endpoint}`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function expectNoWrites() {
  expect(tx.user.updateMany).not.toHaveBeenCalled();
  expect(tx.userRole.deleteMany).not.toHaveBeenCalled();
  expect(tx.userRole.create).not.toHaveBeenCalled();
  expect(tx.auditLog.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  actor = {
    id: "admin-1",
    username: "administrator",
    status: "active",
    deletedAt: null,
    authRolesInitializedAt: instant,
    authRoleAuthority: "explicit",
    updatedAt: instant,
  };
  targetUser = {
    ...actor,
    id: target.targetId,
    username: target.username,
    authRoleAuthority: "unknown",
  };
  roles = [role(actor.id), role(target.targetId, "admin", "provider")];
  db.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  tx.user.findFirst.mockImplementation(
    async ({ where }: { where: { id: string; status: string; deletedAt: Date | null } }) =>
      actor?.id === where.id && actor.status === where.status && actor.deletedAt === where.deletedAt
        ? actor
        : null,
  );
  tx.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    targetUser?.id === where.id ? { ...targetUser } : null,
  );
  tx.userRole.findMany.mockImplementation(async ({ where }: { where: { userId: string } }) =>
    roles
      .filter((row) => row.userId === where.userId)
      .sort((a, b) => a.roleId.localeCompare(b.roleId)),
  );
  tx.user.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string; username: string; updatedAt: Date };
      data: Pick<Account, "authRoleAuthority" | "authRolesInitializedAt" | "updatedAt">;
    }) => {
      if (
        !targetUser ||
        targetUser.id !== where.id ||
        targetUser.username !== where.username ||
        targetUser.updatedAt.getTime() !== where.updatedAt.getTime()
      )
        return { count: 0 };
      Object.assign(targetUser, data);
      return { count: 1 };
    },
  );
  tx.userRole.deleteMany.mockImplementation(
    async ({ where }: { where: { userId: string; source: string } }) => {
      const before = roles.length;
      roles = roles.filter((row) => row.userId !== where.userId || row.source !== where.source);
      return { count: before - roles.length };
    },
  );
  tx.role.findUnique.mockResolvedValue({ id: "role-reader", key: "reader" });
  tx.userRole.create.mockImplementation(
    async ({ data }: { data: Pick<Assignment, "userId" | "roleId" | "source"> }) => {
      const row = { ...role(data.userId, "reader", data.source), ...data };
      roles.push(row);
      return row;
    },
  );
  tx.auditLog.findUnique.mockResolvedValue(null);
  tx.auditLog.create.mockImplementation(async ({ data }: { data: unknown }) => data);
});

describe("auth reconciliation HTTP authentication and durable authorization", () => {
  for (const endpoint of ["inspect", "confirm"]) {
    const body = endpoint === "inspect" ? target : confirmation;

    it(`${endpoint}: rejects missing credentials before accessing persistence`, async () => {
      const response = await request(app()).post(`${base}/${endpoint}`).send(body);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("BEARER_REQUIRED");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it(`${endpoint}: refuses a valid access cookie without an explicit bearer`, async () => {
      const response = await request(app())
        .post(`${base}/${endpoint}`)
        .set("Cookie", `accessToken=${tokens().accessToken}`)
        .send(body);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("BEARER_REQUIRED");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it.each(["Basic credentials", "bearer token", "Bearer token extra"])(
      `${endpoint}: rejects unsupported authorization syntax %s`,
      async (authorization) => {
        const response = await request(app())
          .post(`${base}/${endpoint}`)
          .set("Authorization", authorization)
          .send(body);
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe("BEARER_REQUIRED");
        expect(db.$transaction).not.toHaveBeenCalled();
      },
    );

    it(`${endpoint}: verifies signatures rather than trusting a bearer-shaped string or a valid fallback cookie`, async () => {
      const response = await request(app())
        .post(`${base}/${endpoint}`)
        .set("Authorization", "Bearer not-a-valid-jwt")
        .set("Cookie", `accessToken=${tokens().accessToken}`)
        .send(body);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("TOKEN_INVALID");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it(`${endpoint}: refuses a real signed refresh token as an access token`, async () => {
      const response = await post(endpoint, body, tokens().refreshToken);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("TOKEN_INVALID");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it.each(["reader", "developer", "coordinator"] as const)(
      `${endpoint}: refuses durable %s regardless of admin JWT claims`,
      async (durableRole) => {
        roles[0] = role("admin-1", durableRole);
        const response = await post(endpoint, body);
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("FORBIDDEN");
        expect(response.body.data).toBeUndefined();
        expect(tx.user.findUnique).not.toHaveBeenCalled();
        expectNoWrites();
      },
    );

    it(`${endpoint}: denies a non-admin JWT with matching non-admin durable state`, async () => {
      roles[0] = role("admin-1", "reader");
      const response = await post(endpoint, body, tokens("reader").accessToken);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
      expectNoWrites();
    });

    it.each(["scim", "explicit", "revoked"])(
      `${endpoint}: rejects provider drift under %s authority`,
      async (authority) => {
        actor!.authRoleAuthority = authority;
        roles[0] = role("admin-1", "admin", "provider");
        const response = await post(endpoint, body);
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("FORBIDDEN");
        expectNoWrites();
      },
    );

    it.each(["roleless", "scim-override", "disabled", "deleted", "missing"])(
      `${endpoint}: rejects stale admin credentials for %s state`,
      async (condition) => {
        const staleToken = tokens().accessToken;
        if (condition === "roleless") roles = roles.filter((row) => row.userId !== "admin-1");
        if (condition === "scim-override") {
          roles[0] = role("admin-1", "admin", "provider");
          roles.push(role("admin-1", "reader", "scim"));
        }
        if (condition === "disabled") actor!.status = "disabled";
        if (condition === "deleted") actor!.deletedAt = instant;
        if (condition === "missing") actor = null;
        const response = await post(endpoint, body, staleToken);
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("FORBIDDEN");
        expect(tx.user.findFirst).toHaveBeenCalledWith({
          where: { id: "admin-1", status: "active", deletedAt: null },
        });
        expect(tx.user.findUnique).not.toHaveBeenCalled();
        expectNoWrites();
      },
    );

    it(`${endpoint}: rejects administrator self-reconciliation`, async () => {
      const response = await post(endpoint, {
        ...body,
        targetId: "admin-1",
        username: "administrator",
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("SELF_APPROVAL");
      expect(tx.user.findUnique).not.toHaveBeenCalled();
      expectNoWrites();
    });

    it.each([
      { actor: { kind: "host-operator", name: "attacker" } },
      { kind: "host-operator" },
      { operator: "attacker" },
      { actorId: "another-admin" },
      { "acknowledge-host-authority": true },
    ])(`${endpoint}: refuses injected host/actor fields %j before dispatch`, async (injection) => {
      const response = await post(endpoint, { ...body, ...injection });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(db.$transaction).not.toHaveBeenCalled();
      expectNoWrites();
    });
  }

  it("permits a durable administrator even with stale reader claims", async () => {
    const response = await post("inspect", target, tokens("reader").accessToken);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        state: { id: target.targetId, username: target.username, authority: "unknown" },
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(db.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expectNoWrites();
  });

  it("ignores host-authority headers and query params rather than enabling host access", async () => {
    roles[0] = role("admin-1", "reader");
    const response = await request(app())
      .post(`${base}/inspect?kind=host-operator&operator=recovery`)
      .set("Authorization", `Bearer ${tokens().accessToken}`)
      .set("X-Host-Operator", "recovery")
      .send(target);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expectNoWrites();
  });
});

describe("auth reconciliation HTTP validation and service results", () => {
  it("inspects then confirms via the real service with durable admin identity in the audit", async () => {
    const token = tokens("reader").accessToken;
    const inspected = await post("inspect", target, token);
    expect(inspected.status).toBe(200);
    const response = await post(
      "confirm",
      { ...confirmation, expectedFingerprint: inspected.body.data.fingerprint },
      token,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        requestId: confirmation.requestId,
        replayed: false,
        state: { id: target.targetId, authority: "revoked", roles: [] },
      },
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: target.targetId, username: target.username, updatedAt: instant },
      data: {
        authRoleAuthority: "revoked",
        authRolesInitializedAt: instant,
        updatedAt: expect.any(Date),
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      actorId: "admin-1",
      targetId: target.targetId,
      resultHash: response.body.data.fingerprint,
    });
    expect(JSON.parse(audit.metadata)).toMatchObject({
      actor: { kind: "admin", id: "admin-1" },
      target: { id: target.targetId, username: target.username },
      decision: "revoked",
      reason: confirmation.reason,
      requestId: confirmation.requestId,
      before: inspected.body.data.state,
      after: response.body.data.state,
    });
  });

  it("rechecks demotion between inspect and confirm instead of relying on the inspected authorization", async () => {
    const token = tokens().accessToken;
    const inspected = await post("inspect", target, token);
    expect(inspected.status).toBe(200);
    roles[0] = role("admin-1", "reader");
    const response = await post(
      "confirm",
      { ...confirmation, expectedFingerprint: inspected.body.data.fingerprint },
      token,
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expectNoWrites();
  });

  it("returns the service's stale-fingerprint conflict without writes", async () => {
    const response = await post("confirm", confirmation);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("RECONCILIATION_CONFLICT");
    expectNoWrites();
  });

  it.each(["missing", "renamed"])("returns the %s target identity error", async (condition) => {
    if (condition === "missing") targetUser = null;
    else targetUser!.username = "someone-else";
    const response = await post("inspect", target);
    expect(response.status).toBe(condition === "missing" ? 404 : 409);
    expect(response.body.error.code).toBe(
      condition === "missing" ? "NOT_FOUND" : "IDENTITY_MISMATCH",
    );
    expectNoWrites();
  });

  it.each([{}, { ...target, targetId: " " }, { ...target, username: "u".repeat(201) }])(
    "rejects malformed inspection %j",
    async (body) => {
      const response = await post("inspect", body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { expectedFingerprint: "A".repeat(64) },
    { requestId: "not-a-uuid" },
    { decision: "admin" },
    { reason: "short" },
    { reason: "r".repeat(1001) },
    { targetId: "t".repeat(201) },
  ])("rejects malformed confirmation fields %j before mutation", async (patch) => {
    const response = await post("confirm", { ...confirmation, ...patch });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(db.$transaction).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("surfaces persistence failure as failure, never a successful reconciliation", async () => {
    db.$transaction.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await post("inspect", target);
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(response.body.data).toBeUndefined();
    expectNoWrites();
  });

  it.each([false, true])(
    "rejects oversized JSON with 413 (upstream JSON parser: %s)",
    async (globalJson) => {
      // Deliberately schema-valid after JSON decoding: raw whitespace exceeds
      // 4KB without an unrelated field/length error hiding a body-limit bypass.
      // Regression expectations, NOT characterization of the current defects:
      // errorHandler must preserve 413, and upstream parsing must not bypass it.
      const raw = `{${" ".repeat(4200)}"targetId":"target-1","username":"alice"}`;
      const response = await request(app(globalJson))
        .post(`${base}/inspect`)
        .set("Authorization", `Bearer ${tokens().accessToken}`)
        .set("Content-Type", "application/json")
        .send(raw);
      expect(response.status).toBe(413);
      expect(response.body.success).toBe(false);
      expect(db.$transaction).not.toHaveBeenCalled();
      expectNoWrites();
    },
  );

  it("accepts a bounded body already decoded by an upstream parser", async () => {
    const response = await request(app(true))
      .post(`${base}/inspect`)
      .set("Authorization", `Bearer ${tokens().accessToken}`)
      .send(target);
    expect(response.status).toBe(200);
    expect(response.body.data.state.id).toBe(target.targetId);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expectNoWrites();
  });

  it.each([false, true])(
    "rejects oversized chunked JSON without Content-Length (upstream parser: %s)",
    async (globalJson) => {
      // With no upstream parser, whitespace keeps the decoded body schema-valid
      // and proves the streaming parser enforces its byte limit. With one, a
      // large decoded body proves the guard still runs after the stream is read.
      const raw = globalJson
        ? JSON.stringify({ ...confirmation, reason: "r".repeat(4200) })
        : `{${" ".repeat(4200)}"targetId":"target-1","username":"alice"}`;
      const pending = request(app(globalJson))
        .post(`${base}/${globalJson ? "confirm" : "inspect"}`)
        .set("Authorization", `Bearer ${tokens().accessToken}`)
        .set("Content-Type", "application/json")
        .set("Transfer-Encoding", "chunked");
      pending.write(raw);
      const response = await pending;
      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: "PAYLOAD_TOO_LARGE" },
      });
      expect(db.$transaction).not.toHaveBeenCalled();
      expectNoWrites();
    },
  );
});
