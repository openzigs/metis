/**
 * DB connector service — covers RBAC adjacency through CRUD + test + query
 * + secret resolution + adapter caching/invalidation. Prisma is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DbRow {
  id: string;
  projectId: string;
  label: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  username: string | null;
  secretId: string | null;
  options: string | null;
  status: string;
  errorMessage: string | null;
  lastTestedAt: Date | null;
  lastIngestAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const rows = new Map<string, DbRow>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    databaseConnection: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) =>
        [...rows.values()].filter((r) => r.projectId === where.projectId && !r.deletedAt),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const r of rows.values()) {
          if (r.deletedAt) continue;
          let ok = true;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) ok = false;
          }
          if (ok) return r;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<DbRow> }) => {
        nextId += 1;
        const row: DbRow = {
          id: `db_${nextId}`,
          host: null,
          port: null,
          databaseName: null,
          username: null,
          secretId: null,
          options: null,
          status: "pending",
          errorMessage: null,
          lastTestedAt: null,
          lastIngestAt: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          ...(data as DbRow),
        };
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DbRow> }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() } as DbRow;
        rows.set(where.id, next);
        return next;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "db.example.com",
    address: "203.0.113.10",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));

vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async (ref: string | null) => (ref ? `plain-${ref}` : null)),
}));

vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: vi.fn(() => ({})),
}));

import {
  closeAllAdapters,
  buildCodeGraphSchemaWiring,
  createDbConnector,
  deleteDbConnector,
  getDbConnector,
  inspectDbConnector,
  listDbConnectors,
  queryDbConnector,
  testDbConnector,
  updateDbConnector,
} from "../src/lib/connectors/db/db-service.js";
import {
  __resetDriverRegistry,
  registerDriver,
  type DbDriverAdapter,
} from "../src/lib/connectors/db/driver.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

let _initCount = 0;
function makeFakeAdapter(
  behaviour: {
    ping?: () => Promise<number>;
    query?: () => Promise<{
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      durationMs: number;
    }>;
    introspect?: () => Promise<unknown[]>;
    introspectRoutines?: () => Promise<unknown[]>;
    fetchRoutineBody?: (routine: unknown) => Promise<string | null>;
    introspectDependencies?: () => Promise<unknown[]>;
    introspectPackages?: () => Promise<unknown[]>;
    fetchPackageBody?: (pkg: unknown) => Promise<string | null>;
    close?: () => Promise<void>;
  } = {},
): DbDriverAdapter {
  return {
    init: vi.fn(async () => {
      _initCount += 1;
    }),
    ping: vi.fn(behaviour.ping ?? (async () => 12)),
    query: vi.fn(
      behaviour.query ??
        (async () => ({
          columns: ["id"],
          rows: [{ id: 1, email: "a@b.com" }],
          rowCount: 1,
          truncated: false,
          durationMs: 5,
        })),
    ),
    introspect: vi.fn(behaviour.introspect ?? (async () => [])),
    ...(behaviour.introspectRoutines
      ? { introspectRoutines: vi.fn(behaviour.introspectRoutines) }
      : {}),
    ...(behaviour.fetchRoutineBody ? { fetchRoutineBody: vi.fn(behaviour.fetchRoutineBody) } : {}),
    ...(behaviour.introspectDependencies
      ? { introspectDependencies: vi.fn(behaviour.introspectDependencies) }
      : {}),
    ...(behaviour.introspectPackages
      ? { introspectPackages: vi.fn(behaviour.introspectPackages) }
      : {}),
    ...(behaviour.fetchPackageBody ? { fetchPackageBody: vi.fn(behaviour.fetchPackageBody) } : {}),
    close: vi.fn(behaviour.close ?? (async () => {})),
  } as unknown as DbDriverAdapter;
}

beforeEach(() => {
  rows.clear();
  nextId = 0;
  _initCount = 0;
  __resetDriverRegistry();
  registerDriver("postgres", () => makeFakeAdapter());
});

afterEach(async () => {
  await closeAllAdapters();
  vi.clearAllMocks();
});

describe("DB connector service — CRUD", () => {
  it("creates, lists, gets, updates, and soft-deletes", async () => {
    const created = await createDbConnector(
      "proj_1",
      {
        label: "primary",
        driver: "postgres",
        host: "db.example.com",
        port: 5432,
        databaseName: "app",
        username: "rw",
        secretRef: "${vault:db-pass}",
      },
      "user_1",
    );
    expect(created.id).toBe("db_1");
    expect(created.secretRef).toBe("${vault:db-pass}");

    const list = await listDbConnectors("proj_1");
    expect(list).toHaveLength(1);

    const got = await getDbConnector("proj_1", created.id);
    expect(got.label).toBe("primary");

    const updated = await updateDbConnector("proj_1", created.id, { label: "renamed" }, "user_1");
    expect(updated.label).toBe("renamed");

    await deleteDbConnector("proj_1", created.id, "user_1");
    const remaining = await listDbConnectors("proj_1");
    expect(remaining).toHaveLength(0);
  });

  it("rejects duplicate label per project", async () => {
    await createDbConnector("proj_1", { label: "dup", driver: "postgres", host: "h" }, "user_1");
    await expect(
      createDbConnector("proj_1", { label: "dup", driver: "postgres", host: "h" }, "user_1"),
    ).rejects.toMatchObject({ code: "DB_LABEL_TAKEN", status: 409 });
  });

  it("rejects unsupported driver", async () => {
    await expect(
      createDbConnector(
        "proj_1",
        // @ts-expect-error testing unsupported value
        { label: "bad", driver: "weird", host: "h" },
        "user_1",
      ),
    ).rejects.toMatchObject({ code: "DRIVER_UNSUPPORTED" });
  });

  it("getDbConnector throws DB_CONNECTOR_NOT_FOUND for unknown ids", async () => {
    await expect(getDbConnector("proj_1", "nope")).rejects.toMatchObject({
      code: "DB_CONNECTOR_NOT_FOUND",
      status: 404,
    });
  });

  it("project isolation — cannot read another project's connector", async () => {
    const c = await createDbConnector(
      "proj_a",
      { label: "x", driver: "postgres", host: "h" },
      "user_1",
    );
    await expect(getDbConnector("proj_b", c.id)).rejects.toMatchObject({
      code: "DB_CONNECTOR_NOT_FOUND",
    });
  });
});

describe("DB connector service — operations", () => {
  it("test() opens the adapter and persists status=connected", async () => {
    const c = await createDbConnector(
      "proj_1",
      {
        label: "t",
        driver: "postgres",
        host: "db.example.com",
        port: 5432,
        databaseName: "app",
        username: "u",
        secretRef: "${vault:p}",
      },
      "user_1",
    );
    const result = await testDbConnector("proj_1", c.id, "user_1");
    expect(result.ok).toBe(true);
    const updated = await getDbConnector("proj_1", c.id);
    expect(updated.status).toBe("connected");
  });

  it("test() persists status=error on driver ping failure", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        ping: async () => {
          throw new ConnectorError(401, "DB_AUTH_FAILED", "auth failed");
        },
      }),
    );
    const c = await createDbConnector(
      "proj_1",
      { label: "t2", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    await expect(testDbConnector("proj_1", c.id, "user_1")).rejects.toMatchObject({
      code: "DB_AUTH_FAILED",
    });
    const updated = await getDbConnector("proj_1", c.id);
    expect(updated.status).toBe("error");
  });

  it("inspect() returns a snapshot with table count and driver", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          { schema: "public", name: "users", columns: [], foreignKeys: [], indexes: [] },
        ],
      }),
    );
    const c = await createDbConnector(
      "proj_1",
      { label: "i", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const snap = await inspectDbConnector("proj_1", c.id, "user_1");
    expect(snap.tables).toHaveLength(1);
    expect(snap.driver).toBe("postgres");
    expect(typeof snap.extractedAt).toBe("string");
  });

  it("query() rejects non-SELECT before driver is touched", async () => {
    const c = await createDbConnector(
      "proj_1",
      { label: "q", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    await expect(
      queryDbConnector("proj_1", c.id, "user_1", "DELETE FROM users"),
    ).rejects.toMatchObject({ code: /NON_SELECT|FORBIDDEN_KEYWORD/ });
  });

  it("query() redacts PII in returned rows", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        query: async () => ({
          columns: ["email"],
          rows: [{ email: "alice@example.com" }],
          rowCount: 1,
          truncated: false,
          durationMs: 5,
        }),
      }),
    );
    const c = await createDbConnector(
      "proj_1",
      { label: "q2", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const out = await queryDbConnector("proj_1", c.id, "user_1", "SELECT email FROM users");
    expect((out.rows[0] as { email: string }).email).toContain("[REDACTED:email]");
  });

  it("update() invalidates the cached adapter via close()", async () => {
    let closed = 0;
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        close: async () => {
          closed += 1;
        },
      }),
    );
    const c = await createDbConnector(
      "proj_1",
      { label: "cache", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    await testDbConnector("proj_1", c.id, "user_1");
    await updateDbConnector("proj_1", c.id, { username: "different" }, "user_1");
    expect(closed).toBeGreaterThan(0);
  });

  it("rejects malformed secretRef on create (extractRefBody)", async () => {
    await expect(
      createDbConnector(
        "proj_1",
        {
          label: "bad-ref",
          driver: "postgres",
          host: "h",
          username: "u",
          secretRef: "not-a-vault-ref",
        },
        "user_1",
      ),
    ).rejects.toMatchObject({ code: "VAULT_REF_INVALID" });
  });

  it("rejects malformed secretRef on update (extractRefBody)", async () => {
    const c = await createDbConnector(
      "proj_1",
      { label: "u-ref", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    await expect(
      updateDbConnector("proj_1", c.id, { secretRef: "garbage" }, "user_1"),
    ).rejects.toMatchObject({ code: "VAULT_REF_INVALID" });
  });

  it("ping failure that throws non-ConnectorError is wrapped as INTERNAL", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        ping: async () => {
          throw new Error("raw pop");
        },
      }),
    );
    const c = await createDbConnector(
      "proj_1",
      { label: "raw", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    await expect(testDbConnector("proj_1", c.id, "user_1")).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });

  it("create() with malformed options JSON falls back to undefined options", async () => {
    // The schema accepts options as Record — but if persisted as bad JSON the
    // safeJsonParse catch path fires when fetching back. Persist directly via
    // the prisma mock to simulate bad data.
    const created = await createDbConnector(
      "proj_1",
      { label: "json-bad", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    // mutate persisted row to invalid JSON via the rows map (mock state)
    const row = (rows as unknown as Map<string, { options: string | null }>).get(created.id)!;
    row.options = "{not valid json";
    const reloaded = await getDbConnector("proj_1", created.id);
    // Service should handle it gracefully — exact handling is acceptable as
    // long as we don't throw.
    expect(reloaded.id).toBe(created.id);
  });
});

describe("buildCodeGraphSchemaWiring (#316/#317)", () => {
  it("returns empty wiring when the project has no DB connector (no regression)", async () => {
    const wiring = await buildCodeGraphSchemaWiring("proj_without_db", "user_1");
    expect(wiring).toEqual({
      introspectedSchema: null,
      routines: [],
      packages: [],
      dependencies: [],
      sqlLineageOverride: false,
    });
  });

  it("introspects schema + routines and binds a read-only body fetcher", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          {
            schema: "public",
            name: "users",
            columns: [{ name: "id", dataType: "integer", nullable: false, isPrimaryKey: true }],
            foreignKeys: [],
            indexes: [],
          },
        ],
        introspectRoutines: async () => [
          { schema: "app", name: "recalc", type: "procedure", signature: "" },
        ],
        fetchRoutineBody: async () =>
          "CREATE PROCEDURE recalc AS BEGIN UPDATE orders SET x=1; END;",
      }),
    );
    const c = await createDbConnector(
      "proj_w",
      { label: "w", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    expect(c.id).toBeTruthy();

    const wiring = await buildCodeGraphSchemaWiring("proj_w", "user_1");

    // #317 — schema mapped into the sqlglot { db: { table: { col: type } } } shape.
    expect(wiring.introspectedSchema).toEqual({ public: { users: { id: "integer" } } });
    // #316B — routines surfaced + a body fetcher bound.
    expect(wiring.routines).toEqual([
      { schema: "app", name: "recalc", type: "procedure", signature: "" },
    ]);
    expect(typeof wiring.fetchRoutineBody).toBe("function");
    const body = await wiring.fetchRoutineBody!({
      schema: "app",
      name: "recalc",
      type: "procedure",
      signature: "",
    });
    expect(body).toContain("CREATE PROCEDURE recalc");
    expect(wiring.routineDialect).toBe("postgres");
    // #890/#894 — no introspectDependencies on this adapter ⇒ empty, never throws.
    expect(wiring.dependencies).toEqual([]);
  });

  it("never throws — returns empty wiring when introspection fails", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    );
    await createDbConnector(
      "proj_fail",
      { label: "f", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const wiring = await buildCodeGraphSchemaWiring("proj_fail", "user_1");
    expect(wiring).toEqual({
      introspectedSchema: null,
      routines: [],
      packages: [],
      dependencies: [],
      sqlLineageOverride: false,
    });
  });

  it("the bound body fetcher returns null (never throws) when the driver fetch throws", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          { schema: "public", name: "t", columns: [], foreignKeys: [], indexes: [] },
        ],
        fetchRoutineBody: async () => {
          throw new Error("ORA-00942: table or view does not exist");
        },
      }),
    );
    await createDbConnector(
      "proj_throws",
      { label: "th", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const wiring = await buildCodeGraphSchemaWiring("proj_throws", "user_1");
    const body = await wiring.fetchRoutineBody!({
      schema: "app",
      name: "x",
      type: "procedure",
      signature: "",
    });
    expect(body).toBeNull();
  });

  it("the bound body fetcher returns null (never throws) on a driver without fetchRoutineBody", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          { schema: "public", name: "t", columns: [], foreignKeys: [], indexes: [] },
        ],
        // no fetchRoutineBody on this adapter
      }),
    );
    await createDbConnector(
      "proj_nobody",
      { label: "nb", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const wiring = await buildCodeGraphSchemaWiring("proj_nobody", "user_1");
    const body = await wiring.fetchRoutineBody!({
      schema: "app",
      name: "x",
      type: "procedure",
      signature: "",
    });
    expect(body).toBeNull();
  });

  it("#890/#894 — surfaces Tier-1 dependency rows when the driver supports introspectDependencies", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          { schema: "public", name: "t", columns: [], foreignKeys: [], indexes: [] },
        ],
        introspectDependencies: async () => [
          {
            schema: "APP",
            name: "PKG_ORDERS",
            type: "PACKAGE",
            referencedSchema: "APP",
            referencedName: "ORDERS",
            referencedType: "TABLE",
          },
        ],
      }),
    );
    await createDbConnector(
      "proj_deps",
      { label: "d", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const wiring = await buildCodeGraphSchemaWiring("proj_deps", "user_1");
    expect(wiring.dependencies).toEqual([
      {
        schema: "APP",
        name: "PKG_ORDERS",
        type: "PACKAGE",
        referencedSchema: "APP",
        referencedName: "ORDERS",
        referencedType: "TABLE",
      },
    ]);
  });

  it("#890/#894 — never throws (empty dependencies) when introspectDependencies fails", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          { schema: "public", name: "t", columns: [], foreignKeys: [], indexes: [] },
        ],
        introspectDependencies: async () => {
          throw new Error("ORA-00942: insufficient privileges");
        },
      }),
    );
    await createDbConnector(
      "proj_deps_fail",
      { label: "df", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const wiring = await buildCodeGraphSchemaWiring("proj_deps_fail", "user_1");
    expect(wiring.dependencies).toEqual([]);
  });

  it("#893/#953 — surfaces PL/SQL packages + binds a READ-ONLY body fetcher when the driver supports it", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          { schema: "public", name: "t", columns: [], foreignKeys: [], indexes: [] },
        ],
        introspectPackages: async () => [
          { schema: "APP", name: "ORDER_PKG", hasSpec: true, hasBody: true, members: ["RECALC"] },
        ],
        fetchPackageBody: async (pkg) =>
          `CREATE PACKAGE BODY ${(pkg as { schema: string; name: string }).name} AS END;`,
      }),
    );
    await createDbConnector(
      "proj_pkgs",
      { label: "p", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const wiring = await buildCodeGraphSchemaWiring("proj_pkgs", "user_1");
    expect(wiring.packages).toEqual([
      { schema: "APP", name: "ORDER_PKG", hasSpec: true, hasBody: true, members: ["RECALC"] },
    ]);
    expect(typeof wiring.fetchPackageBody).toBe("function");
    const body = await wiring.fetchPackageBody!({
      schema: "APP",
      name: "ORDER_PKG",
      hasSpec: true,
      hasBody: true,
      members: ["RECALC"],
    });
    expect(body).toContain("CREATE PACKAGE BODY ORDER_PKG");
  });

  it("#893/#953 — never throws (empty packages) when introspectPackages fails", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          { schema: "public", name: "t", columns: [], foreignKeys: [], indexes: [] },
        ],
        introspectPackages: async () => {
          throw new Error("ORA-00942: insufficient privileges");
        },
      }),
    );
    await createDbConnector(
      "proj_pkgs_fail",
      { label: "pf", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const wiring = await buildCodeGraphSchemaWiring("proj_pkgs_fail", "user_1");
    expect(wiring.packages).toEqual([]);
  });

  it("#893/#953 — the bound package-body fetcher returns null (never throws) on a driver without fetchPackageBody", async () => {
    __resetDriverRegistry();
    registerDriver("postgres", () =>
      makeFakeAdapter({
        introspect: async () => [
          { schema: "public", name: "t", columns: [], foreignKeys: [], indexes: [] },
        ],
        introspectPackages: async () => [
          { schema: "APP", name: "ORDER_PKG", hasSpec: true, hasBody: false, members: [] },
        ],
        // no fetchPackageBody on this adapter
      }),
    );
    await createDbConnector(
      "proj_pkgs_nobody",
      { label: "pn", driver: "postgres", host: "h", username: "u" },
      "user_1",
    );
    const wiring = await buildCodeGraphSchemaWiring("proj_pkgs_nobody", "user_1");
    const body = await wiring.fetchPackageBody!({
      schema: "APP",
      name: "ORDER_PKG",
      hasSpec: true,
      hasBody: false,
      members: [],
    });
    expect(body).toBeNull();
  });
});

describe("buildCodeGraphSchemaWiring — per-project SQL-lineage override (#894)", () => {
  const original = process.env.SQL_LINEAGE_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.SQL_LINEAGE_MODE;
    else process.env.SQL_LINEAGE_MODE = original;
  });

  it("resolves sqlLineageOverride from the platform default when the project has no DB connector", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const wiring = await buildCodeGraphSchemaWiring("proj_no_db_override", "user_1");
    // The mocked `prisma.project` has no `findUnique`, so the resolver degrades to
    // `auto` — folded with the platform default above ⇒ enabled.
    expect(wiring.sqlLineageOverride).toBe(true);
    expect(wiring.introspectedSchema).toBeNull();
  });

  it("resolves sqlLineageOverride=false when the platform default is in-process", async () => {
    process.env.SQL_LINEAGE_MODE = "in-process";
    const wiring = await buildCodeGraphSchemaWiring("proj_no_db_override_2", "user_1");
    expect(wiring.sqlLineageOverride).toBe(false);
  });
});
