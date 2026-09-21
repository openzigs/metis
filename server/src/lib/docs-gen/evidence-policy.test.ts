import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    project: { findFirst: vi.fn(), findUnique: vi.fn() },
    codeGraph: { findFirst: vi.fn() },
  },
}));
import { prisma } from "../prisma.js";
import {
  assertEvidencePolicy,
  createEvidencePolicy,
  resolveEvidencePolicy,
  requireRepositoryGraph,
  type EvidencePolicy,
} from "./evidence-policy.js";

const auth = {
  userId: "alice",
  username: "alice",
  role: "coordinator" as const,
  permissions: ["project.update" as const],
};
const record = {
  id: "gen1",
  projectId: "p1",
  scope: "repository",
  scopeFilter: JSON.stringify({ repoConnectorId: "repo-a", actorId: "admin" }),
  evidencePolicy: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findFirst).mockResolvedValue({
    id: "alice",
    username: "alice",
    roles: [{ role: { key: "coordinator" } }],
    workspaceMemberships: [{ workspaceId: "w1" }],
  } as never);
  vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: "p1" } as never);
  vi.mocked(prisma.project.findUnique).mockResolvedValue({ workspaceId: "w1" } as never);
  vi.mocked(prisma.codeGraph.findFirst).mockResolvedValue({ id: "graph-a" } as never);
  record.evidencePolicy = createEvidencePolicy(auth, {
    sharedDocumentIds: ["ref1"],
    allowWebResearch: false,
  });
});

