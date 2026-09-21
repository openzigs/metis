import { beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
type User = Row & { id: string; username: string; authRolesInitializedAt?: Date | null };
type Role = { id: string; key: string };
type UserRole = { userId: string; roleId: string; source: string; role: Role };
type Query = { where: Row };

/**
 * Opt-in persistence for route fixtures which log in through the real auth code.
 * No auth modules are mocked: provider grants and initialization markers are
 * written by reconcileTrustedLoginRole, then read from the same rows by routes.
 * Auth/SCIM unit tests retain their own purpose-built Prisma mocks.
 */
export function withRouteAuth<
  T extends {
    user: { upsert: (...args: never[]) => Promise<unknown> };
    userRole: object;
    workspaceMember: { findMany: (...args: never[]) => Promise<unknown> };
  },
>(fixture: T) {
  const users = new Map<string, User>();
  let grants: UserRole[] = [];
  const roles = ["reader", "developer", "coordinator", "admin"].map((key) => ({
    id: `role_${key}`,
    key,
  }));
  beforeEach(() => {
    users.clear();
    grants = [];
  });

  const originalUpsert = fixture.user.upsert;
  const user = {
    ...fixture.user,
    upsert: vi.fn(async (...args: Parameters<typeof originalUpsert>) => {
      const row = (await originalUpsert(...args)) as User;
      const previous = users.get(row.id);
      const [input] = args as unknown as [{ update?: Row }];
      const saved =
        previous?.username === row.username ? Object.assign(previous, input.update) : row;
      users.set(saved.id, saved);
      return saved;
    }),
    findFirst: vi.fn(
      async ({ where, include }: Query & { include?: Row }): Promise<User | null> => {
        const row =
          [...users.values()].find((row) =>
            Object.entries(where).every(([key, value]) => (row[key] ?? null) === value),
          ) ?? null;
        if (!row || !include) return row;
        return {
          ...row,
          ...(include.roles
            ? { roles: await userRole.findMany({ where: { userId: row.id } }) }
            : {}),
          ...(include.workspaceMemberships
            ? {
                workspaceMemberships: await (
                  fixture.workspaceMember.findMany as (args: Query) => Promise<unknown>
                )({ where: { userId: row.id } }),
              }
            : {}),
        };
      },
    ),
    update: vi.fn(async ({ where, data }: Query & { data: Row }) => {
      const row = users.get(String(where.id));
      if (!row) throw new Error("Route auth fixture user not found");
      Object.assign(row, data);
      return row;
    }),
  };
  const userRole = {
    findFirst: vi.fn(
      async (query: Query): Promise<UserRole | null> => (await userRole.findMany(query))[0] ?? null,
    ),
    findMany: vi.fn(async ({ where }: Query) =>
      grants.filter((row) =>
        Object.entries(where).every(([key, value]) => row[key as keyof UserRole] === value),
      ),
    ),
    deleteMany: vi.fn(async ({ where }: Query) => {
      const previous = grants.length;
      grants = grants.filter(
        (row) =>
          !Object.entries(where).every(([key, value]) => row[key as keyof UserRole] === value),
      );
      return { count: previous - grants.length };
    }),
    create: vi.fn(async ({ data }: { data: Omit<UserRole, "role"> }) => {
      const role = roles.find((row) => row.id === data.roleId);
      if (!role) throw new Error("Route auth fixture role not found");
      if (grants.some((row) => row.userId === data.userId && row.roleId === data.roleId)) {
        throw new Error("Duplicate route auth fixture role");
      }
      const row = { ...data, role };
      grants.push(row);
      return row;
    }),
    ...fixture.userRole,
  };
  const client = {
    ...fixture,
    user,
    userRole,
    role: {
      findFirst: vi.fn(
        async ({ where }: Query) => roles.find((row) => row.key === where.key) ?? null,
      ),
      // The fixture pre-creates the whole RoleKey vocabulary, so this only ever resolves.
      upsert: vi.fn(async ({ where }: Query) => {
        const existing = roles.find((row) => row.key === where.key);
        if (!existing) throw new Error(`Route auth fixture role ${where.key} not found`);
        return existing;
      }),
    },
  };
  return Object.assign(client, {
    $transaction: vi.fn(
      async <R>(
        operation: ((tx: typeof client) => Promise<R>) | Promise<unknown>[],
        _options?: { isolationLevel: string },
      ) => {
        if (Array.isArray(operation)) return Promise.all(operation);
        const savedUsers = structuredClone([...users]);
        const savedGrants = structuredClone(grants);
        try {
          return await operation(client);
        } catch (error) {
          users.clear();
          for (const [id, row] of savedUsers) users.set(id, row);
          grants = savedGrants;
          throw error;
        }
      },
    ),
  });
}
