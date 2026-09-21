import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MySqlDriverAdapter,
  __setMysqlPoolFactory,
  groupMysqlIntrospection,
  mapMysqlRoutines,
  type MySqlPoolLike,
  type MySqlConnLike,
} from "../src/lib/connectors/db/drivers/mysql.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

function makeConn(opts: {
  queries: string[];
  rows?: Record<string, unknown>[];
  fields?: { name: string }[];
  fail?: Error;
}): MySqlConnLike {
  return {
    query: vi.fn(async (sql: string) => {
      opts.queries.push(sql);
      if (opts.fail) throw opts.fail;
      return [opts.rows ?? [], opts.fields ?? []] as [
        Record<string, unknown>[],
        { name: string }[],
      ];
    }),
    release: vi.fn(),
  };
}

function makePool(conn: MySqlConnLike): MySqlPoolLike {
  return {
    getConnection: vi.fn(async () => conn),
    query: vi.fn(async () => [[], []]),
    end: vi.fn(async () => {}),
  };
}

afterEach(() => __setMysqlPoolFactory(null));

describe("MySqlDriverAdapter", () => {
  it("ping() runs SELECT 1", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries });
    __setMysqlPoolFactory(() => makePool(conn));

    const adapter = new MySqlDriverAdapter();
    await adapter.init({
      host: "x",
      port: 3306,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.ping();
    expect(queries).toContain("SELECT 1");
  });

  it("query() injects MAX_EXECUTION_TIME hint and sets read-only", async () => {
    const queries: string[] = [];
    const rows = [{ id: 1 }];
    const conn = makeConn({ queries, rows, fields: [{ name: "id" }] });
    __setMysqlPoolFactory(() => makePool(conn));

    const adapter = new MySqlDriverAdapter();
    await adapter.init({
      host: "x",
      port: 3306,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 5000,
    });
    const out = await adapter.query({
      sql: "SELECT * FROM users",
      maxRows: 100,
      statementTimeoutMs: 5000,
    });
    expect(queries).toContain("SET SESSION TRANSACTION READ ONLY");
    expect(queries.some((q) => /MAX_EXECUTION_TIME\(5000\)/.test(q))).toBe(true);
    expect(out.rows).toEqual(rows);
    expect(out.columns).toEqual(["id"]);
  });

  it("ping() maps connection errors", async () => {
    const queries: string[] = [];
    const conn = makeConn({
      queries,
      fail: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    __setMysqlPoolFactory(() => makePool(conn));
    const adapter = new MySqlDriverAdapter();
    await adapter.init({
      host: "x",
      port: 3306,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_CONNECT_FAILED" });
  });

  it("requires init before use", async () => {
    const adapter = new MySqlDriverAdapter();
    await expect(adapter.ping()).rejects.toBeInstanceOf(ConnectorError);
  });

  it("introspect() runs the schema query and groups rows", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries });
    const pool: MySqlPoolLike = {
      getConnection: vi.fn(async () => conn),
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [
          [
            {
              schema_name: "app",
              table_name: "t1",
              column_name: "id",
              data_type: "int",
              is_nullable: "NO",
              column_default: null,
              column_key: "PRI",
              fk_name: null,
              fk_foreign_table: null,
              fk_foreign_column: null,
              index_name: "PRIMARY",
              index_column: "id",
              index_non_unique: 0,
            },
          ],
          [],
        ];
      }),
      end: vi.fn(async () => {}),
    };
    __setMysqlPoolFactory(() => pool);
    const adapter = new MySqlDriverAdapter();
    await adapter.init({
      host: "x",
      port: 3306,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const tables = await adapter.introspect({ schema: "app" });
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("t1");
  });

  it("introspectRoutines() binds an explicit schema as a parameter and maps rows (#300)", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] | undefined;
    const pool: MySqlPoolLike = {
      getConnection: vi.fn(async () => makeConn({ queries: [] })),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return [
          [
            {
              schema_name: "app",
              routine_name: "calc",
              routine_type: "FUNCTION",
              return_type: "decimal",
            },
            {
              schema_name: "app",
              routine_name: "sync",
              routine_type: "PROCEDURE",
              return_type: null,
            },
          ],
          [],
        ];
      }),
      end: vi.fn(async () => {}),
    };
    __setMysqlPoolFactory(() => pool);
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    const routines = await adapter.introspectRoutines({ schema: "app" });

    expect(capturedSql).toContain("?");
    expect(capturedParams).toEqual(["app"]);
    expect(capturedSql).not.toMatch(/routine_definition/i);
    expect(routines).toEqual([
      { schema: "app", name: "calc", type: "function", signature: "() RETURNS decimal" },
      { schema: "app", name: "sync", type: "procedure", signature: "()" },
    ]);
  });

  it("introspectRoutines() uses DATABASE() with no params when schema is unset (#300)", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] | undefined;
    const pool: MySqlPoolLike = {
      getConnection: vi.fn(async () => makeConn({ queries: [] })),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return [[], []];
      }),
      end: vi.fn(async () => {}),
    };
    __setMysqlPoolFactory(() => pool);
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    const routines = await adapter.introspectRoutines();
    expect(capturedSql).toContain("DATABASE()");
    expect(capturedParams).toEqual([]);
    expect(routines).toEqual([]);
  });

  it("fetchRoutineBody() binds schema + name as parameters (read-only, no injection) (#316B)", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] | undefined;
    const pool: MySqlPoolLike = {
      getConnection: vi.fn(async () => makeConn({ queries: [] })),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return [[{ routine_definition: "BEGIN UPDATE orders SET total = 1; END" }], []];
      }),
      end: vi.fn(async () => {}),
    };
    __setMysqlPoolFactory(() => pool);
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    const body = await adapter.fetchRoutineBody({
      schema: "app",
      name: "recalc",
      type: "procedure",
      signature: "",
    });
    expect(capturedSql).toContain("?");
    expect(capturedParams).toEqual(["app", "recalc"]);
    expect(capturedSql).toMatch(/^\s*SELECT/i);
    expect(body).toBe("BEGIN UPDATE orders SET total = 1; END");
  });

  it("fetchRoutineBody() returns null when the routine is not found (#316B)", async () => {
    const pool: MySqlPoolLike = {
      getConnection: vi.fn(async () => makeConn({ queries: [] })),
      query: vi.fn(async () => [[], []]),
      end: vi.fn(async () => {}),
    };
    __setMysqlPoolFactory(() => pool);
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    const body = await adapter.fetchRoutineBody({
      schema: "app",
      name: "ghost",
      type: "function",
      signature: "",
    });
    expect(body).toBeNull();
  });

  it("close() releases the pool and is safe to call twice", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries });
    const pool = makePool(conn);
    __setMysqlPoolFactory(() => pool);
    const adapter = new MySqlDriverAdapter();
    await adapter.init({
      host: "x",
      port: 3306,
      database: "y",
      username: "z",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.close();
    expect(pool.end).toHaveBeenCalled();
    await adapter.close();
  });
});

