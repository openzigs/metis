import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OracleDriverAdapter,
  __setOraclePoolFactory,
  groupOracleIntrospection,
  mapOracleDependencies,
  mapOraclePackages,
  mapOracleRoutines,
  type OracleConnectionLike,
  type OraclePoolLike,
} from "../src/lib/connectors/db/drivers/oracle.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

function makeConn(opts: {
  queries: string[];
  rows?: Record<string, unknown>[];
  meta?: { name: string }[];
  fail?: Error;
}): OracleConnectionLike {
  return {
    execute: vi.fn(async (sql: string) => {
      opts.queries.push(sql);
      if (opts.fail) throw opts.fail;
      return { rows: opts.rows ?? [], metaData: opts.meta ?? [] };
    }),
    close: vi.fn(async () => {}),
  };
}

function makePool(conn: OracleConnectionLike): OraclePoolLike {
  return {
    getConnection: vi.fn(async () => conn),
    close: vi.fn(async () => {}),
  };
}

afterEach(() => __setOraclePoolFactory(null));

describe("OracleDriverAdapter", () => {
  it("ping() runs SELECT 1 FROM DUAL", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries });
    __setOraclePoolFactory(async () => makePool(conn));

    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      password: "p",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.ping();
    expect(queries).toContain("SELECT 1 FROM DUAL");
  });

  it("query() applies SET TRANSACTION READ ONLY and returns shaped rows", async () => {
    const queries: string[] = [];
    const rows = [{ ID: 1 }];
    const conn = makeConn({ queries, rows, meta: [{ name: "ID" }] });
    __setOraclePoolFactory(async () => makePool(conn));

    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      password: "p",
      poolMax: 5,
      statementTimeoutMs: 5000,
    });
    const out = await adapter.query({
      sql: "SELECT * FROM dual FETCH FIRST 100 ROWS ONLY",
      maxRows: 100,
      statementTimeoutMs: 5000,
    });
    expect(queries).toContain("SET TRANSACTION READ ONLY");
    expect(out.columns).toEqual(["ID"]);
    expect(out.rows).toEqual(rows);
  });

  it("ping() maps ORA-01017 to DB_AUTH_FAILED", async () => {
    const queries: string[] = [];
    const conn = makeConn({
      queries,
      fail: new Error("ORA-01017: invalid username/password; logon denied"),
    });
    __setOraclePoolFactory(async () => makePool(conn));

    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      password: "wrong",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_AUTH_FAILED" });
  });

  it("query() maps ORA-01013 to QUERY_TIMEOUT", async () => {
    const queries: string[] = [];
    let calls = 0;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string) => {
        queries.push(sql);
        calls += 1;
        if (calls === 1) return { rows: [], metaData: [] }; // SET TXN
        throw new Error("ORA-01013: user requested cancel of current operation");
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));

    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1,
    });
    await expect(
      adapter.query({ sql: "SELECT 1 FROM dual", maxRows: 100, statementTimeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
  });

  it("close() is idempotent", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries });
    const pool = makePool(conn);
    __setOraclePoolFactory(async () => pool);
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.close();
    await adapter.close();
    expect(pool.close).toHaveBeenCalledTimes(1);
  });

  it("requires init before use", async () => {
    const adapter = new OracleDriverAdapter();
    await expect(adapter.ping()).rejects.toBeInstanceOf(ConnectorError);
  });

  it("introspect() returns grouped tables (USER variant)", async () => {
    const queries: string[] = [];
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string) => {
        queries.push(sql);
        return {
          rows: [
            {
              OWNER: "APP",
              TABLE_NAME: "T",
              COLUMN_NAME: "ID",
              DATA_TYPE: "NUMBER",
              NULLABLE: "N",
              DATA_DEFAULT: null,
              PK_NAME: "T_PK",
              FK_NAME: null,
              FK_FOREIGN_TABLE: null,
              FK_FOREIGN_COLUMN: null,
            },
          ],
          metaData: [],
        };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const tables = await adapter.introspect();
    expect(tables).toHaveLength(1);
    expect(tables[0].schema).toBe("APP");
  });

  it("introspect({schema}) emits a well-formed owner-bound ALL_* query", async () => {
    const queries: string[] = [];
    let capturedParams: unknown[] | undefined;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        capturedParams = params;
        return { rows: [], metaData: [] };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.introspect({ schema: "salesdb" });

    const sql = queries[0];
    // Owner is upper-cased and bound as :1 — never interpolated.
    expect(capturedParams).toEqual(["SALESDB"]);
    expect(sql).not.toMatch(/SALESDB/i);

    // The owner-scoped variant must read the ALL_* catalog views throughout.
    // Constraint sub-selects reading USER_* only ever see the *connected*
    // user's objects, so cross-schema PK/FK data would come back empty.
    expect(sql).toContain("ALL_TAB_COLUMNS");
    expect(sql).toContain("ALL_CONS_COLUMNS");
    expect(sql).toContain("ALL_CONSTRAINTS");
    expect(sql).not.toMatch(/USER_TAB_COLUMNS|USER_CONS_COLUMNS|USER_CONSTRAINTS/);

    // Regression: the WHERE that scopes the driving table must come *after*
    // both LEFT JOINs. Splicing it onto the FROM clause produced ORA-00933
    // ("SQL command not properly ended") against a real database.
    const fromIdx = sql.indexOf("FROM ALL_TAB_COLUMNS c");
    const lastJoinIdx = sql.lastIndexOf("LEFT JOIN");
    const outerWhereIdx = sql.indexOf("WHERE c.OWNER = :1");
    const orderByIdx = sql.indexOf("ORDER BY");
    expect(fromIdx).toBeGreaterThan(-1);
    expect(outerWhereIdx).toBeGreaterThan(lastJoinIdx);
    expect(orderByIdx).toBeGreaterThan(outerWhereIdx);
  });

  it("introspectRoutines() binds owner as a parameter for an explicit schema (#300)", async () => {
    const queries: string[] = [];
    let capturedParams: unknown[] | undefined;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        capturedParams = params;
        return {
          rows: [
            { OWNER: "APP", OBJECT_NAME: "CALC_TOTAL", OBJECT_TYPE: "FUNCTION" },
            { OWNER: "APP", OBJECT_NAME: "DO_SYNC", OBJECT_TYPE: "PROCEDURE" },
          ],
          metaData: [],
        };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const routines = await adapter.introspectRoutines({ schema: "app" });
    // Owner is upper-cased and bound as :1 — never interpolated.
    expect(queries[0]).toContain(":1");
    expect(queries[0]).toContain("ALL_OBJECTS");
    expect(capturedParams).toEqual(["APP"]);
    expect(queries[0]).not.toMatch(/ALL_SOURCE/i);
    expect(routines).toEqual([
      { schema: "APP", name: "CALC_TOTAL", type: "function", signature: "" },
      { schema: "APP", name: "DO_SYNC", type: "procedure", signature: "" },
    ]);
  });

  it("introspectRoutines() uses USER_OBJECTS with no params when schema unset (#300)", async () => {
    const queries: string[] = [];
    let capturedParams: unknown[] | undefined;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        capturedParams = params;
        return { rows: [], metaData: [] };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const routines = await adapter.introspectRoutines();
    expect(queries[0]).toContain("USER_OBJECTS");
    expect(capturedParams).toEqual([]);
    expect(routines).toEqual([]);
  });

  it("fetchRoutineBody() reads ALL_SOURCE bound to owner+name and assembles the body (#316B)", async () => {
    const queries: string[] = [];
    let capturedParams: unknown[] | undefined;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        capturedParams = params;
        return {
          rows: [
            { TEXT: "PROCEDURE recalc AS\n" },
            { TEXT: "BEGIN UPDATE orders SET total = 1; END;" },
          ],
          metaData: [],
        };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const body = await adapter.fetchRoutineBody({
      schema: "app",
      name: "recalc",
      type: "procedure",
      signature: "",
    });
    // Owner + name upper-cased and bound as :1/:2 — never interpolated.
    expect(queries[0]).toContain(":1");
    expect(queries[0]).toContain(":2");
    expect(queries[0]).toMatch(/ALL_SOURCE/i);
    expect(queries[0]).toMatch(/^\s*SELECT/i);
    expect(capturedParams).toEqual(["APP", "RECALC"]);
    // Lines are concatenated in LINE order, with a CREATE prefix so the sidecar
    // parses it as a routine definition.
    expect(body).toBe("CREATE PROCEDURE recalc AS\nBEGIN UPDATE orders SET total = 1; END;");
  });

  it("fetchRoutineBody() returns null when ALL_SOURCE yields no rows (#316B)", async () => {
    const conn = makeConn({ queries: [], rows: [] });
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const body = await adapter.fetchRoutineBody({
      schema: "app",
      name: "ghost",
      type: "function",
      signature: "",
    });
    expect(body).toBeNull();
  });

  it("introspectDependencies() binds owner as a parameter for an explicit schema (#890)", async () => {
    const queries: string[] = [];
    let capturedParams: unknown[] | undefined;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        capturedParams = params;
        return {
          rows: [
            {
              OWNER: "APP",
              NAME: "CALC_TOTAL",
              TYPE: "PACKAGE",
              REFERENCED_OWNER: "APP",
              REFERENCED_NAME: "ORDERS",
              REFERENCED_TYPE: "TABLE",
            },
          ],
          metaData: [],
        };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const deps = await adapter.introspectDependencies({ schema: "app" });
    // Owner is upper-cased and bound as :1 — never interpolated.
    expect(queries[0]).toContain(":1");
    expect(queries[0]).toContain("ALL_DEPENDENCIES");
    expect(queries[0]).not.toMatch(/DBA_DEPENDENCIES/i);
    expect(capturedParams).toEqual(["APP"]);
    expect(deps).toEqual([
      {
        schema: "APP",
        name: "CALC_TOTAL",
        type: "PACKAGE",
        referencedSchema: "APP",
        referencedName: "ORDERS",
        referencedType: "TABLE",
      },
    ]);
  });

  it("introspectDependencies() uses USER_DEPENDENCIES with no params when schema unset (#890)", async () => {
    const queries: string[] = [];
    let capturedParams: unknown[] | undefined;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        capturedParams = params;
        return { rows: [], metaData: [] };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const deps = await adapter.introspectDependencies();
    expect(queries[0]).toContain("USER_DEPENDENCIES");
    expect(capturedParams).toEqual([]);
    expect(deps).toEqual([]);
  });

  it("introspectDependencies({allowDba: true}) tries DBA_DEPENDENCIES first, owner-bound (#890)", async () => {
    const queries: string[] = [];
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string) => {
        queries.push(sql);
        return {
          rows: [
            {
              OWNER: "APP",
              NAME: "CALC_TOTAL",
              TYPE: "PROCEDURE",
              REFERENCED_OWNER: "OTHER_SCHEMA",
              REFERENCED_NAME: "SECRET_TABLE",
              REFERENCED_TYPE: "TABLE",
            },
          ],
          metaData: [],
        };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const deps = await adapter.introspectDependencies({ schema: "app", allowDba: true });
    expect(queries[0]).toMatch(/DBA_DEPENDENCIES/i);
    expect(queries).toHaveLength(1); // no fallback query needed — DBA succeeded
    expect(deps[0].referencedSchema).toBe("OTHER_SCHEMA");
  });

  it("introspectDependencies({allowDba: true}) degrades to ALL_DEPENDENCIES on ORA-00942 (#890)", async () => {
    const queries: string[] = [];
    let calls = 0;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string) => {
        queries.push(sql);
        calls += 1;
        if (calls === 1) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        return {
          rows: [
            {
              OWNER: "APP",
              NAME: "CALC_TOTAL",
              TYPE: "PROCEDURE",
              REFERENCED_OWNER: "APP",
              REFERENCED_NAME: "ORDERS",
              REFERENCED_TYPE: "TABLE",
            },
          ],
          metaData: [],
        };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const deps = await adapter.introspectDependencies({ schema: "app", allowDba: true });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/DBA_DEPENDENCIES/i);
    expect(queries[1]).toMatch(/ALL_DEPENDENCIES/i);
    expect(queries[1]).not.toMatch(/DBA_DEPENDENCIES/i);
    expect(deps).toHaveLength(1);
  });

  it("introspectDependencies() never attempts DBA_DEPENDENCIES when allowDba is unset (#890)", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries, rows: [] });
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.introspectDependencies({ schema: "app" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/DBA_DEPENDENCIES/i);
  });
});

