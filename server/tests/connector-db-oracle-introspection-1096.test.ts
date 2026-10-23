/**
 * #1096 — Oracle catalog introspection used to stop at `maxRows: 10_000` with
 * no error and no flag, so a large schema was read partially and every consumer
 * took the partial read for the whole schema. These tests drive the driver's
 * introspection path with a fake connection returning more than 10,000 rows:
 * the read must be complete, or say it was cut. No database is needed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OracleDriverAdapter,
  ORACLE_CATALOG_FETCH_ROWS,
  ORACLE_INTROSPECTION_ROW_CEILING,
  __setOracleIntrospectionRowCeiling,
  __setOraclePoolFactory,
  type OracleConnectionLike,
} from "../src/lib/connectors/db/drivers/oracle.js";

type Row = Record<string, unknown>;

interface Call {
  sql: string;
  params: unknown[] | undefined;
  opts: { maxRows?: number; resultSet?: boolean } | undefined;
}

interface FakeOptions {
  /** Rows the catalog query returns. */
  rows: Row[];
  /** Rows of a second catalog query (package members). */
  secondRows?: Row[];
  /** When false the fake ignores `resultSet` and returns plain rows. */
  supportsResultSet?: boolean;
  /** Answer to the table-count query; an Error makes it fail. */
  tableCount?: number | Error;
  /** Make `getRows` throw on its Nth call (1-based). */
  failOnPage?: number;
}

