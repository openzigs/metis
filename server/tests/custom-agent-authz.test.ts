/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #260 (#80) — RBAC for custom-agent authoring.
 *
 * `assertWorkspaceAdminForProject` resolves a project's workspace and asserts
 * the caller holds an `admin`/`owner` workspace role (system admins bypass).
 * Guards against IDOR: a non-member gets 404, not 403, so existence is not
 * leaked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = {
  project: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

const { assertWorkspaceAdminForProject, assertProjectAccess } =
  await import("../src/lib/custom-agents/authz.js");
const { AppError } = await import("../src/middleware/error-handler.js");

beforeEach(() => {
  mockPrisma.project.findUnique.mockReset();
  mockPrisma.workspaceMember.findUnique.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const sysAdmin = { userId: "u-sys", username: "sys", role: "admin", permissions: [] } as any;
const member = { userId: "u-m", username: "m", role: "user", permissions: [] } as any;

describe("assertWorkspaceAdminForProject (#80)", () => {
  it("system admins bypass workspace checks", async () => {
    await expect(assertWorkspaceAdminForProject(sysAdmin, "p1")).resolves.toBeUndefined();
    expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
  });

  it("allows a workspace admin", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: "p1", workspaceId: "w1" });
    mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: "admin" });
    await expect(assertWorkspaceAdminForProject(member, "p1")).resolves.toBeUndefined();
  });

  it("allows a workspace owner", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: "p1", workspaceId: "w1" });
    mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: "owner" });
    await expect(assertWorkspaceAdminForProject(member, "p1")).resolves.toBeUndefined();
  });

  it("rejects a plain member with 403", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: "p1", workspaceId: "w1" });
    mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: "member" });
    await expect(assertWorkspaceAdminForProject(member, "p1")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("returns 404 (not 403) for a non-member — does not leak existence", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: "p1", workspaceId: "w1" });
    mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(assertWorkspaceAdminForProject(member, "p1")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns 404 for an unknown project", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);
    await expect(assertWorkspaceAdminForProject(member, "nope")).rejects.toBeInstanceOf(AppError);
  });

  it("returns 400 when the project has no workspace yet", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: "p1", workspaceId: null });
    await expect(assertWorkspaceAdminForProject(member, "p1")).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("assertProjectAccess (#80)", () => {
  it("system admins bypass project access checks", async () => {
    await expect(assertProjectAccess(sysAdmin, "p1")).resolves.toBeUndefined();
    expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown project", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);
    await expect(assertProjectAccess(member, "nope")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("allows any authenticated user on a pre-migration project with no workspace", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ workspaceId: null });
    await expect(assertProjectAccess(member, "p1")).resolves.toBeUndefined();
  });

  it("allows a member of the project's workspace", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ workspaceId: "w1" });
    const inWs = { ...member, workspaces: ["w1"] };
    await expect(assertProjectAccess(inWs, "p1")).resolves.toBeUndefined();
  });

  it("returns 404 for a caller not in the project's workspace (no existence leak)", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ workspaceId: "w1" });
    const otherWs = { ...member, workspaces: ["w-other"] };
    await expect(assertProjectAccess(otherWs, "p1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns 404 when the caller has no workspaces array at all", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ workspaceId: "w1" });
    await expect(assertProjectAccess(member, "p1")).rejects.toMatchObject({ statusCode: 404 });
  });
});
