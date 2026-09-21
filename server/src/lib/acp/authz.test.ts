/**
 * Issue #676 — unit tests for the ACP authz bridge (scope model, VerifiedToken
 * → AuthPayload resolution, project-scope helpers).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const userRoleFindFirst = vi.fn();
const workspaceMemberFindMany = vi.fn();
const projectFindMany = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    userRole: { findFirst: (...a: unknown[]) => userRoleFindFirst(...a) },
    workspaceMember: { findMany: (...a: unknown[]) => workspaceMemberFindMany(...a) },
    project: { findMany: (...a: unknown[]) => projectFindMany(...a) },
  },
}));

const {
  ACP_SCOPES,
  ACP_SCOPE_WILDCARD,
  ACP_METHOD_SCOPES,
  GRANTABLE_ACP_SCOPES,
  tokenHasScope,
  clampAcpScopes,
  resolveAcpActor,
  isAdminActor,
  accessibleProjectWhere,
  listAccessibleProjectIds,
} = await import("./authz.js");

beforeEach(() => vi.clearAllMocks());

describe("scope model", () => {
  it("maps every ACP method to a scope", () => {
    expect(ACP_METHOD_SCOPES["list-projects"]).toBe(ACP_SCOPES.READ);
    expect(ACP_METHOD_SCOPES["list-skills"]).toBe(ACP_SCOPES.READ);
    expect(ACP_METHOD_SCOPES["list-agents"]).toBe(ACP_SCOPES.READ);
    expect(ACP_METHOD_SCOPES["run-agent"]).toBe(ACP_SCOPES.RUN);
  });

  it("tokenHasScope honors direct grant and the wildcard", () => {
    expect(tokenHasScope([ACP_SCOPES.READ], ACP_SCOPES.READ)).toBe(true);
    expect(tokenHasScope([ACP_SCOPES.READ], ACP_SCOPES.RUN)).toBe(false);
    expect(tokenHasScope([ACP_SCOPE_WILDCARD], ACP_SCOPES.RUN)).toBe(true);
    expect(tokenHasScope([], ACP_SCOPES.READ)).toBe(false);
  });
});

describe("clampAcpScopes", () => {
  it("defaults to the full grantable set when none requested", () => {
    expect(clampAcpScopes(undefined)).toEqual([...GRANTABLE_ACP_SCOPES]);
    expect(clampAcpScopes([])).toEqual([...GRANTABLE_ACP_SCOPES]);
  });

  it("drops unknown / over-privileged scopes", () => {
    expect(clampAcpScopes(["acp:read", "acp:admin", "role.manage"])).toEqual([ACP_SCOPES.READ]);
  });

  it("falls back to the default set when every requested scope is dropped", () => {
    expect(clampAcpScopes(["acp:admin", "role.manage"])).toEqual([...GRANTABLE_ACP_SCOPES]);
  });

  it("expands a requested wildcard into the concrete grantable scopes and never persists acp:*", () => {
    const clamped = clampAcpScopes([ACP_SCOPE_WILDCARD]);
    expect(clamped).toEqual([...GRANTABLE_ACP_SCOPES]);
    expect(clamped).not.toContain(ACP_SCOPE_WILDCARD);
  });

  it("expands the wildcard when mixed with other scopes and de-duplicates", () => {
    const clamped = clampAcpScopes([ACP_SCOPE_WILDCARD, ACP_SCOPES.READ, ACP_SCOPE_WILDCARD]);
    expect(clamped).not.toContain(ACP_SCOPE_WILDCARD);
    expect(new Set(clamped)).toEqual(new Set([ACP_SCOPES.READ, ACP_SCOPES.RUN]));
  });
});

describe("resolveAcpActor", () => {
  it("loads role + workspaces from the token's user", async () => {
    userRoleFindFirst.mockResolvedValue({ role: { key: "coordinator" } });
    workspaceMemberFindMany.mockResolvedValue([{ workspaceId: "ws-1" }, { workspaceId: "ws-2" }]);

    const actor = await resolveAcpActor({ tokenId: "t", userId: "u1", scopes: [] });

    expect(actor).toMatchObject({
      userId: "u1",
      role: "coordinator",
      workspaces: ["ws-1", "ws-2"],
    });
  });

  it("defaults to the least-privileged reader role when the user has no assignment", async () => {
    userRoleFindFirst.mockResolvedValue(null);
    workspaceMemberFindMany.mockResolvedValue([]);

    const actor = await resolveAcpActor({ tokenId: "t", userId: "u2", scopes: [] });

    expect(actor.role).toBe("reader");
    expect(isAdminActor(actor)).toBe(false);
  });
});

describe("accessibleProjectWhere / listAccessibleProjectIds", () => {
  it("admin: unfiltered (all non-deleted projects)", () => {
    const where = accessibleProjectWhere({
      userId: "a",
      username: "",
      role: "admin",
      permissions: [],
      workspaces: [],
    });
    expect(where).toEqual({ deletedAt: null });
  });

  it("non-admin: open projects OR the caller's workspaces", () => {
    const where = accessibleProjectWhere({
      userId: "u",
      username: "",
      role: "reader",
      permissions: [],
      workspaces: ["ws-a"],
    });
    expect(where).toEqual({
      deletedAt: null,
      OR: [{ workspaceId: null }, { workspaceId: { in: ["ws-a"] } }],
    });
  });

  it("listAccessibleProjectIds returns the queried ids", async () => {
    projectFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    const ids = await listAccessibleProjectIds({
      userId: "u",
      username: "",
      role: "reader",
      permissions: [],
      workspaces: ["ws-a"],
    });
    expect(ids).toEqual(["p1", "p2"]);
  });
});
