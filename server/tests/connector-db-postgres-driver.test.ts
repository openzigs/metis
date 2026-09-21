import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PostgresDriverAdapter,
  __setPostgresPoolFactory,
  groupPostgresIntrospection,
  mapPostgresRoutines,
  type PgPoolLike,
  type PgClientLike,
} from "../src/lib/connectors/db/drivers/postgres.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

interface FakeClientCalls {
  queries: string[];
}

function makeClient(opts: {
  queries: FakeClientCalls;
  rows?: Record<string, unknown>[];
  fields?: { name: string }[];
  fail?: Error;
}): PgClientLike {
  return {
    query: vi.fn(async (sql: string) => {
      opts.queries.queries.push(sql);
      if (opts.fail) throw opts.fail;
      return {
        rows: opts.rows ?? [],
        fields: opts.fields ?? [],
        rowCount: opts.rows?.length ?? 0,
      } as unknown as Awaited<ReturnType<PgClientLike["query"]>>;
    }),
    release: vi.fn(),
  };
}

function makePool(client: PgClientLike, poolQuery?: () => Promise<unknown>): PgPoolLike {
  return {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => {}),
    query: vi.fn(async (_sql: string) =>
      poolQuery ? ((await poolQuery()) as never) : ({ rows: [], fields: [] } as never),
    ),
  };
}

afterEach(() => {
  __setPostgresPoolFactory(null);
});

describe("PostgresDriverAdapter", () => {
  it("ping() opens a client, runs SELECT 1, and returns ms", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    __setPostgresPoolFactory(() => makePool(client));

    const adapter = new PostgresDriverAdapter();
    await adapter.init({
      host: "db.example",
      port: 5432,
      database: "app",
      username: "u",
      password: "p",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const ms = await adapter.ping();
    expect(typeof ms).toBe("number");
    expect(queries.queries).toContain("SELECT 1");
  });

  it("query() sets read-only + statement_timeout and returns shaped rows", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const rows = [
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ];
    const client = makeClient({ queries, rows, fields: [{ name: "id" }, { name: "name" }] });
    __setPostgresPoolFactory(() => makePool(client));

    const adapter = new PostgresDriverAdapter();
    await adapter.init({
      host: "db.example",
      port: 5432,
      database: "app",
      username: "u",
      password: "p",
      poolMax: 5,
      statementTimeoutMs: 5000,
    });

    const out = await adapter.query({
      sql: "SELECT id, name FROM users LIMIT 100",
      maxRows: 100,
      statementTimeoutMs: 5000,
    });

    expect(queries.queries).toContain("SET TRANSACTION READ ONLY");
    expect(queries.queries.find((q) => /SET LOCAL statement_timeout/.test(q))).toBeTruthy();
    expect(out.columns).toEqual(["id", "name"]);
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });

  it("query() truncates when result exceeds maxRows", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const client = makeClient({ queries, rows, fields: [{ name: "id" }] });
    __setPostgresPoolFactory(() => makePool(client));

    const adapter = new PostgresDriverAdapter();
    await adapter.init({
      host: "x",
      port: 5432,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const out = await adapter.query({ sql: "SELECT 1", maxRows: 3, statementTimeoutMs: 1000 });
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(3);
  });

  it("ping() maps ENOTFOUND to DB_CONNECT_FAILED", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const fail = Object.assign(new Error("getaddrinfo ENOTFOUND nope"), { code: "ENOTFOUND" });
    const client = makeClient({ queries, fail });
    __setPostgresPoolFactory(() => makePool(client));

    const adapter = new PostgresDriverAdapter();
    await adapter.init({
      host: "nope",
      port: 5432,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({
      code: "DB_CONNECT_FAILED",
    });
  });

  it("close() releases the pool and unsets it", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    const pool = makePool(client);
    __setPostgresPoolFactory(() => pool);
    const adapter = new PostgresDriverAdapter();
    await adapter.init({
      host: "x",
      port: 5432,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.close();
    expect(pool.end).toHaveBeenCalled();
    // double close is safe
    await adapter.close();
  });

  it("ping() rejects DRIVER_UNINITIALIZED before init", async () => {
    const adapter = new PostgresDriverAdapter();
    await expect(adapter.ping()).rejects.toBeInstanceOf(ConnectorError);
  });

  it("init() is idempotent (subsequent calls reuse pool)", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    const factory = vi.fn(() => makePool(client));
    __setPostgresPoolFactory(factory);
    const adapter = new PostgresDriverAdapter();
    await adapter.init({
      host: "x",
      port: 5432,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.init({
      host: "x",
      port: 5432,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("introspect() runs the schema query and groups rows", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    const pool: import("../src/lib/connectors/db/drivers/postgres.js").PgPoolLike = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {}),
      query: vi.fn(async () => ({
        rows: [
          {
            schema_name: "public",
            table_name: "t1",
            column_name: "id",
            data_type: "int",
            is_nullable: "NO",
            column_default: null,
            pk_name: "t1_pk",
            fk_name: null,
            fk_foreign_table: null,
            fk_foreign_column: null,
            index_name: null,
            index_columns: null,
            index_unique: null,
          },
        ],
        fields: [],
        rowCount: 1,
      })) as never,
    };
    __setPostgresPoolFactory(() => pool);
    const adapter = new PostgresDriverAdapter();
    await adapter.init({
      host: "x",
      port: 5432,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const tables = await adapter.introspect({ schema: "public" });
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("t1");
  });
});

describe("PostgresDriverAdapter — fetchRoutineBody (#316B)", () => {
  it("reads the routine body via a parameterized SELECT (read-only, no injection)", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    let capturedSql = "";
    let capturedParams: unknown[] | undefined;
    const pool: PgPoolLike = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {}),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [{ routine_definition: "BEGIN UPDATE orders SET total = 1; END;" }],
          fields: [],
          rowCount: 1,
        } as never;
      }),
    };
    __setPostgresPoolFactory(() => pool);
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });

    const body = await adapter.fetchRoutineBody({
      schema: "app",
      name: "recalc",
      type: "procedure",
      signature: "",
    });

    // Schema + name are bound as $1/$2 — never string-concatenated.
    expect(capturedSql).toContain("$1");
    expect(capturedSql).toContain("$2");
    expect(capturedParams).toEqual(["app", "recalc"]);
    // The query READS the catalog; it is a SELECT, never executing the routine.
    expect(capturedSql).toMatch(/^\s*SELECT/i);
    expect(body).toBe("BEGIN UPDATE orders SET total = 1; END;");
  });

  it("returns null when the routine body is not found", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    const pool: PgPoolLike = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {}),
      query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }) as never),
    };
    __setPostgresPoolFactory(() => pool);
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });
    const body = await adapter.fetchRoutineBody({
      schema: "app",
      name: "ghost",
      type: "function",
      signature: "",
    });
    expect(body).toBeNull();
  });
});