describe("mapOracleRoutines", () => {
  it("defaults non-FUNCTION object types to procedure with an empty signature", () => {
    expect(
      mapOracleRoutines([{ OWNER: "APP", OBJECT_NAME: "P", OBJECT_TYPE: "PROCEDURE" }]),
    ).toEqual([{ schema: "APP", name: "P", type: "procedure", signature: "" }]);
  });
});

describe("mapOracleDependencies (#890)", () => {
  it("maps a well-formed row verbatim", () => {
    expect(
      mapOracleDependencies([
        {
          OWNER: "APP",
          NAME: "CALC_TOTAL",
          TYPE: "PACKAGE",
          REFERENCED_OWNER: "APP",
          REFERENCED_NAME: "ORDERS",
          REFERENCED_TYPE: "TABLE",
        },
      ]),
    ).toEqual([
      {
        schema: "APP",
        name: "CALC_TOTAL",
        type: "PACKAGE",
        referencedSchema: "APP",
        referencedName: "ORDERS",
        referencedType: "TABLE",
      },
    ]);
  });

  it("drops NON-EXISTENT referenced rows (dangling/invalid catalog references)", () => {
    expect(
      mapOracleDependencies([
        {
          OWNER: "APP",
          NAME: "CALC_TOTAL",
          TYPE: "PACKAGE",
          REFERENCED_OWNER: null,
          REFERENCED_NAME: "GHOST",
          REFERENCED_TYPE: "NON-EXISTENT",
        },
      ]),
    ).toEqual([]);
  });

  it("drops rows missing a referenced name and defaults a null referenced owner/type to empty string", () => {
    const rows = mapOracleDependencies([
      {
        OWNER: "APP",
        NAME: "CALC_TOTAL",
        TYPE: "PACKAGE",
        REFERENCED_OWNER: null,
        REFERENCED_NAME: null,
        REFERENCED_TYPE: null,
      },
      {
        OWNER: "APP",
        NAME: "CALC_TOTAL",
        TYPE: "PACKAGE",
        REFERENCED_OWNER: null,
        REFERENCED_NAME: "SOME_SYNONYM",
        REFERENCED_TYPE: null,
      },
    ]);
    expect(rows).toEqual([
      {
        schema: "APP",
        name: "CALC_TOTAL",
        type: "PACKAGE",
        referencedSchema: "",
        referencedName: "SOME_SYNONYM",
        referencedType: "",
      },
    ]);
  });
});

