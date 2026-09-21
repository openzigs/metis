import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SqlServerDriverAdapter,
  __setMssqlPoolFactory,
  groupMssqlIntrospection,
  mapMssqlRoutines,
  type MssqlPoolLike,
  type MssqlRequestLike,
} from "../src/lib/connectors/db/drivers/sqlserver.js";

function makeRequest(opts: {
  queries: string[];
  recordset?: Record<string, unknown>[];
  fail?: Error;
}): MssqlRequestLike {
  return {
    query: vi.fn(async (sql: string) => {
      opts.queries.push(sql);
      if (opts.fail) throw opts.fail;
      return { recordset: opts.recordset ?? [] };
    }),
  };
}

function makePool(req: MssqlRequestLike): MssqlPoolLike {
  return {
    request: () => req,
    close: vi.fn(async () => {}),
    connected: true,
  };
}

afterEach(() => __setMssqlPoolFactory(null));

describe("SqlServerDriverAdapter", () => {
  it("ping() runs SELECT 1 AS one and returns ms", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries });
    __setMssqlPoolFactory(async () => makePool(req));

    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      password: "p",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const ms = await adapter.ping();
    expect(typeof ms).toBe("number");
    expect(queries).toContain("SELECT 1 AS one");
  });

  it("query() returns shaped rows + columns", async () => {
    const queries: string[] = [];
    const req = makeRequest({
      queries,
      recordset: [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ],
    });
    __setMssqlPoolFactory(async () => makePool(req));

    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      password: "p",
      poolMax: 5,
      statementTimeoutMs: 5000,
    });
    const out = await adapter.query({
      sql: "SELECT TOP (100) * FROM users",
      maxRows: 100,
      statementTimeoutMs: 5000,
    });
    expect(out.columns).toEqual(["id", "name"]);
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });

  it("query() truncates when result exceeds maxRows", async () => {
    const queries: string[] = [];
    const recordset = Array.from({ length: 5 }, (_, i) => ({ i }));
    const req = makeRequest({ queries, recordset });
    __setMssqlPoolFactory(async () => makePool(req));

    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const out = await adapter.query({
      sql: "SELECT TOP (3) * FROM t",
      maxRows: 3,
      statementTimeoutMs: 1000,
    });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(3);
  });

  it("ping() maps login failure to DB_AUTH_FAILED", async () => {
    const queries: string[] = [];
    const req = makeRequest({
      queries,
      fail: new Error("Login failed for user 'u'"),
    });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      password: "wrong",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_AUTH_FAILED" });
  });

  it("ping() maps ECONNREFUSED to DB_CONNECT_FAILED", async () => {
    const queries: string[] = [];
    const fail = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const req = makeRequest({ queries, fail });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_CONNECT_FAILED" });
  });

  it("query() maps timeout to QUERY_TIMEOUT", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries, fail: new Error("Request failed: timeout") });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(
      adapter.query({ sql: "SELECT 1", maxRows: 100, statementTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
  });

  it("introspect() rejects schema names containing single quotes", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.introspect({ schema: "dbo';DROP TABLE x--" })).rejects.toMatchObject({
      code: "INVALID_SCHEMA_NAME",
    });
  });

  it("introspect() returns grouped tables for safe schema name", async () => {
    const queries: string[] = [];
    const req = makeRequest({
      queries,
      recordset: [
        {
          schema_name: "dbo",
          table_name: "users",
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: null,
          pk_name: "PK_users",
          fk_name: null,
          fk_foreign_table: null,
          fk_foreign_column: null,
        },
      ],
    });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const tables = await adapter.introspect({ schema: "dbo" });
    expect(tables).toHaveLength(1);
    expect(tables[0].columns[0].isPrimaryKey).toBe(true);
  });

  it("fetchRoutineBody() reads OBJECT_DEFINITION and never executes the routine (#316B)", async () => {
    const queries: string[] = [];
    const req = makeRequest({
      queries,
      recordset: [{ routine_definition: "CREATE PROCEDURE recalc AS UPDATE orders SET total = 1" }],
    });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const body = await adapter.fetchRoutineBody({
      schema: "dbo",
      name: "recalc",
      type: "procedure",
      signature: "",
    });
    // The query READS the catalog (OBJECT_DEFINITION) via a SELECT — never runs the proc.
    expect(queries[0]).toMatch(/OBJECT_DEFINITION/i);
    expect(queries[0]).toMatch(/^\s*SELECT/i);
    expect(body).toBe("CREATE PROCEDURE recalc AS UPDATE orders SET total = 1");
  });

  it("fetchRoutineBody() rejects an injection-bearing routine name (#316B)", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(
      adapter.fetchRoutineBody({
        schema: "dbo",
        name: "x'); DROP TABLE users--",
        type: "procedure",
        signature: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SCHEMA_NAME" });
    // The hostile name is rejected BEFORE any query is issued.
    expect(queries).toHaveLength(0);
  });

  it("fetchRoutineBody() returns null when OBJECT_DEFINITION is null (encrypted/missing) (#316B)", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries, recordset: [{ routine_definition: null }] });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const body = await adapter.fetchRoutineBody({
      schema: "dbo",
      name: "enc_proc",
      type: "procedure",
      signature: "",
    });
    expect(body).toBeNull();
  });

  it("close() releases the pool", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries });
    const close = vi.fn(async () => {});
    __setMssqlPoolFactory(async () => ({
      request: () => req,
      close,
      connected: true,
    }));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.close();
    expect(close).toHaveBeenCalled();
    // Calling close again is a no-op.
    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("requires init before query/ping/introspect", async () => {
    const adapter = new SqlServerDriverAdapter();
    await expect(
      adapter.query({ sql: "SELECT 1", maxRows: 100, statementTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "DRIVER_UNINITIALIZED" });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DRIVER_UNINITIALIZED" });
    await expect(adapter.introspect()).rejects.toMatchObject({ code: "DRIVER_UNINITIALIZED" });
  });

  it("init() is idempotent", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries });
    let calls = 0;
    __setMssqlPoolFactory(async () => {
      calls += 1;
      return makePool(req);
    });
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    expect(calls).toBe(1);
  });

  it("groupMssqlIntrospection groups columns and FKs by table", () => {
    const tables = groupMssqlIntrospection([
      {
        schema_name: "dbo",
        table_name: "orders",
        column_name: "id",
        data_type: "int",
        is_nullable: "NO",
        column_default: null,
        pk_name: "PK_orders",
        fk_name: null,
        fk_foreign_table: null,
        fk_foreign_column: null,
      },
      {
        schema_name: "dbo",
        table_name: "orders",
        column_name: "user_id",
        data_type: "int",
        is_nullable: "YES",
        column_default: null,
        pk_name: null,
        fk_name: "FK_orders_users",
        fk_foreign_table: "users",
        fk_foreign_column: "id",
      },
    ]);
    expect(tables).toHaveLength(1);
    expect(tables[0].columns).toHaveLength(2);
    expect(tables[0].foreignKeys[0].refTable).toBe("users");
  });

  it("ping() maps ESOCKET to DB_CONNECT_FAILED", async () => {
    const queries: string[] = [];
    const fail = Object.assign(new Error("socket error"), { code: "ESOCKET" });
    const req = makeRequest({ queries, fail });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_CONNECT_FAILED" });
  });

  it("ping() maps ENOTFOUND in message to DB_CONNECT_FAILED", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries, fail: new Error("getaddrinfo ENOTFOUND host") });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_CONNECT_FAILED" });
  });

  it("ping() maps unknown error to DB_ERROR", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries, fail: new Error("something else broke") });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("query() maps generic error to QUERY_FAILED", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries, fail: new Error("invalid object name 'foo'") });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(
      adapter.query({ sql: "SELECT 1", maxRows: 100, statementTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  it("init() falls back to defaults when host/database/username/password unset", async () => {
    const queries: string[] = [];
    let captured: { server?: string; database?: string; user?: string; port?: number } | null =
      null;
    __setMssqlPoolFactory(async (args) => {
      captured = args as unknown as typeof captured;
      return makePool(makeRequest({ queries }));
    });
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({ driver: "sqlserver", poolMax: 5, statementTimeoutMs: 1000 });
    expect(captured!.server).toBe("localhost");
    expect(captured!.port).toBe(1433);
    expect(captured!.database).toBe("");
    expect(captured!.user).toBe("");
  });

  it("introspect() defaults to dbo when schema unset", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.introspect();
    expect(queries[0]).toContain("'dbo'");
  });

  it("introspect() rejects schema with backslash and newline", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.introspect({ schema: "a\\b" })).rejects.toMatchObject({
      code: "INVALID_SCHEMA_NAME",
    });
    await expect(adapter.introspect({ schema: "a\nb" })).rejects.toMatchObject({
      code: "INVALID_SCHEMA_NAME",
    });
  });

  it("introspectRoutines() queries INFORMATION_SCHEMA.ROUTINES and maps rows (#300)", async () => {
    const queries: string[] = [];
    const req = makeRequest({
      queries,
      recordset: [
        {
          schema_name: "dbo",
          routine_name: "GetTotal",
          routine_type: "FUNCTION",
          return_type: "int",
        },
        {
          schema_name: "dbo",
          routine_name: "DoSync",
          routine_type: "PROCEDURE",
          return_type: null,
        },
      ],
    });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const routines = await adapter.introspectRoutines({ schema: "dbo" });
    expect(queries[0]).toContain("INFORMATION_SCHEMA.ROUTINES");
    expect(queries[0]).toContain("'dbo'");
    expect(queries[0]).not.toMatch(/ROUTINE_DEFINITION/i);
    expect(routines).toEqual([
      { schema: "dbo", name: "GetTotal", type: "function", signature: "() RETURNS int" },
      { schema: "dbo", name: "DoSync", type: "procedure", signature: "()" },
    ]);
  });

  it("introspectRoutines() rejects a schema name containing a single quote (#300)", async () => {
    const queries: string[] = [];
    const req = makeRequest({ queries });
    __setMssqlPoolFactory(async () => makePool(req));
    const adapter = new SqlServerDriverAdapter();
    await adapter.init({
      driver: "sqlserver",
      host: "x",
      port: 1433,
      database: "y",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.introspectRoutines({ schema: "a'; DROP--" })).rejects.toMatchObject({
      code: "INVALID_SCHEMA_NAME",
    });
  });
});

describe("mapMssqlRoutines", () => {
  it("maps a procedure with a null return type to an empty signature", () => {
    expect(
      mapMssqlRoutines([
        { schema_name: "dbo", routine_name: "p", routine_type: "PROCEDURE", return_type: null },
      ]),
    ).toEqual([{ schema: "dbo", name: "p", type: "procedure", signature: "()" }]);
  });
});
