import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("../prisma.js", () => ({ prisma: db }));

import {
  confirmRolesForAdmin,
  confirmRoleState,
  inspectRolesForAdmin,
  inspectRoleState,
  type ReconciliationActor,
  type ReconciliationInput,
} from "./role-reconciliation.js";

interface User {
  id: string;
  username: string;
  status: string;
  deletedAt: Date | null;
  authRolesInitializedAt: Date | null;
  updatedAt: Date;
  authRoleAuthority: string;
}
interface Assignment {
  userId: string;
  roleId: string;
  source: string;
  assignedAt: Date;
  role: { key: string };
}
interface Audit {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  argsHash: string;
  resultHash: string;
  metadata: string;
}
interface State {
  users: User[];
  roles: Assignment[];
  audits: Audit[];
}

const instant = new Date("2026-09-18T10:00:00.000Z");
const admin = { kind: "admin", id: "admin-1" } as const;
const host = { kind: "host-operator", name: "recovery operator" } as const;
const target = { targetId: "target-1", username: "alice" };
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const assignment = (key: string, source = "provider", userId = target.targetId): Assignment => ({
  userId,
  roleId: `role-${key}`,
  source,
  assignedAt: instant,
  role: { key },
});
const user = (id: string, username: string): User => ({
  id,
  username,
  status: "active",
  deletedAt: null,
  authRolesInitializedAt: null,
  updatedAt: instant,
  authRoleAuthority: "unknown",
});

const tx = {
  user: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  userRole: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  role: { findUnique: vi.fn() },
  auditLog: { findUnique: vi.fn(), create: vi.fn() },
};
let committed: State;
let working: State;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(instant.getTime());
  committed = {
    users: [user(admin.id, "administrator"), user(target.targetId, target.username)],
    roles: [assignment("admin", "local", admin.id), assignment("admin")],
    audits: [],
  };
  // Model only callback commit/abort semantics, not a database or isolation engine.
  // The root client deliberately has NO delegates: all IO must use this tx.
  db.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => {
    working = structuredClone(committed);
    const result = await callback(tx);
    committed = working;
    return result;
  });
  tx.user.findFirst.mockImplementation(
    async ({ where }: { where: Pick<User, "id" | "status" | "deletedAt"> }) =>
      working.users.find(
        (row) =>
          row.id === where.id && row.status === where.status && row.deletedAt === where.deletedAt,
      ) ?? null,
  );
  tx.user.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      working.users.find((row) => row.id === where.id) ?? null,
  );
  tx.userRole.findMany.mockImplementation(
    async ({ where, orderBy }: { where: { userId: string }; orderBy?: { roleId: string } }) => {
      const rows = working.roles.filter((row) => row.userId === where.userId);
      return orderBy ? rows.sort((a, b) => a.roleId.localeCompare(b.roleId)) : rows;
    },
  );
  tx.user.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string; username: string; updatedAt: Date };
      data: Pick<User, "authRoleAuthority" | "authRolesInitializedAt" | "updatedAt">;
    }) => {
      const row = working.users.find(
        (entry) =>
          entry.id === where.id &&
          entry.username === where.username &&
          entry.updatedAt.getTime() === where.updatedAt.getTime(),
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  );
  tx.userRole.deleteMany.mockImplementation(
    async ({ where }: { where: { userId: string; source: string } }) => {
      const before = working.roles.length;
      working.roles = working.roles.filter(
        (row) => row.userId !== where.userId || row.source !== where.source,
      );
      return { count: before - working.roles.length };
    },
  );
  tx.role.findUnique.mockResolvedValue({ id: "role-reader", key: "reader" });
  tx.userRole.create.mockImplementation(
    async ({ data }: { data: Pick<Assignment, "userId" | "roleId" | "source"> }) => {
      const row = { ...assignment("reader"), ...data };
      working.roles.push(row);
      return row;
    },
  );
  tx.auditLog.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      working.audits.find((row) => row.id === where.id) ?? null,
  );
  tx.auditLog.create.mockImplementation(async ({ data }: { data: Audit }) => {
    working.audits.push(data);
    return data;
  });
});

async function inputFor(decision: ReconciliationInput["decision"] = "provider-managed") {
  const before = await inspectRolesForAdmin(admin.id, target);
  return {
    ...target,
    expectedFingerprint: before.fingerprint,
    requestId,
    decision,
    reason: "Verified the account authority with its owner",
  } satisfies ReconciliationInput;
}