describe("mapOraclePackages (#891)", () => {
  it("merges spec + body object rows and attaches deduped member names", () => {
    const packages = mapOraclePackages(
      [
        { OWNER: "APP", OBJECT_NAME: "PKG_A", OBJECT_TYPE: "PACKAGE" },
        { OWNER: "APP", OBJECT_NAME: "PKG_A", OBJECT_TYPE: "PACKAGE BODY" },
      ],
      [
        { OWNER: "APP", OBJECT_NAME: "PKG_A", PROCEDURE_NAME: "M1" },
        { OWNER: "APP", OBJECT_NAME: "PKG_A", PROCEDURE_NAME: "M2" },
        { OWNER: "APP", OBJECT_NAME: "PKG_A", PROCEDURE_NAME: "M1" }, // duplicate
      ],
    );
    expect(packages).toEqual([
      { schema: "APP", name: "PKG_A", hasSpec: true, hasBody: true, members: ["M1", "M2"] },
    ]);
  });

  it("marks a body-only package (spec dropped/invalid) with hasSpec=false", () => {
    const packages = mapOraclePackages(
      [{ OWNER: "APP", OBJECT_NAME: "PKG_B", OBJECT_TYPE: "PACKAGE BODY" }],
      [],
    );
    expect(packages).toEqual([
      { schema: "APP", name: "PKG_B", hasSpec: false, hasBody: true, members: [] },
    ]);
  });

  it("drops member rows with a null PROCEDURE_NAME and rows for packages not in the object set", () => {
    const packages = mapOraclePackages(
      [{ OWNER: "APP", OBJECT_NAME: "PKG_A", OBJECT_TYPE: "PACKAGE" }],
      [
        { OWNER: "APP", OBJECT_NAME: "PKG_A", PROCEDURE_NAME: null },
        { OWNER: "APP", OBJECT_NAME: "PKG_UNKNOWN", PROCEDURE_NAME: "GHOST" },
      ],
    );
    expect(packages).toEqual([
      { schema: "APP", name: "PKG_A", hasSpec: true, hasBody: false, members: [] },
    ]);
  });
});

