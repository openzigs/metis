/**
 * #1251 — `assertProductAccessible` reads the caller's accessible projects
 * ONCE (`listMemberAccessibleProjectIds`) and looks each bound project up in
 * that set. It used to judge every bound project in turn — a live-project
 * read, a live-membership read and an `assertProjectAccess` read apiece — so a
 * product spanning many projects cost three queries per project.
 *
 * Every Prisma call is counted. The caller, Bob, is a non-admin member of
 * `ws1` (an admin skips the rule entirely, so would prove nothing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";

const PROJECTS = [
  { id: "p-foreign-1", workspaceId: "ws2" },
  { id: "p-foreign-2", workspaceId: "ws2" },
  { id: "p-foreign-3", workspaceId: "ws2" },
  { id: "p-mine", workspaceId: "ws1" },
];

const calls = vi.hoisted(() => [] as string[]);
const bound = vi.hoisted(() => ({ ids: [] as string[] }));
const count =
  <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
  (...args: A): R => {
    calls.push(name);
    return fn(...args);
  };

vi.mock("../prisma.js", () => ({
  prisma: {
    product: {
      findUnique: count("product.findUnique", async ({ where }: { where: { id: string } }) =>
        where.id === "prod-1" ? { projects: bound.ids.map((id) => ({ id })), repos: [] } : null,
      ),
    },
    workspaceMember: {
      findMany: count("workspaceMember.findMany", async () => [{ workspaceId: "ws1" }]),
    },
    project: {
      findMany: count(
        "project.findMany",
        async ({ where }: { where: { OR?: Array<{ workspaceId?: { in?: string[] } }> } }) => {
          const live = (where.OR ?? []).flatMap((c) => c.workspaceId?.in ?? []);
          return PROJECTS.filter((p) => live.includes(p.workspaceId)).map(({ id }) => ({ id }));
        },
      ),
      findFirst: count("project.findFirst", async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
      findUnique: count("project.findUnique", async ({ where }: { where: { id: string } }) => {
        const p = PROJECTS.find((x) => x.id === where.id);
        return p
          ? {
              workspaceId: p.workspaceId,
              workspace: { deletedAt: null, members: p.workspaceId === "ws1" ? [{ id: "m" }] : [] },
            }
          : null;
      }),
    },
  },
}));
const audit = vi.hoisted(() => vi.fn());
vi.mock("../audit/audit-service.js", () => ({ audit }));

const { assertProductAccessible } = await import("./product-access.js");

const bob: AuthPayload = {
  userId: "bob",
  username: "bob",
  role: "coordinator",
  permissions: [],
  workspaces: ["ws1"],
};

beforeEach(() => {
  calls.length = 0;
  audit.mockClear();
});

describe("assertProductAccessible (#1251)", () => {
  it("admits a member through the last of four bound projects with one accessible-ids query", async () => {
    bound.ids = PROJECTS.map((p) => p.id);
    await expect(assertProductAccessible(bob, "prod-1")).resolves.toBeUndefined();
    expect(calls).toEqual(["product.findUnique", "workspaceMember.findMany", "project.findMany"]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a product none of whose projects the member can reach with the same three reads, audited once", async () => {
    bound.ids = ["p-foreign-1", "p-foreign-2", "p-foreign-3"];
    await expect(assertProductAccessible(bob, "prod-1")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(calls).toEqual(["product.findUnique", "workspaceMember.findMany", "project.findMany"]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "product.access.denied",
        metadata: { reason: "project-access-denied", projectIds: bound.ids },
      }),
    );
  });

  it("reads nothing past the product for an admin, or for an unbound product", async () => {
    await assertProductAccessible({ ...bob, role: "admin" }, "prod-1");
    expect(calls).toEqual([]);
    bound.ids = [];
    await assertProductAccessible(bob, "prod-1");
    expect(calls).toEqual(["product.findUnique"]);
  });

  it("answers 404 for an unknown product", async () => {
    await expect(assertProductAccessible(bob, "nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});