function expectNoWrites() {
  expect(tx.user.updateMany).not.toHaveBeenCalled();
  expect(tx.userRole.deleteMany).not.toHaveBeenCalled();
  expect(tx.userRole.create).not.toHaveBeenCalled();
  expect(tx.auditLog.create).not.toHaveBeenCalled();
}

describe("role reconciliation inspection and authorization", () => {
  it("returns a deterministic serialized snapshot, fingerprint and ordered role query without writing", async () => {
    const state = {
      id: target.targetId,
      username: target.username,
      status: "active",
      deletedAt: null,
      initializedAt: null,
      updatedAt: instant.toISOString(),
      authority: "unknown",
      roles: [
        {
          roleId: "role-admin",
          key: "admin",
          source: "provider",
          assignedAt: instant.toISOString(),
        },
      ],
    };
    expect(await inspectRolesForAdmin(admin.id, target)).toEqual({
      state,
      fingerprint: digest(state),
    });
    expect(await inspectRolesForAdmin(admin.id, target)).toEqual({
      state,
      fingerprint: digest(state),
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: { id: admin.id, status: "active", deletedAt: null },
    });
    expect(tx.userRole.findMany).toHaveBeenCalledWith({
      where: { userId: admin.id },
      include: { role: true },
    });
    expect(tx.user.findUnique).toHaveBeenCalledWith({ where: { id: target.targetId } });
    expect(tx.userRole.findMany).toHaveBeenCalledWith({
      where: { userId: target.targetId },
      include: { role: true },
      orderBy: { roleId: "asc" },
    });
    expectNoWrites();
  });

  it.each(["missing", "disabled", "deleted", "roleless", "demoted", "scim-override"])(
    "denies a %s actor before reading the target",
    async (condition) => {
      if (condition === "missing")
        committed.users = committed.users.filter((row) => row.id !== admin.id);
      if (condition === "disabled") committed.users[0].status = "disabled";
      if (condition === "deleted") committed.users[0].deletedAt = instant;
      if (condition === "roleless")
        committed.roles = committed.roles.filter((row) => row.userId !== admin.id);
      if (condition === "demoted") committed.roles[0] = assignment("developer", "local", admin.id);
      if (condition === "scim-override") {
        committed.roles[0] = assignment("admin", "provider", admin.id);
        committed.roles.push(assignment("reader", "scim", admin.id));
      }
      await expect(inspectRolesForAdmin(admin.id, target)).rejects.toMatchObject({
        statusCode: 403,
        code: "FORBIDDEN",
      });
      expect(tx.user.findUnique).not.toHaveBeenCalled();
      expectNoWrites();
    },
  );

  it("denies admin self inspection before revealing state", async () => {
    await expect(
      inspectRolesForAdmin(admin.id, { targetId: admin.id, username: "administrator" }),
    ).rejects.toMatchObject({ statusCode: 403, code: "SELF_APPROVAL" });
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(["missing", "renamed"])(
    "rejects a %s target with an identity-specific error",
    async (condition) => {
      if (condition === "missing") committed.users.pop();
      else committed.users[1].username = "different-account";
      await expect(inspectRolesForAdmin(admin.id, target)).rejects.toMatchObject({
        statusCode: condition === "missing" ? 404 : 409,
        code: condition === "missing" ? "NOT_FOUND" : "IDENTITY_MISMATCH",
      });
      expectNoWrites();
    },
  );

  it("allows a trusted host to inspect without requiring an administrator row", async () => {
    committed.users.shift();
    expect((await inspectRoleState(host, target)).state.id).toBe(target.targetId);
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    expectNoWrites();
  });
});

describe("role reconciliation confirmation", () => {
  it("CAS-updates the observed user, replaces only provider grants with reader and atomically audits exact metadata", async () => {
    const input = await inputFor();
    const before = await inspectRolesForAdmin(admin.id, target);
    const result = await confirmRolesForAdmin(admin.id, input);
    const nextInstant = new Date(instant.getTime() + 1);
    expect(result).toEqual({
      state: {
        ...before.state,
        authority: "provider",
        initializedAt: nextInstant.toISOString(),
        updatedAt: nextInstant.toISOString(),
        roles: [
          {
            roleId: "role-reader",
            key: "reader",
            source: "provider",
            assignedAt: instant.toISOString(),
          },
        ],
      },
      fingerprint: digest(result.state),
      requestId,
      replayed: false,
    });
    expect(result.fingerprint).not.toBe(before.fingerprint);
    expect(tx.user.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: target.targetId, username: target.username, updatedAt: instant },
      data: {
        authRoleAuthority: "provider",
        authRolesInitializedAt: nextInstant,
        updatedAt: nextInstant,
      },
    });
    expect(tx.userRole.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: target.targetId, source: "provider" },
    });
    expect(tx.role.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { key: "reader" } });
    expect(tx.userRole.create).toHaveBeenCalledExactlyOnceWith({
      data: { userId: target.targetId, roleId: "role-reader", source: "provider" },
    });
    expect(tx.auditLog.findUnique).toHaveBeenCalledWith({
      where: { id: `auth-role-reconciliation:${requestId}` },
    });
    expect(tx.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        id: `auth-role-reconciliation:${requestId}`,
        actorId: admin.id,
        action: "admin.auth.role-reconciled",
        targetType: "user",
        targetId: target.targetId,
        argsHash: digest({ actor: admin, input }),
        resultHash: result.fingerprint,
        metadata: JSON.stringify({
          actor: admin,
          target: { id: target.targetId, username: target.username },
          decision: input.decision,
          reason: input.reason,
          requestId,
          before: before.state,
          after: result.state,
        }),
      },
    });
    expect(tx.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.userRole.deleteMany.mock.invocationCallOrder[0],
    );
    expect(tx.userRole.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.auditLog.create.mock.invocationCallOrder[0],
    );
    expect(committed.audits).toHaveLength(1);
    expect(committed.roles.filter((row) => row.userId === admin.id)).toEqual([
      assignment("admin", "local", admin.id),
    ]);
    expect(db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("preserves initialization and uses current time when it is later than updatedAt", async () => {
    const initialized = new Date("2026-01-01T00:00:00.000Z");
    committed.users[1].authRolesInitializedAt = initialized;
    vi.spyOn(Date, "now").mockReturnValue(instant.getTime() + 5000);
    const result = await confirmRolesForAdmin(admin.id, await inputFor("revoked"));
    expect(result.state.initializedAt).toBe(initialized.toISOString());
    expect(result.state.updatedAt).toBe(new Date(instant.getTime() + 5000).toISOString());
    expect(result.state.roles).toEqual([]);
    expect(result.state.authority).toBe("revoked");
  });

  it("advances the CAS timestamp for successive approvals in the same millisecond", async () => {
    const first = await confirmRolesForAdmin(admin.id, await inputFor());
    const second = await confirmRolesForAdmin(admin.id, {
      ...(await inputFor("revoked")),
      requestId: "123e4567-e89b-42d3-a456-426614174001",
    });
    expect(first.state.updatedAt).toBe(new Date(instant.getTime() + 1).toISOString());
    expect(second.state.updatedAt).toBe(new Date(instant.getTime() + 2).toISOString());
    expect(second.state.initializedAt).toBe(first.state.initializedAt);
    expect(tx.user.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: target.targetId,
        username: target.username,
        updatedAt: new Date(first.state.updatedAt),
      },
      data: {
        authRoleAuthority: "revoked",
        authRolesInitializedAt: new Date(first.state.initializedAt!),
        updatedAt: new Date(second.state.updatedAt),
      },
    });
    expect(committed.audits).toHaveLength(2);
    expect(committed.audits[1].resultHash).toBe(second.fingerprint);
  });

  it.each(["unknown", "provider", "revoked"])(
    "permits provider management for roleless %s authority",
    async (authority) => {
      committed.users[1].authRoleAuthority = authority;
      committed.roles = committed.roles.filter((row) => row.userId !== target.targetId);
      const result = await confirmRolesForAdmin(admin.id, await inputFor());
      expect(result.state.authority).toBe("provider");
      expect(result.state.roles).toEqual([
        expect.objectContaining({ key: "reader", source: "provider" }),
      ]);
    },
  );

  it.each(["local", "scim", "unknown", "future-explicit-source"])(
    "refuses provider conversion of %s assignments without mutation",
    async (source) => {
      committed.roles.push(assignment("reader", source));
      await expect(confirmRolesForAdmin(admin.id, await inputFor())).rejects.toMatchObject({
        statusCode: 409,
        code: "EXPLICIT_AUTHORITY",
      });
      expectNoWrites();
    },
  );

  it.each(["scim", "explicit", "future-authority"])(
    "refuses provider conversion of %s authority even with no explicit row",
    async (authority) => {
      committed.users[1].authRoleAuthority = authority;
      await expect(confirmRolesForAdmin(admin.id, await inputFor())).rejects.toMatchObject({
        code: "EXPLICIT_AUTHORITY",
      });
      expectNoWrites();
    },
  );

  it.each([
    ["keep-explicit", "local", "unknown", "explicit"],
    ["revoked", "unknown", "unknown", "revoked"],
    ["revoked", "local", "unknown", "revoked"],
    ["keep-explicit", "scim", "unknown", "scim"],
    ["revoked", "scim", "unknown", "scim"],
    ["revoked", "local", "scim", "scim"],
  ] as const)(
    "%s preserves %s grants with %s authority as %s",
    async (decision, source, authority, expected) => {
      const explicit = assignment("coordinator", source);
      committed.roles.push(explicit);
      committed.users[1].authRoleAuthority = authority;
      const result = await confirmRolesForAdmin(admin.id, await inputFor(decision));
      expect(result.state.authority).toBe(expected);
      expect(committed.roles.filter((row) => row.userId === target.targetId)).toEqual([explicit]);
      expect(tx.userRole.deleteMany).toHaveBeenCalledExactlyOnceWith({
        where: { userId: target.targetId, source: "provider" },
      });
      expect(tx.userRole.create).not.toHaveBeenCalled();
      expect(tx.role.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "deleted"])(
    "allows inspection but not confirmation of a %s target",
    async (condition) => {
      if (condition === "disabled") committed.users[1].status = "disabled";
      else committed.users[1].deletedAt = instant;
      await expect(confirmRolesForAdmin(admin.id, await inputFor())).rejects.toMatchObject({
        statusCode: 409,
        code: "TARGET_UNAVAILABLE",
      });
      expectNoWrites();
    },
  );

  it("rechecks admin authority inside confirmation after inspection", async () => {
    const input = await inputFor();
    committed.roles[0] = assignment("reader", "local", admin.id);
    await expect(confirmRolesForAdmin(admin.id, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expectNoWrites();
  });

  it.each(["missing", "renamed"])(
    "rechecks a %s target between inspection and confirmation",
    async (condition) => {
      const input = await inputFor();
      if (condition === "missing") committed.users.pop();
      else committed.users[1].username = "renamed-account";
      await expect(confirmRolesForAdmin(admin.id, input)).rejects.toMatchObject({
        statusCode: condition === "missing" ? 404 : 409,
        code: condition === "missing" ? "NOT_FOUND" : "IDENTITY_MISMATCH",
      });
      expectNoWrites();
    },
  );

  it("records host provenance without inventing an admin actor ID", async () => {
    const input = await inputFor("revoked");
    await confirmRoleState(host, input);
    expect(committed.audits[0].actorId).toBeNull();
    expect(committed.audits[0].argsHash).toBe(digest({ actor: host, input }));
    expect(JSON.parse(committed.audits[0].metadata).actor).toEqual(host);
  });
});

describe("role reconciliation conflicts, replay and failure", () => {
  it.each(["authority", "updatedAt", "initializedAt", "role-source", "assignedAt", "role-added"])(
    "rejects a changed %s fingerprint before writing",
    async (change) => {
      const input = await inputFor();
      if (change === "authority") committed.users[1].authRoleAuthority = "revoked";
      if (change === "updatedAt") committed.users[1].updatedAt = new Date(instant.getTime() + 1);
      if (change === "initializedAt") committed.users[1].authRolesInitializedAt = instant;
      if (change === "role-source") committed.roles[1].source = "local";
      if (change === "assignedAt") committed.roles[1].assignedAt = new Date(instant.getTime() + 1);
      if (change === "role-added") committed.roles.push(assignment("reader"));
      await expect(confirmRolesForAdmin(admin.id, input)).rejects.toMatchObject({
        statusCode: 409,
        code: "RECONCILIATION_CONFLICT",
      });
      expectNoWrites();
    },
  );

  it.each([0, 2])("requires exactly one CAS update, not count %s", async (count) => {
    const input = await inputFor();
    tx.user.updateMany.mockResolvedValueOnce({ count });
    await expect(confirmRolesForAdmin(admin.id, input)).rejects.toMatchObject({
      code: "RECONCILIATION_CONFLICT",
    });
    expect(tx.userRole.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("replays identical arguments only while the audited result is still current", async () => {
    const input = await inputFor();
    const first = await confirmRolesForAdmin(admin.id, input);
    const saved = structuredClone(committed);
    vi.clearAllMocks();
    expect(await confirmRolesForAdmin(admin.id, input)).toEqual({ ...first, replayed: true });
    expect(committed).toEqual(saved);
    expectNoWrites();
  });

  it.each(["reason", "decision", "fingerprint", "actor", "current-state"])(
    "rejects replay when %s differs",
    async (change) => {
      const input = await inputFor();
      await confirmRolesForAdmin(admin.id, input);
      let actor: ReconciliationActor = admin;
      if (change === "reason") input.reason = "A different approved justification";
      if (change === "decision") input.decision = "revoked";
      if (change === "fingerprint") input.expectedFingerprint = "b".repeat(64);
      if (change === "actor") actor = host;
      if (change === "current-state")
        committed.users[1].updatedAt = new Date(instant.getTime() + 2);
      vi.clearAllMocks();
      await expect(confirmRoleState(actor, input)).rejects.toMatchObject({
        statusCode: 409,
        code: "RECONCILIATION_CONFLICT",
      });
      expectNoWrites();
    },
  );

  it("rechecks authorization even for an otherwise valid replay", async () => {
    const input = await inputFor();
    await confirmRolesForAdmin(admin.id, input);
    committed.users[0].status = "disabled";
    vi.clearAllMocks();
    await expect(confirmRolesForAdmin(admin.id, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(tx.auditLog.findUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("rejects a missing reader after CAS without committing changes or audit", async () => {
    const input = await inputFor();
    const saved = structuredClone(committed);
    tx.role.findUnique.mockResolvedValueOnce(null);
    await expect(confirmRolesForAdmin(admin.id, input)).rejects.toMatchObject({
      statusCode: 409,
      code: "ROLE_UNAVAILABLE",
    });
    expect(tx.user.updateMany).toHaveBeenCalledOnce();
    expect(tx.userRole.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(committed).toEqual(saved);
  });

  it.each(["audit-read", "CAS", "delete", "create", "after-snapshot", "audit-write"])(
    "propagates %s failure out of the transaction instead of reporting success",
    async (step) => {
      const input = await inputFor();
      const saved = structuredClone(committed);
      const failure = Object.assign(new Error(`${step} failed`), { code: "P2034" });
      if (step === "audit-read") tx.auditLog.findUnique.mockRejectedValueOnce(failure);
      if (step === "CAS") tx.user.updateMany.mockRejectedValueOnce(failure);
      if (step === "delete") tx.userRole.deleteMany.mockRejectedValueOnce(failure);
      if (step === "create") tx.userRole.create.mockRejectedValueOnce(failure);
      if (step === "after-snapshot")
        tx.user.findUnique.mockResolvedValueOnce(saved.users[1]).mockRejectedValueOnce(failure);
      if (step === "audit-write") tx.auditLog.create.mockRejectedValueOnce(failure);
      await expect(confirmRolesForAdmin(admin.id, input)).rejects.toBe(failure);
      expect(committed).toEqual(saved);
      if (step !== "audit-write") expect(tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("propagates a transaction/commit conflict without retrying", async () => {
    const input = await inputFor();
    const failure = Object.assign(new Error("serialization failure"), { code: "P2034" });
    db.$transaction.mockClear().mockRejectedValueOnce(failure);
    await expect(confirmRolesForAdmin(admin.id, input)).rejects.toBe(failure);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expectNoWrites();
  });

  it("validates strict admin wrapper input before opening a transaction", () => {
    expect(() =>
      inspectRolesForAdmin(admin.id, { ...target, actor: host } as typeof target),
    ).toThrow();
    expect(() =>
      confirmRolesForAdmin(admin.id, {
        ...target,
        requestId,
        decision: "revoked",
        expectedFingerprint: "not-a-fingerprint",
        reason: "Verified revocation",
      }),
    ).toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