describe("trusted generation evidence policy #1353", () => {
  it.each(["scim", "explicit", "revoked"])(
    "rejects provider drift under %s authority",
    async (authRoleAuthority) => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue({
        id: "alice",
        username: "alice",
        authRoleAuthority,
        roles: [{ source: "provider", role: { key: "admin" } }],
        workspaceMemberships: [{ workspaceId: "w1" }],
      } as never);
      await expect(resolveEvidencePolicy(record)).rejects.toThrow(
        "Generation authorization unavailable",
      );
    },
  );
  it("rejects blank repository identifiers without querying graphs", async () => {
    await expect(requireRepositoryGraph("p1", "  ")).rejects.toThrow(
      "Requested repository graph is unavailable",
    );
    expect(prisma.codeGraph.findFirst).not.toHaveBeenCalled();
  });
  it("rejects each missing required retrieval identity", async () => {
    const valid = await resolveEvidencePolicy(record);
    for (const invalid of [
      undefined,
      { ...valid, projectId: "foreign" },
      { ...valid, actor: undefined },
      { ...valid, actor: { userId: "", role: "developer" } },
      { ...valid, actor: { userId: "alice", role: "" } },
      { ...valid, generatedDocumentId: "" },
    ]) {
      expect(() => assertEvidencePolicy(invalid as EvidencePolicy, "p1")).toThrow(
        "Generation authorization unavailable",
      );
    }
    expect(() => assertEvidencePolicy(valid, "p1")).not.toThrow();
  });
  it("revalidates persisted principal, membership and role rather than scopeFilter actor", async () => {
    const policy = await resolveEvidencePolicy(record);
    expect(policy.actor).toEqual({ userId: "alice", role: "coordinator" });
    expect(policy.repoConnectorId).toBe("repo-a");
    expect(policy.codeGraphId).toBe("graph-a");
    expect(policy.sharedDocumentIds).toEqual(["ref1"]);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "alice", status: "active", deletedAt: null } }),
    );
  });
  it.each([null, "{}", "not json", JSON.stringify({ version: 1, actorId: "alice" })])(
    "fails closed for legacy or invalid persisted policy %s",
    async (evidencePolicy) => {
      await expect(resolveEvidencePolicy({ ...record, evidencePolicy })).rejects.toThrow();
    },
  );
  it("fails closed when the initiating user was removed/disabled", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    await expect(resolveEvidencePolicy(record)).rejects.toThrow(
      "Generation authorization unavailable",
    );
  });
  it.each([[], [{ role: { key: "reader" } }], [{ role: { key: "unknown" } }]])(
    "rejects revoked or unknown role %j",
    async (roles) => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue({
        username: "alice",
        roles,
        workspaceMemberships: [],
      } as never);
      await expect(resolveEvidencePolicy(record)).rejects.toThrow();
    },
  );
  it("denies background execution after a formerly-admin principal is revoked to reader", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "alice",
      username: "alice",
      roles: [{ role: { key: "reader" } }],
      workspaceMemberships: [{ workspaceId: "w1" }],
    } as never);

    await expect(
      resolveEvidencePolicy({
        ...record,
        evidencePolicy: createEvidencePolicy({
          ...auth,
          role: "admin",
          permissions: ["project.update"],
        }),
      }),
    ).rejects.toThrow("Generation authorization unavailable");
  });
  it("fails closed when the user no longer has a persisted local role", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "alice",
      username: "alice",
      roles: [],
      workspaceMemberships: [{ workspaceId: "w1" }],
    } as never);

    await expect(
      resolveEvidencePolicy({
        ...record,
        evidencePolicy: createEvidencePolicy({
          ...auth,
          role: "admin",
          permissions: ["project.update"],
        }),
      }),
    ).rejects.toThrow("Generation authorization unavailable");
  });
  it("rejects removed project membership", async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({ workspaceId: "foreign" } as never);
    await expect(resolveEvidencePolicy(record)).rejects.toThrow();
  });
  it("rejects a deleted project even for an admin", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await expect(resolveEvidencePolicy(record)).rejects.toThrow();
  });
  it("prefers an explicit SCIM reader role over a provider admin row during revalidation", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "alice",
      username: "alice",
      roles: [
        { role: { key: "admin" }, source: "provider" },
        { role: { key: "reader" }, source: "scim" },
      ],
      workspaceMemberships: [{ workspaceId: "w1" }],
    } as never);

    await expect(resolveEvidencePolicy(record)).rejects.toThrow(
      "Generation authorization unavailable",
    );
  });
  it.each([false, true])(
    "uses the highest valid explicit role irrespective of row order (reverse=%s)",
    async (reverse) => {
      const roles = [
        { source: "scim", role: { key: "reader" } },
        { source: "local", role: { key: "coordinator" } },
        { source: "scim", role: { key: "invalid" } },
        { source: "provider", role: { key: "admin" } },
      ];
      vi.mocked(prisma.user.findFirst).mockResolvedValue({
        id: "alice",
        username: "alice",
        roles: reverse ? roles.reverse() : roles,
        workspaceMemberships: [{ workspaceId: "w1" }],
      } as never);
      expect((await resolveEvidencePolicy(record)).actor.role).toBe("coordinator");
    },
  );
  it.each(["missing", "deleted", "foreign", "foreign-connection"])(
    "rejects %s repository graph without project fallback",
    async (state) => {
      const graphs =
        state === "missing"
          ? []
          : [
              {
                id: "graph-a",
                projectId: state === "foreign" ? "p2" : "p1",
                repoConnectionId: "repo-a",
                repoConnection: {
                  projectId: state === "foreign-connection" ? "p2" : "p1",
                  deletedAt: state === "deleted" ? new Date() : null,
                },
              },
            ];
      vi.mocked(prisma.codeGraph.findFirst).mockImplementation(async (args) => {
        const where = args?.where;
        const connection = where?.repoConnection as
          | { projectId?: string; deletedAt?: null }
          | undefined;
        return (
          (graphs.find(
            (g) =>
              g.projectId === where?.projectId &&
              g.repoConnectionId === where?.repoConnectionId &&
              (!connection?.projectId || g.repoConnection.projectId === connection.projectId) &&
              (connection?.deletedAt !== null || g.repoConnection.deletedAt === null),
          ) as never) ?? null
        );
      });
      await expect(requireRepositoryGraph("p1", "repo-a")).rejects.toThrow(
        "Requested repository graph is unavailable",
      );
      expect(prisma.codeGraph.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: "p1",
          repoConnectionId: "repo-a",
          repoConnection: { projectId: "p1", deletedAt: null },
        },
        select: { id: true },
      });
    },
  );
  it("rejects a developer specifically for missing permission even with valid membership", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "alice",
      username: "alice",
      roles: [{ role: { key: "developer" } }],
      workspaceMemberships: [{ workspaceId: "w1" }],
    } as never);

    await expect(resolveEvidencePolicy(record)).rejects.toMatchObject({
      code: "GENERATION_AUTH_UNAVAILABLE",
    });
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });
  it.each(["{}", "bad json", JSON.stringify({ repoConnectorId: "" })])(
    "does not broaden invalid persisted repository scope %s",
    async (scopeFilter) => {
      await expect(resolveEvidencePolicy({ ...record, scopeFilter })).rejects.toThrow();
    },
  );
  it("allows full-project background execution with explicit reference defaults", async () => {
    const policy = await resolveEvidencePolicy({
      ...record,
      scope: "full",
      evidencePolicy: createEvidencePolicy(auth),
    });
    expect(policy.repoConnectorId).toBeUndefined();
    expect(policy.sharedDocumentIds).toEqual([]);
    expect(policy.allowWebResearch).toBe(false);
  });
});