describe("groupMysqlIntrospection", () => {
  it("collects columns, FKs, and indexes per table", () => {
    const grouped = groupMysqlIntrospection([
      {
        schema_name: "app",
        table_name: "orders",
        column_name: "id",
        data_type: "int",
        is_nullable: "NO",
        column_default: null,
        column_key: "PRI",
        fk_name: null,
        fk_foreign_table: null,
        fk_foreign_column: null,
        index_name: "PRIMARY",
        index_column: "id",
        index_non_unique: 0,
      },
      {
        schema_name: "app",
        table_name: "orders",
        column_name: "user_id",
        data_type: "int",
        is_nullable: "YES",
        column_default: null,
        column_key: "MUL",
        fk_name: "fk_orders_user",
        fk_foreign_table: "users",
        fk_foreign_column: "id",
        index_name: null,
        index_column: null,
        index_non_unique: null,
      },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].name).toBe("orders");
    expect(grouped[0].columns.map((c) => c.name)).toEqual(["id", "user_id"]);
    expect(grouped[0].foreignKeys[0].refTable).toBe("users");
    expect(grouped[0].indexes[0].name).toBe("PRIMARY");
    expect(grouped[0].indexes[0].isUnique).toBe(true);
  });
});

describe("MySqlDriverAdapter — coverage uplift", () => {
  it("ping() maps 'access denied' to DB_AUTH_FAILED", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries, fail: new Error("ER_ACCESS_DENIED_ERROR: Access denied") });
    __setMysqlPoolFactory(() => makePool(conn));
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_AUTH_FAILED" });
  });

  it("ping() maps generic error to DB_ERROR", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries, fail: new Error("server has gone away") });
    __setMysqlPoolFactory(() => makePool(conn));
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("query() maps execution timeout to QUERY_TIMEOUT", async () => {
    const queries: string[] = [];
    const conn = makeConn({
      queries,
      fail: new Error("Query execution was interrupted, exceeded max_execution_time"),
    });
    __setMysqlPoolFactory(() => makePool(conn));
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    await expect(
      adapter.query({ sql: "SELECT 1", maxRows: 100, statementTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
  });

  it("query() maps generic error to QUERY_FAILED", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries, fail: new Error("syntax error") });
    __setMysqlPoolFactory(() => makePool(conn));
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    await expect(
      adapter.query({ sql: "SELECT 1", maxRows: 100, statementTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  it("query() truncates oversize results", async () => {
    const queries: string[] = [];
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const conn = makeConn({ queries, rows, fields: [{ name: "id" }] });
    __setMysqlPoolFactory(() => makePool(conn));
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    const out = await adapter.query({ sql: "SELECT 1", maxRows: 3, statementTimeoutMs: 1000 });
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(3);
  });

  it("init() applies defaults when host/port/database/username unset", async () => {
    let captured: Record<string, unknown> | null = null;
    __setMysqlPoolFactory((args) => {
      captured = args as unknown as Record<string, unknown>;
      return makePool(makeConn({ queries: [] }));
    });
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    expect(captured!.host).toBe("localhost");
    expect(captured!.port).toBe(3306);
  });

  it("introspect() with default DATABASE() schema runs the no-arg query", async () => {
    let receivedSql = "";
    let receivedParams: unknown[] | undefined;
    const pool: MySqlPoolLike = {
      getConnection: vi.fn(),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        receivedSql = sql;
        receivedParams = params;
        return [[], []];
      }) as never,
      end: vi.fn(async () => {}),
    };
    __setMysqlPoolFactory(() => pool);
    const adapter = new MySqlDriverAdapter();
    await adapter.init({ poolMax: 5, statementTimeoutMs: 1000 });
    await adapter.introspect();
    expect(receivedSql).toContain("DATABASE()");
    expect(receivedParams).toEqual([]);
  });
});

describe("mapMysqlRoutines", () => {
  it("maps a function with a null return type to an empty-arg signature", () => {
    expect(
      mapMysqlRoutines([
        { schema_name: "s", routine_name: "f", routine_type: "FUNCTION", return_type: null },
      ]),
    ).toEqual([{ schema: "s", name: "f", type: "function", signature: "()" }]);
  });
});