function fakeConnection(options: FakeOptions) {
  const calls: Call[] = [];
  const pageSizes: number[] = [];
  let closedResultSets = 0;
  let catalogQueries = 0;
  const conn: OracleConnectionLike = {
    execute: vi.fn(async (sql: string, params?: unknown[], opts?: Call["opts"]) => {
      calls.push({ sql, params, opts });
      if (/COUNT\(DISTINCT/.test(sql)) {
        if (options.tableCount instanceof Error) throw options.tableCount;
        return { rows: [{ TABLE_COUNT: options.tableCount ?? 0 }] };
      }
      const source = catalogQueries++ === 0 ? options.rows : (options.secondRows ?? []);
      if (opts?.resultSet && options.supportsResultSet !== false) {
        let at = 0;
        let page = 0;
        return {
          resultSet: {
            getRows: async (n: number) => {
              page += 1;
              if (options.failOnPage === page) throw new Error("ORA-03113: end-of-file");
              pageSizes.push(n);
              const out = source.slice(at, at + n);
              at += out.length;
              return out;
            },
            close: async () => {
              closedResultSets += 1;
            },
          },
        };
      }
      // As oracledb does: `maxRows` cuts the rows with no error and no flag.
      return { rows: opts?.maxRows ? source.slice(0, opts.maxRows) : source };
    }) as OracleConnectionLike["execute"],
    close: vi.fn(async () => {}),
  };
  return {
    conn,
    calls,
    pageSizes,
    closedResultSets: () => closedResultSets,
  };
}

/** One introspection row per column: `tables` tables of `columns` columns. */
function columnRows(tables: number, columns: number, owner = "APP"): Row[] {
  const rows: Row[] = [];
  for (let t = 0; t < tables; t++) {
    for (let c = 0; c < columns; c++) {
      rows.push({
        OWNER: owner,
        TABLE_NAME: `T${String(t).padStart(5, "0")}`,
        COLUMN_NAME: `C${c}`,
        DATA_TYPE: "NUMBER",
        NULLABLE: "Y",
        DATA_DEFAULT: null,
        PK_NAME: c === 0 ? `PK_${t}` : null,
        FK_NAME: null,
        FK_FOREIGN_TABLE: null,
        FK_FOREIGN_COLUMN: null,
      });
    }
  }
  return rows;
}

async function adapterOver(conn: OracleConnectionLike): Promise<OracleDriverAdapter> {
  __setOraclePoolFactory(async () => ({
    getConnection: async () => conn,
    close: async () => {},
  }));
  const adapter = new OracleDriverAdapter();
  await adapter.init({
    driver: "oracle",
    host: "db",
    port: 1521,
    database: "ORCL",
    username: "u",
    password: "p",
    poolMax: 2,
    statementTimeoutMs: 5_000,
  });
  return adapter;
}

afterEach(() => {
  __setOraclePoolFactory(null);
  __setOracleIntrospectionRowCeiling(null);
});

describe("Oracle table introspection past 10,000 rows (#1096)", () => {
  it("reads every row through a paged result set, the last table complete", async () => {
    // The issue's reproduction, past the old cap: 30-column tables, 12,000 rows.
    const fake = fakeConnection({ rows: columnRows(400, 30) });
    const adapter = await adapterOver(fake.conn);

    const read = await adapter.introspectSchema({ schema: "app" });

    expect(read.truncation).toBeUndefined();
    expect(read.tables).toHaveLength(400);
    const last = read.tables[read.tables.length - 1];
    expect(last.name).toBe("T00399");
    expect(last.columns).toHaveLength(30);
    expect(last.primaryKey).toEqual(["C0"]);
    // Paged, never one unbounded fetch and never a fixed maxRows.
    const catalog = fake.calls[0];
    expect(catalog.opts).toEqual({ resultSet: true });
    expect(catalog.params).toEqual(["APP"]);
    expect(Math.max(...fake.pageSizes)).toBeLessThanOrEqual(ORACLE_CATALOG_FETCH_ROWS);
    expect(fake.closedResultSets()).toBe(1);
    // A complete read asks for no table count.
    expect(fake.calls.some((c) => /COUNT\(DISTINCT/.test(c.sql))).toBe(false);
  });

  it("introspect() returns the same complete table list", async () => {
    const fake = fakeConnection({ rows: columnRows(400, 30) });
    const adapter = await adapterOver(fake.conn);
    const tables = await adapter.introspect();
    expect(tables).toHaveLength(400);
    expect(tables[399].columns).toHaveLength(30);
    expect(fake.calls[0].params).toEqual([]);
  });

  it("reads every row from a connection that returns plain rows", async () => {
    const fake = fakeConnection({ rows: columnRows(400, 30), supportsResultSet: false });
    const adapter = await adapterOver(fake.conn);
    const read = await adapter.introspectSchema();
    expect(read.truncation).toBeUndefined();
    expect(read.tables).toHaveLength(400);
    expect(read.tables[399].columns).toHaveLength(30);
  });

  it("at the ceiling, drops the table it cut through and reports N of M tables", async () => {
    __setOracleIntrospectionRowCeiling(1_000);
    // 40 tables x 30 columns = 1,200 rows; row 1,001 is column 10 of T00033.
    const fake = fakeConnection({ rows: columnRows(40, 30), tableCount: 40 });
    const adapter = await adapterOver(fake.conn);

    const read = await adapter.introspectSchema({ schema: "APP" });

    expect(read.tables).toHaveLength(33);
    expect(read.tables.every((t) => t.columns.length === 30)).toBe(true);
    expect(read.tables.map((t) => t.name)).not.toContain("T00033");
    expect(read.truncation).toEqual({
      rowsRead: 1_000,
      rowCeiling: 1_000,
      tablesRead: 33,
      tablesTotal: 40,
    });
    // It stopped asking for rows at the ceiling (plus the one row that proves it).
    expect(fake.pageSizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_001);
    const count = fake.calls.find((c) => /COUNT\(DISTINCT/.test(c.sql));
    expect(count?.sql).toContain("ALL_TAB_COLUMNS");
    expect(count?.params).toEqual(["APP"]);
    expect(fake.closedResultSets()).toBe(1);
  });

  it("keeps the last table when the ceiling falls on a table boundary", async () => {
    __setOracleIntrospectionRowCeiling(990);
    const fake = fakeConnection({ rows: columnRows(40, 30), tableCount: 40 });
    const adapter = await adapterOver(fake.conn);
    const read = await adapter.introspectSchema();
    expect(read.tables).toHaveLength(33);
    expect(read.tables[32].name).toBe("T00032");
    expect(read.tables[32].columns).toHaveLength(30);
    expect(read.truncation?.tablesRead).toBe(33);
    // The connected user's own schema is counted from USER_TAB_COLUMNS.
    const count = fake.calls.find((c) => /COUNT\(DISTINCT/.test(c.sql));
    expect(count?.sql).toContain("USER_TAB_COLUMNS");
    expect(count?.params).toEqual([]);
  });

  it("is complete when the catalog holds exactly the ceiling's rows", async () => {
    __setOracleIntrospectionRowCeiling(1_200);
    const fake = fakeConnection({ rows: columnRows(40, 30) });
    const adapter = await adapterOver(fake.conn);
    const read = await adapter.introspectSchema();
    expect(read.truncation).toBeUndefined();
    expect(read.tables).toHaveLength(40);
  });

  it("applies the ceiling to a connection that returns plain rows too", async () => {
    __setOracleIntrospectionRowCeiling(1_000);
    const fake = fakeConnection({
      rows: columnRows(40, 30),
      supportsResultSet: false,
      tableCount: 40,
    });
    const adapter = await adapterOver(fake.conn);
    const read = await adapter.introspectSchema();
    expect(read.tables).toHaveLength(33);
    expect(read.truncation).toMatchObject({ rowsRead: 1_000, tablesRead: 33, tablesTotal: 40 });
  });

  it("still reports the cut when the table count fails", async () => {
    __setOracleIntrospectionRowCeiling(1_000);
    const fake = fakeConnection({
      rows: columnRows(40, 30),
      tableCount: new Error("ORA-01013: user requested cancel"),
    });
    const adapter = await adapterOver(fake.conn);
    const read = await adapter.introspectSchema();
    expect(read.truncation).toEqual({ rowsRead: 1_000, rowCeiling: 1_000, tablesRead: 33 });
  });

  it("closes the result set and the connection when a page fails", async () => {
    const fake = fakeConnection({ rows: columnRows(400, 30), failOnPage: 3 });
    const adapter = await adapterOver(fake.conn);
    await expect(adapter.introspectSchema()).rejects.toThrow("ORA-03113");
    expect(fake.closedResultSets()).toBe(1);
    expect(fake.conn.close).toHaveBeenCalled();
  });

  it("has a ceiling far above the old 10,000-row cap", () => {
    expect(ORACLE_INTROSPECTION_ROW_CEILING).toBeGreaterThanOrEqual(250_000);
    expect(ORACLE_CATALOG_FETCH_ROWS).toBeGreaterThan(0);
  });
});

describe("Oracle routine, dependency and package introspection past 10,000 rows (#1096)", () => {
  it("introspectRoutines() reads all 12,000 routines", async () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      OWNER: "APP",
      OBJECT_NAME: `P${i}`,
      OBJECT_TYPE: i % 2 ? "FUNCTION" : "PROCEDURE",
    }));
    const fake = fakeConnection({ rows });
    const adapter = await adapterOver(fake.conn);
    const routines = await adapter.introspectRoutines({ schema: "APP" });
    expect(routines).toHaveLength(12_000);
    expect(routines[11_999]).toMatchObject({ name: "P11999", type: "function" });
    expect(fake.calls[0].opts).toEqual({ resultSet: true });
  });

  it("introspectRoutines() stops at the ceiling instead of reading without bound", async () => {
    __setOracleIntrospectionRowCeiling(500);
    const rows = Array.from({ length: 600 }, (_, i) => ({
      OWNER: "APP",
      OBJECT_NAME: `P${i}`,
      OBJECT_TYPE: "PROCEDURE",
    }));
    const adapter = await adapterOver(fakeConnection({ rows }).conn);
    expect(await adapter.introspectRoutines()).toHaveLength(500);
  });

  it("introspectDependencies() reads all 12,000 rows, on the DBA view and the fallback", async () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      OWNER: "APP",
      NAME: `PKG${i}`,
      TYPE: "PACKAGE BODY",
      REFERENCED_OWNER: "APP",
      REFERENCED_NAME: `T${i}`,
      REFERENCED_TYPE: "TABLE",
    }));
    const fake = fakeConnection({ rows });
    const adapter = await adapterOver(fake.conn);
    const deps = await adapter.introspectDependencies({ schema: "APP", allowDba: true });
    expect(deps).toHaveLength(12_000);
    expect(fake.calls[0].sql).toContain("DBA_DEPENDENCIES");

    const fallback = fakeConnection({ rows });
    const plain = await adapterOver(fallback.conn);
    expect(await plain.introspectDependencies()).toHaveLength(12_000);
    expect(fallback.calls[0].opts).toEqual({ resultSet: true });
  });

  it("introspectPackages() reads past 10,000 package objects and 50,000 members", async () => {
    const objects = Array.from({ length: 12_000 }, (_, i) => ({
      OWNER: "APP",
      OBJECT_NAME: `PKG${Math.floor(i / 2)}`,
      OBJECT_TYPE: i % 2 ? "PACKAGE BODY" : "PACKAGE",
    }));
    const members = Array.from({ length: 60_000 }, (_, i) => ({
      OWNER: "APP",
      OBJECT_NAME: `PKG${i % 6_000}`,
      PROCEDURE_NAME: `M${i}`,
    }));
    const fake = fakeConnection({ rows: objects, secondRows: members });
    const adapter = await adapterOver(fake.conn);
    const packages = await adapter.introspectPackages({ schema: "APP" });
    expect(packages).toHaveLength(6_000);
    expect(packages[5_999]).toMatchObject({ name: "PKG5999", hasSpec: true, hasBody: true });
    expect(packages.reduce((n, p) => n + p.members.length, 0)).toBe(60_000);
  });
});