describe("groupOracleIntrospection", () => {
  it("groups rows by owner.table and links FKs", () => {
    const grouped = groupOracleIntrospection([
      {
        OWNER: "APP",
        TABLE_NAME: "USERS",
        COLUMN_NAME: "ID",
        DATA_TYPE: "NUMBER",
        NULLABLE: "N",
        DATA_DEFAULT: null,
        PK_NAME: "USERS_PK",
        FK_NAME: null,
        FK_FOREIGN_TABLE: null,
        FK_FOREIGN_COLUMN: null,
      },
      {
        OWNER: "APP",
        TABLE_NAME: "USERS",
        COLUMN_NAME: "TEAM_ID",
        DATA_TYPE: "NUMBER",
        NULLABLE: "Y",
        DATA_DEFAULT: null,
        PK_NAME: null,
        FK_NAME: "USERS_TEAM_FK",
        FK_FOREIGN_TABLE: "TEAMS",
        FK_FOREIGN_COLUMN: "ID",
      },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].schema).toBe("APP");
    expect(grouped[0].columns.map((c) => c.name)).toEqual(["ID", "TEAM_ID"]);
    expect(grouped[0].primaryKey).toEqual(["ID"]);
    expect(grouped[0].foreignKeys[0].refTable).toBe("TEAMS");
  });
});

