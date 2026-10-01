/**
 * #622 — the Prisma mock shared by the two-replica socket suites. It imports no
 * application module, so a `vi.mock` factory can load it while the app graph is
 * still evaluating:
 *   vi.mock("../src/lib/prisma.js", async () =>
 *     (await import("./helpers/two-replica-prisma.js")).prismaModuleMock());
 * The handshake (`loadLiveAuthPayload`) and `subscribe:mcp`
 * (`readLiveWorkspaceIds`) read users, roles and memberships through it; the
 * SCIM router writes the deprovision through it. #674: `subscribe:job` reads a
 * row-less job's durable scope (`jobScopeRecord`) and the project behind it
 * (`assertProjectAccess`) through it too; the shared `jobScopes` map is what
 * makes a record written by one replica readable by the other.
 */
import { vi } from "vitest";

interface UserRow {
  id: string;
  username: string;
  status: string;
  deletedAt: Date | null;
}

interface JobScopeRow {
  jobId: string;
  kind: string;
  projectId: string | null;
  expiresAt: Date;
}

export const db = {
  users: new Map<string, UserRow>(),
  /** `${workspaceId}:${userId}` → membership. */
  members: new Map<string, { workspaceId: string; userId: string }>(),
  /** projectId → workspaceId (#674). */
  projects: new Map<string, string>(),
  /** jobId → durable job scope (#674). */
  jobScopes: new Map<string, JobScopeRow>(),
};

function matchesUser(row: UserRow, where: { deletedAt?: null; status?: string } = {}): boolean {
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  return true;
}

/** Replace the fixture (a vitest retry must not inherit a failed attempt's writes). */
export function seed(
  users: string[],
  memberships: Array<[string, string]>,
  /** `[projectId, workspaceId]` pairs (#674). */
  projects: Array<[string, string]> = [],
): void {
  db.projects = new Map(projects);
  db.jobScopes = new Map();
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
    project: {
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { id: string };
          select?: { workspace?: { select?: { members?: { where?: { userId?: string } } } } };
        }) => {
          const workspaceId = db.projects.get(where.id);
          if (workspaceId === undefined) return null;
          const userId = select?.workspace?.select?.members?.where?.userId;
          const member = userId !== undefined && db.members.has(`${workspaceId}:${userId}`);
          return {
            workspaceId,
            workspace: { deletedAt: null, members: member ? [{ id: "m" }] : [] },
          };
        },
      ),
    },
    // Rows the row-less job never has; `subscribe:job` looks them up first.
    analysis: { findFirst: vi.fn(async () => null) },
    generatedDocument: { findFirst: vi.fn(async () => null) },
    importRun: { findFirst: vi.fn(async () => null) },
    impactAnalysis: { findFirst: vi.fn(async () => null) },
    jobScopeRecord: {
      upsert: vi.fn(async ({ create }: { create: JobScopeRow }) => {
        db.jobScopes.set(create.jobId, { ...create });
        return { ...create, createdAt: new Date() };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        let count = 0;
        for (const [id, row] of db.jobScopes) {
          if (row.expiresAt < where.expiresAt.lt) {
            db.jobScopes.delete(id);
            count += 1;
          }
        }
        return { count };
      }),
      findFirst: vi.fn(async ({ where }: { where: { jobId: string; expiresAt: { gt: Date } } }) => {
        const row = db.jobScopes.get(where.jobId);
        return row && row.expiresAt > where.expiresAt.gt
          ? { kind: row.kind, projectId: row.projectId }
          : null;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(client)),
  };
  return { prisma: client };
}