describe("groupPostgresIntrospection", () => {
  it("groups column rows into table objects with PK/FK/index info", () => {
    const rows = [
      {
        schema_name: "public",
        table_name: "users",
        column_name: "id",
        data_type: "int",
        is_nullable: "NO",
        column_default: null,
        pk_name: "users_pk",
        fk_name: null,
        fk_foreign_table: null,
        fk_foreign_column: null,
        index_name: "users_pk",
        index_columns: "(id)",
        index_unique: "YES",
      },
      {
        schema_name: "public",
        table_name: "users",
        column_name: "team_id",
        data_type: "int",
        is_nullable: "YES",
        column_default: null,
        pk_name: null,
        fk_name: "users_team_fk",
        fk_foreign_table: "teams",
        fk_foreign_column: "id",
        index_name: null,
        index_columns: null,
        index_unique: null,
      },
    ];
    const grouped = groupPostgresIntrospection(rows);
    expect(grouped).toHaveLength(1);
    const t = grouped[0];
    expect(t.name).toBe("users");
    expect(t.columns).toHaveLength(2);
    expect(t.primaryKey).toEqual(["id"]);
    expect(t.foreignKeys).toHaveLength(1);
    expect(t.foreignKeys[0].refTable).toBe("teams");
    expect(t.indexes).toHaveLength(1);
    expect(t.indexes[0].isUnique).toBe(true);
    expect(t.indexes[0].columns).toEqual(["id"]);
  });
});