describe("OracleDriverAdapter — coverage uplift", () => {
  it("ping() maps ORA-12541 listener error to DB_CONNECT_FAILED", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries, fail: new Error("ORA-12541: TNS:no listener") });
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_CONNECT_FAILED" });
  });

  it("ping() maps generic error to DB_ERROR", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries, fail: new Error("ORA-99999: something else") });
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.ping()).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("query() maps generic error to QUERY_FAILED", async () => {
    const queries: string[] = [];
    let calls = 0;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string) => {
        queries.push(sql);
        calls += 1;
        if (calls === 1) return { rows: [], metaData: [] };
        throw new Error("ORA-00942: table or view does not exist");
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(
      adapter.query({ sql: "SELECT 1 FROM dual", maxRows: 100, statementTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  it("query() truncates rows above maxRows", async () => {
    const queries: string[] = [];
    const rows = Array.from({ length: 5 }, (_, i) => ({ ID: i }));
    const conn = makeConn({ queries, rows, meta: [{ name: "ID" }] });
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const out = await adapter.query({
      sql: "SELECT * FROM dual",
      maxRows: 3,
      statementTimeoutMs: 1000,
    });
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(3);
  });

  it("init() builds connectString from tnsAlias when provided", async () => {
    const queries: string[] = [];
    let captured: { connectString?: string } | null = null;
    __setOraclePoolFactory(async (args) => {
      captured = args as unknown as { connectString?: string };
      return makePool(makeConn({ queries }));
    });
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      driver: "oracle",
      poolMax: 5,
      statementTimeoutMs: 1000,
      options: { tnsAlias: "MYDB" },
    });
    expect(captured!.connectString).toBe("MYDB");
  });

  it("close() swallows pool.close() errors", async () => {
    const queries: string[] = [];
    const pool: OraclePoolLike = {
      getConnection: vi.fn(async () => makeConn({ queries })),
      close: vi.fn(async () => {
        throw new Error("close exploded");
      }),
    };
    __setOraclePoolFactory(async () => pool);
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      driver: "oracle",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("close() before init is a no-op", async () => {
    const adapter = new OracleDriverAdapter();
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe("OracleDriverAdapter — introspectPackages (#891)", () => {
  it("binds owner as a parameter for an explicit schema and queries both ALL_OBJECTS + ALL_PROCEDURES", async () => {
    const queries: string[] = [];
    const paramsByCall: unknown[][] = [];
    let call = 0;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        paramsByCall.push(params ?? []);
        call += 1;
        if (call === 1) {
          // ALL_OBJECTS — package spec + body rows
          return {
            rows: [
              { OWNER: "APP", OBJECT_NAME: "PKG_ORDERS", OBJECT_TYPE: "PACKAGE" },
              { OWNER: "APP", OBJECT_NAME: "PKG_ORDERS", OBJECT_TYPE: "PACKAGE BODY" },
              { OWNER: "APP", OBJECT_NAME: "PKG_SPEC_ONLY", OBJECT_TYPE: "PACKAGE" },
            ],
            metaData: [],
          };
        }
        // ALL_PROCEDURES — member rows
        return {
          rows: [
            { OWNER: "APP", OBJECT_NAME: "PKG_ORDERS", PROCEDURE_NAME: "CALC_TOTAL" },
            { OWNER: "APP", OBJECT_NAME: "PKG_ORDERS", PROCEDURE_NAME: "DO_SYNC" },
          ],
          metaData: [],
        };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const packages = await adapter.introspectPackages({ schema: "app" });

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("ALL_OBJECTS");
    expect(queries[0]).toContain(":1");
    expect(queries[0]).toMatch(/PACKAGE BODY/);
    expect(queries[1]).toContain("ALL_PROCEDURES");
    expect(queries[1]).toContain(":1");
    expect(paramsByCall[0]).toEqual(["APP"]);
    expect(paramsByCall[1]).toEqual(["APP"]);

    expect(packages).toEqual([
      {
        schema: "APP",
        name: "PKG_ORDERS",
        hasSpec: true,
        hasBody: true,
        members: ["CALC_TOTAL", "DO_SYNC"],
      },
      {
        schema: "APP",
        name: "PKG_SPEC_ONLY",
        hasSpec: true,
        hasBody: false,
        members: [],
      },
    ]);
  });

  it("uses USER_OBJECTS / USER_PROCEDURES with no params when schema unset", async () => {
    const queries: string[] = [];
    const paramsByCall: unknown[][] = [];
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        paramsByCall.push(params ?? []);
        return { rows: [], metaData: [] };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const packages = await adapter.introspectPackages();

    expect(queries[0]).toContain("USER_OBJECTS");
    expect(queries[1]).toContain("USER_PROCEDURES");
    expect(paramsByCall[0]).toEqual([]);
    expect(paramsByCall[1]).toEqual([]);
    expect(packages).toEqual([]);
  });
});

describe("OracleDriverAdapter — fetchPackageBody (#891)", () => {
  it("reads ALL_SOURCE TYPE='PACKAGE BODY' bound to owner+name and assembles the body in LINE order", async () => {
    const queries: string[] = [];
    let capturedParams: unknown[] | undefined;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        capturedParams = params;
        return {
          rows: [
            { TEXT: "PACKAGE BODY pkg_orders AS\n" },
            { TEXT: "  PROCEDURE calc_total AS BEGIN NULL; END;\n" },
            { TEXT: "END pkg_orders;" },
          ],
          metaData: [],
        };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const body = await adapter.fetchPackageBody({ schema: "app", name: "pkg_orders" });

    expect(queries[0]).toContain(":1");
    expect(queries[0]).toContain(":2");
    expect(queries[0]).toMatch(/ALL_SOURCE/i);
    expect(queries[0]).toMatch(/PACKAGE BODY/);
    expect(capturedParams).toEqual(["APP", "PKG_ORDERS"]);
    expect(body).toBe(
      "CREATE PACKAGE BODY pkg_orders AS\n" +
        "  PROCEDURE calc_total AS BEGIN NULL; END;\n" +
        "END pkg_orders;",
    );
  });

  it("uses USER_SOURCE with a single bound param when schema unset", async () => {
    const queries: string[] = [];
    let capturedParams: unknown[] | undefined;
    const conn: OracleConnectionLike = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        capturedParams = params;
        return { rows: [{ TEXT: "PACKAGE BODY pkg AS END pkg;" }], metaData: [] };
      }),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const body = await adapter.fetchPackageBody({ schema: "", name: "pkg" });

    expect(queries[0]).toContain("USER_SOURCE");
    expect(capturedParams).toEqual(["PKG"]);
    expect(body).toBe("CREATE PACKAGE BODY pkg AS END pkg;");
  });

  it("returns null when ALL_SOURCE yields no rows (absent body)", async () => {
    const conn = makeConn({ queries: [], rows: [] });
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const body = await adapter.fetchPackageBody({ schema: "app", name: "ghost_pkg" });
    expect(body).toBeNull();
  });

  it("gracefully skips (returns null, never throws) when the body is wrapped/obfuscated", async () => {
    const conn: OracleConnectionLike = {
      execute: vi.fn(async () => ({
        rows: [
          { TEXT: 'PACKAGE BODY "APP"."PKG_SECRET" wrapped\n' },
          { TEXT: "a000000\n" },
          { TEXT: "b3b3b3b3b3b3\n" },
        ],
        metaData: [],
      })),
      close: vi.fn(async () => {}),
    };
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await expect(
      adapter.fetchPackageBody({ schema: "app", name: "pkg_secret" }),
    ).resolves.toBeNull();
  });
});

describe("OracleDriverAdapter — standalone routine regression (#891)", () => {
  it("introspectRoutines() SQL is unchanged: still filters PROCEDURE/FUNCTION only, no PACKAGE", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries, rows: [] });
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    await adapter.introspectRoutines({ schema: "app" });
    expect(queries[0]).toContain("OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')");
    expect(queries[0]).not.toMatch(/PACKAGE/);
  });

  it("fetchRoutineBody() SQL is unchanged: still filters PROCEDURE/FUNCTION only, no PACKAGE BODY", async () => {
    const queries: string[] = [];
    const conn = makeConn({ queries, rows: [{ TEXT: "PROCEDURE recalc AS BEGIN NULL; END;" }] });
    __setOraclePoolFactory(async () => makePool(conn));
    const adapter = new OracleDriverAdapter();
    await adapter.init({
      host: "x",
      port: 1521,
      database: "ORCL",
      username: "u",
      poolMax: 5,
      statementTimeoutMs: 1000,
    });
    const body = await adapter.fetchRoutineBody({
      schema: "app",
      name: "recalc",
      type: "procedure",
      signature: "",
    });
    expect(queries[0]).toContain("TYPE IN ('PROCEDURE', 'FUNCTION')");
    expect(queries[0]).not.toMatch(/PACKAGE/);
    expect(body).toBe("CREATE PROCEDURE recalc AS BEGIN NULL; END;");
  });
});
