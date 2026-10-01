/**
 * #622 — the Prisma mock shared by the two-replica socket suites. It imports no
 * application module, so a `vi.mock` factory can load it while the app graph is
 * still evaluating:
 *   vi.mock("../src/lib/prisma.js", async () =>
 *     (await import("./helpers/two-replica-prisma.js")).prismaModuleMock());
 * The handshake (`loadLiveAuthPayload`) and `subscribe:mcp`
 * (`readLiveWorkspaceIds`) read users, roles and memberships through it; the
 * SCIM router writes the deprovision through it.
 */
import { vi } from "vitest";

interface UserRow {
  id: string;
  username: string;
  status: string;
  deletedAt: Date | null;
}

export const db = {
  users: new Map<string, UserRow>(),
  /** `${workspaceId}:${userId}` → membership. */
  members: new Map<string, { workspaceId: string; userId: string }>(),
};

function matchesUser(row: UserRow, where: { deletedAt?: null; status?: string } = {}): boolean {
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  return true;
}

/** Replace the fixture (a vitest retry must not inherit a failed attempt's writes). */
export function seed(users: string[], memberships: Array<[string, string]>): void {
  db.users = new Map(
    users.map((id) => [id, { id, username: id, status: "active", deletedAt: null }]),
  );
  db.members = new Map(
    memberships.map(([workspaceId, userId]) => [
      `${workspaceId}:${userId}`,
      { workspaceId, userId },
    ]),
  );
}

export function prismaModuleMock() {
  const client = {
    user: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; deletedAt?: null; status?: string } }) => {
          const row = db.users.get(where.id);
          return row && matchesUser(row, where) ? { ...row } : null;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const row = db.users.get(where.id)!;
        Object.assign(row, data);
        return { ...row, createdAt: new Date(), updatedAt: new Date(), email: null };
      }),
    },
    userRole: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      // Every user is a coordinator, which holds `mcp.manage`.
      findMany: vi.fn(async () => [{ source: "local", role: { key: "coordinator" } }]),
    },
    workspaceMember: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; user?: { deletedAt?: null; status?: string } };
        }) =>
          [...db.members.values()]
            .filter((m) => m.userId === where.userId)
            .filter((m) => {
              const row = db.users.get(m.userId);
              return !where.user || (row !== undefined && matchesUser(row, where.user));
            })
            .map((m) => ({ workspaceId: m.workspaceId })),
      ),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(client)),
  };
  return { prisma: client };
}