describe("PostgresDriverAdapter — coverage uplift", () => {
  it("ping() maps 'authentication failed' to DB_AUTH_FAILED", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const fail = new Error("authentication failed for user 'x'");
    const client = makeClient({ queries, fail });
    __setPostgresPoolFactory(() => makePool(client));
    const adapter = new PostgresDriverAdapter();
    await adapter.init({
      driver: "postgres",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_AUTH_FAILED" });
  });

  it("ping() maps unknown error to DB_ERROR", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const fail = new Error("something broke");
    const client = makeClient({ queries, fail });
    __setPostgresPoolFactory(() => makePool(client));
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("query() maps 'statement timeout' to QUERY_TIMEOUT", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const fail = new Error("canceling statement due to statement timeout");
    const client = makeClient({ queries, fail });
    __setPostgresPoolFactory(() => makePool(client));
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });
    await expect(
      adapter.query({ sql: "SELECT 1", maxRows: 100, statementTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
  });

  it("query() maps generic error to QUERY_FAILED", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const fail = new Error("syntax error at or near 'foo'");
    const client = makeClient({ queries, fail });
    __setPostgresPoolFactory(() => makePool(client));
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });
    await expect(
      adapter.query({ sql: "SELECT 1", maxRows: 100, statementTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  it("init() applies defaults when host/port/database/username unset", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    let capturedArgs: Record<string, unknown> | null = null;
    __setPostgresPoolFactory((args) => {
      capturedArgs = args as unknown as Record<string, unknown>;
      return makePool(client);
    });
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });
    expect(capturedArgs!.host).toBe("localhost");
    expect(capturedArgs!.port).toBe(5432);
    expect(capturedArgs!.database).toBe("postgres");
    expect(capturedArgs!.user).toBe("postgres");
  });

  it("close() swallows pool.end() errors", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    const pool: import("../src/lib/connectors/db/drivers/postgres.js").PgPoolLike = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {
        throw new Error("close exploded");
      }),
      query: vi.fn(async () => ({ rows: [], fields: [] }) as never),
    };
    __setPostgresPoolFactory(() => pool);
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe("groupPostgresIntrospection — branches", () => {
  it("returns empty array on no rows", () => {
    expect(groupPostgresIntrospection([])).toEqual([]);
  });
});

describe("PostgresDriverAdapter — introspectRoutines (#300)", () => {
  it("runs a parameterized routines query bound to the schema and maps rows", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    let capturedSql = "";
    let capturedParams: unknown[] | undefined;
    const pool: PgPoolLike = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {}),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [
            {
              schema_name: "public",
              routine_name: "calc_total",
              routine_type: "FUNCTION",
              args: "p_id integer",
              result: "numeric",
            },
            {
              schema_name: "public",
              routine_name: "do_thing",
              routine_type: "PROCEDURE",
              args: "",
              result: null,
            },
          ],
          fields: [],
          rowCount: 2,
        } as never;
      }),
    };
    __setPostgresPoolFactory(() => pool);
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });
    const routines = await adapter.introspectRoutines({ schema: "public" });

    // Schema is bound as a parameter ($1) — never interpolated (no SQL injection).
    expect(capturedSql).toContain("$1");
    expect(capturedParams).toEqual(["public"]);
    // Body is never selected.
    expect(capturedSql).not.toMatch(/routine_definition|prosrc/i);
    expect(routines).toEqual([
      {
        schema: "public",
        name: "calc_total",
        type: "function",
        signature: "(p_id integer) RETURNS numeric",
      },
      { schema: "public", name: "do_thing", type: "procedure", signature: "()" },
    ]);
  });

  it("defaults to the public schema when none is given", async () => {
    const queries: FakeClientCalls = { queries: [] };
    const client = makeClient({ queries });
    let capturedParams: unknown[] | undefined;
    const pool: PgPoolLike = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {}),
      query: vi.fn(async (_sql: string, params?: unknown[]) => {
        capturedParams = params;
        return { rows: [], fields: [], rowCount: 0 } as never;
      }),
    };
    __setPostgresPoolFactory(() => pool);
    const adapter = new PostgresDriverAdapter();
    await adapter.init({ driver: "postgres", poolMax: 5, statementTimeoutMs: 1000 });
    const routines = await adapter.introspectRoutines();
    expect(capturedParams).toEqual(["public"]);
    expect(routines).toEqual([]);
  });
});

describe("mapPostgresRoutines", () => {
  it("treats non-PROCEDURE types as functions and omits empty-arg parens correctly", () => {
    const out = mapPostgresRoutines([
      { schema_name: "s", routine_name: "f", routine_type: "FUNCTION", args: null, result: null },
    ]);
    expect(out).toEqual([{ schema: "s", name: "f", type: "function", signature: "()" }]);
  });
});
