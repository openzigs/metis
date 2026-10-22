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
  let identities: Row[] = [];
  beforeEach(() => {
    users.clear();
    grants = [];
    identities = [];
  });

  // Leave the caller's `upsert` out of the spread: intersected with the wrapper
  // below, it would become an overload whose return type shadows `User`.
  const { upsert: originalUpsert, ...userRest } = fixture.user;
  const user = {
    ...userRest,
    upsert: vi.fn(async (...args: Parameters<T["user"]["upsert"]>) => {
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
    // #1395 — login resolves the user by identity, then by username, and
    // creates or claims it (`login-identity.ts`). `create` still goes through
    // the caller's `upsert`, so a fixture that records its rows keeps doing so.
    findUnique: vi.fn(async (query: Query & { select?: Row }) => {
      const { where } = query;
      if (typeof where.username === "string") {
        const row = [...users.values()].find((r) => r.username === where.username) ?? null;
        if (!row) return null;
        return {
          ...row,
          authSource: row.authSource ?? null,
          identities: identities.filter((i) => i.userId === row.id),
        };
      }
      const own = (userRest as { findUnique?: (q: unknown) => Promise<unknown> }).findUnique;
      if (own) return own(query);
      return users.get(String(where.id)) ?? null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: Query) => {
      const row = users.get(String(where.id));
      if (!row) throw new Error("Route auth fixture user not found");
      return row;
    }),
    create: vi.fn(async ({ data }: { data: Row & { identities?: { create: Row } } }) => {
      const { identities: nested, ...fields } = data;
      const created = (await (originalUpsert as unknown as (q: unknown) => Promise<User>)({
        where: { username: fields.username },
        create: fields,
        update: {},
      })) as User;
      const row: User = { ...created, ...fields, id: created.id };
      users.set(row.id, row);
      if (nested) identities.push({ ...nested.create, userId: row.id });
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: Query & { data: Row }) => {
      const row = users.get(String(where.id));
      const unbound = row && !identities.some((i) => i.userId === row.id);
      if (!row || !unbound || (row.authSource ?? null) !== where.authSource) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const userIdentity = {
    findUnique: vi.fn(async ({ where }: Query) => {
      const key = where.provider_issuer_subject as Row;
      const row = identities.find(
        (i) => i.provider === key.provider && i.issuer === key.issuer && i.subject === key.subject,
      );
      return row ? { id: `${row.provider}:${row.issuer}:${row.subject}`, ...row } : null;
    }),
    update: vi.fn(async () => ({})),
    create: vi.fn(async ({ data }: { data: Row }) => {
      identities.push(data);
      return data;
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
  // Same reason as `userRest`: a generic spread of `fixture` would intersect its
  // `user` with the wrapper's instead of replacing it.
  const { user: _callerUser, ...fixtureRest } = fixture;
  const client = {
    ...fixtureRest,
    user,
    userRole,
    userIdentity,
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
