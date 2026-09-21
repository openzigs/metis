import { describe, expect, it } from "vitest";
import { validateSelectOnly } from "../src/lib/connectors/db/sql-validator.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

function expectCode(fn: () => unknown, expected: string | RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    const code = (err as ConnectorError).code;
    if (expected instanceof RegExp) expect(code).toMatch(expected);
    else expect(code).toBe(expected);
    return;
  }
  throw new Error("expected function to throw a ConnectorError");
}

describe("validateSelectOnly", () => {
  it("rejects empty SQL", () => {
    expectCode(() => validateSelectOnly("", "postgres"), "SQL_REQUIRED");
    expectCode(() => validateSelectOnly("   ", "postgres"), "SQL_REQUIRED");
  });

  it("rejects multiple statements", () => {
    expectCode(() => validateSelectOnly("SELECT 1; SELECT 2", "postgres"), "MULTIPLE_STATEMENTS");
  });

  it("rejects INSERT", () => {
    expectCode(
      () => validateSelectOnly("INSERT INTO users(id) VALUES (1)", "postgres"),
      /NON_SELECT|FORBIDDEN_KEYWORD/,
    );
  });

  it("rejects UPDATE", () => {
    expectCode(
      () => validateSelectOnly("UPDATE users SET name='x' WHERE id=1", "postgres"),
      /NON_SELECT|FORBIDDEN_KEYWORD/,
    );
  });

  it("rejects DELETE", () => {
    expectCode(
      () => validateSelectOnly("DELETE FROM users WHERE id=1", "postgres"),
      /NON_SELECT|FORBIDDEN_KEYWORD/,
    );
  });

  it("rejects DROP TABLE", () => {
    expectCode(
      () => validateSelectOnly("DROP TABLE users", "postgres"),
      /NON_SELECT|FORBIDDEN_KEYWORD/,
    );
  });

  it("rejects ALTER", () => {
    expectCode(
      () => validateSelectOnly("ALTER TABLE users ADD COLUMN x int", "postgres"),
      /NON_SELECT|FORBIDDEN_KEYWORD/,
    );
  });

  it("rejects malformed SQL", () => {
    expectCode(() => validateSelectOnly("SELEKT * FROM x", "postgres"), "SQL_PARSE_ERROR");
  });

  it("accepts a simple SELECT and clamps LIMIT to 100", () => {
    const out = validateSelectOnly("SELECT * FROM users", "postgres");
    expect(out.appliedLimit).toBe(100);
    expect(out.sql.toLowerCase()).toMatch(/limit\s+100/);
  });

  it("accepts SELECT with explicit LIMIT below cap", () => {
    const out = validateSelectOnly("SELECT * FROM users LIMIT 25", "postgres");
    expect(out.appliedLimit).toBe(25);
  });

  it("clamps LIMIT > 100 down to 100", () => {
    const out = validateSelectOnly("SELECT * FROM users LIMIT 9999", "postgres");
    expect(out.appliedLimit).toBe(100);
  });

  it("uses FETCH FIRST for oracle dialect", () => {
    const out = validateSelectOnly("SELECT * FROM users", "oracle");
    expect(out.sql.toLowerCase()).toMatch(/fetch\s+first\s+100\s+rows\s+only/);
  });

  it("uses SELECT TOP for sqlserver dialect", () => {
    const out = validateSelectOnly("SELECT * FROM users", "sqlserver");
    expect(out.sql.toLowerCase()).toMatch(/select\s+top\s*\(\s*100\s*\)/);
  });

  it("strips trailing semicolons", () => {
    const out = validateSelectOnly("SELECT 1; ", "postgres");
    expect(out.appliedLimit).toBe(100);
  });

  it("rejects SELECT … ; DROP TABLE x", () => {
    expectCode(
      () => validateSelectOnly("SELECT 1; DROP TABLE users", "postgres"),
      "MULTIPLE_STATEMENTS",
    );
  });

  // ── H1 regression: LIMIT bypass PoC ───────────────────────────────────────
  describe("row-cap rewrite (H1 regression)", () => {
    it("PoC: SELECT … LIMIT 999999999 is rewritten to LIMIT 100", () => {
      const out = validateSelectOnly("SELECT * FROM huge_table LIMIT 999999999", "postgres");
      expect(out.appliedLimit).toBe(100);
      expect(out.sql).not.toMatch(/999999999/);
      expect(out.sql).toMatch(/LIMIT\s+100/i);
    });

    it("PoC mysql: LIMIT 50000000 rewritten to LIMIT 100", () => {
      const out = validateSelectOnly("SELECT * FROM t LIMIT 50000000", "mysql");
      expect(out.sql).not.toMatch(/50000000/);
      expect(out.sql).toMatch(/LIMIT\s+100/i);
    });

    it("PoC sqlite: LIMIT 1e9 rewritten to LIMIT 100", () => {
      const out = validateSelectOnly("SELECT * FROM t LIMIT 1000000000", "sqlite");
      expect(out.sql).not.toMatch(/1000000000/);
      expect(out.sql).toMatch(/LIMIT\s+100/i);
    });

    it("preserves OFFSET when rewriting LIMIT n OFFSET m", () => {
      const out = validateSelectOnly("SELECT * FROM t LIMIT 9999 OFFSET 50", "postgres");
      expect(out.sql).toMatch(/LIMIT\s+100\s+OFFSET\s+50/i);
    });

    it("preserves MySQL `LIMIT off, n` form when rewriting", () => {
      const out = validateSelectOnly("SELECT * FROM t LIMIT 25, 9999", "mysql");
      expect(out.sql).toMatch(/LIMIT\s+25\s*,\s*100/i);
    });

    it("does NOT touch LIMIT inside a CTE (only outermost cap is rewritten)", () => {
      const out = validateSelectOnly(
        "WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x LIMIT 9999",
        "postgres",
      );
      expect(out.sql).toMatch(/LIMIT\s+5\)/);
      expect(out.sql).toMatch(/LIMIT\s+100\s*$/i);
    });

    it("appends LIMIT cap when no LIMIT present (postgres)", () => {
      const out = validateSelectOnly("SELECT 1", "postgres");
      expect(out.sql).toMatch(/SELECT 1 LIMIT 100/i);
    });

    it("rewrites Oracle FETCH FIRST n ROWS ONLY to cap", () => {
      const out = validateSelectOnly("SELECT * FROM t FETCH FIRST 99999 ROWS ONLY", "oracle");
      expect(out.sql).not.toMatch(/99999/);
      expect(out.sql).toMatch(/FETCH FIRST 100 ROWS ONLY/);
    });

    it("strips PG-style trailing LIMIT when rewriting Oracle", () => {
      const out = validateSelectOnly("SELECT * FROM t LIMIT 99999", "oracle");
      expect(out.sql).not.toMatch(/LIMIT/i);
      expect(out.sql).toMatch(/FETCH FIRST 100 ROWS ONLY/);
    });

    it("rewrites SELECT TOP n to cap (sqlserver)", () => {
      const out = validateSelectOnly("SELECT TOP 99999 * FROM t", "sqlserver");
      expect(out.sql).not.toMatch(/99999/);
      expect(out.sql).toMatch(/SELECT TOP 100/i);
    });

    it("rewrites SELECT TOP (n) to cap (sqlserver)", () => {
      const out = validateSelectOnly("SELECT TOP (99999) * FROM t", "sqlserver");
      expect(out.sql).toMatch(/SELECT TOP \(100\)/);
    });

    it("injects SELECT TOP (cap) when sqlserver query has no cap", () => {
      const out = validateSelectOnly("SELECT * FROM t", "sqlserver");
      expect(out.sql.toLowerCase()).toMatch(/select\s+top\s*\(\s*100\s*\)\s*\*/);
    });
  });

  // ── M2: Oracle/MSSQL-specific mutating syntax must still be rejected ────
  describe("Oracle/MSSQL keyword backstop (M2)", () => {
    it("rejects Oracle MERGE INTO under PG grammar", () => {
      expectCode(
        () =>
          validateSelectOnly(
            "MERGE INTO target t USING src s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.x=s.x",
            "oracle",
          ),
        /NON_SELECT|FORBIDDEN_KEYWORD|SQL_PARSE_ERROR/,
      );
    });

    it("rejects MSSQL MERGE", () => {
      expectCode(
        () => validateSelectOnly("MERGE INTO dbo.t AS T USING src AS S ON T.id=S.id", "sqlserver"),
        /NON_SELECT|FORBIDDEN_KEYWORD|SQL_PARSE_ERROR/,
      );
    });

    it("rejects MSSQL OUTPUT INTO embedded in DML", () => {
      expectCode(
        () => validateSelectOnly("INSERT INTO t(id) OUTPUT INTO audit VALUES (1)", "sqlserver"),
        /NON_SELECT|FORBIDDEN_KEYWORD|SQL_PARSE_ERROR/,
      );
    });

    it("rejects PG DO $$ … $$ block", () => {
      expectCode(
        () => validateSelectOnly("DO $$ BEGIN RAISE NOTICE 'x'; END $$", "postgres"),
        /SQL_PARSE_ERROR|NON_SELECT|FORBIDDEN_KEYWORD/,
      );
    });
  });

  // ── M3: comment / string obfuscation backstop ────────────────────────────
  describe("string + comment stripping (M3)", () => {
    it("does not let DROP hide inside a -- line comment", () => {
      // The whole DROP is commented out; the AST sees just SELECT 1 — so this
      // *should* PASS validation with a row cap injected. The test guards
      // that we don't false-positive on legal commented SQL.
      const out = validateSelectOnly("SELECT 1 -- DROP TABLE users", "postgres");
      expect(out.appliedLimit).toBe(100);
    });

    it("rejects DROP smuggled past a /* … */ comment via second statement", () => {
      expectCode(
        () => validateSelectOnly("SELECT 1 /* harmless */ ; DROP TABLE users", "postgres"),
        /MULTIPLE_STATEMENTS|FORBIDDEN_KEYWORD/,
      );
    });

    it("treats nested-looking block comments as a single comment (PG semantics)", () => {
      // PG block comments are non-nesting in standard SQL — `/* /* X */` is
      // ONE comment whose body is ` /* X `. After stripping we have just
      // `SELECT 1`, which is valid. The point of the test: we don't FALSE-
      // POSITIVE on legal commented SQL.
      const out = validateSelectOnly("SELECT 1 /* /* DROP TABLE x */", "postgres");
      expect(out.appliedLimit).toBe(100);
    });

    it("treats DROP inside a single-quoted string as data, not a keyword", () => {
      // String literal wraps the keyword — should pass as a normal SELECT.
      const out = validateSelectOnly("SELECT 'DROP TABLE users' AS warn", "postgres");
      expect(out.appliedLimit).toBe(100);
    });

    it("rejects DROP smuggled via PG E-string concatenation trick", () => {
      // Concatenating an E-string then a real DROP via stmt-separator must fail.
      expectCode(
        () => validateSelectOnly("SELECT E'\\'; DROP TABLE x; --' AS s", "postgres"),
        /SQL_PARSE_ERROR|FORBIDDEN_KEYWORD|NON_SELECT/,
      );
    });

    it("rejects DROP smuggled inside a $$ dollar-quoted string when followed by real DDL", () => {
      expectCode(
        () => validateSelectOnly("SELECT $$ harmless $$ AS x; DROP TABLE users", "postgres"),
        /MULTIPLE_STATEMENTS|FORBIDDEN_KEYWORD/,
      );
    });

    it("strips strings + comments helper exposes a stable surface", async () => {
      const { stripStringsAndComments } = await import("../src/lib/connectors/db/sql-validator.js");
      expect(stripStringsAndComments("SELECT 'a''b' /* x */ -- y").trim()).toMatch(/^SELECT/);
      expect(stripStringsAndComments("SELECT $tag$abc$tag$").trim()).toMatch(/^SELECT/);
      expect(stripStringsAndComments("SELECT E'a\\''")).not.toMatch(/'/);
      expect(stripStringsAndComments("SELECT U&'\\00e9'")).not.toMatch(/'/);
    });
  });
});

// ── #882: per-connector table/column allow-list ───────────────────────────
describe("validateSelectOnly — allow-list (#882)", () => {
  it("allows a query touching only allow-listed tables", () => {
    const out = validateSelectOnly("SELECT id FROM people", "postgres", {
      allowList: { tables: ["people"] },
    });
    expect(out.appliedLimit).toBe(100);
  });

  it("matches a schema-qualified table against the bare allow-list name", () => {
    const out = validateSelectOnly("SELECT id FROM public.people", "postgres", {
      allowList: { tables: ["people"] },
    });
    expect(out.appliedLimit).toBe(100);
  });

  it("rejects a query touching a non-allow-listed table", () => {
    expectCode(
      () =>
        validateSelectOnly("SELECT id FROM secrets", "postgres", {
          allowList: { tables: ["people"] },
        }),
      "TABLE_NOT_ALLOWED",
    );
  });

  it("rejects a JOIN that reaches a non-allow-listed table", () => {
    expectCode(
      () =>
        validateSelectOnly("SELECT p.id FROM people p JOIN orders o ON o.pid = p.id", "postgres", {
          allowList: { tables: ["people"] },
        }),
      "TABLE_NOT_ALLOWED",
    );
  });

  it("does not allow a prefix-evasion table name (people vs people_secret)", () => {
    expectCode(
      () =>
        validateSelectOnly("SELECT id FROM people_secret", "postgres", {
          allowList: { tables: ["people"] },
        }),
      "TABLE_NOT_ALLOWED",
    );
  });

  it("fail-closed: an empty tables list rejects every query", () => {
    expectCode(
      () => validateSelectOnly("SELECT id FROM people", "postgres", { allowList: { tables: [] } }),
      "TABLE_NOT_ALLOWED",
    );
  });

  it("preserves allow-all behaviour when no allow-list is supplied", () => {
    const out = validateSelectOnly("SELECT id FROM anything", "postgres");
    expect(out.appliedLimit).toBe(100);
  });

  it("enforces a column allow-list when supplied", () => {
    const out = validateSelectOnly("SELECT id, name FROM people", "postgres", {
      allowList: { tables: ["people"], columns: ["id", "name"] },
    });
    expect(out.appliedLimit).toBe(100);
  });

  it("rejects a non-allow-listed column", () => {
    expectCode(
      () =>
        validateSelectOnly("SELECT ssn FROM people", "postgres", {
          allowList: { tables: ["people"], columns: ["id", "name"] },
        }),
      "COLUMN_NOT_ALLOWED",
    );
  });

  it("rejects SELECT * when a column allow-list is configured", () => {
    expectCode(
      () =>
        validateSelectOnly("SELECT * FROM people", "postgres", {
          allowList: { tables: ["people"], columns: ["id"] },
        }),
      "COLUMN_NOT_ALLOWED",
    );
  });

  it("allows all columns when the column list is omitted", () => {
    const out = validateSelectOnly("SELECT * FROM people", "postgres", {
      allowList: { tables: ["people"] },
    });
    expect(out.appliedLimit).toBe(100);
  });

  it("still enforces read-only validation alongside the allow-list", () => {
    expectCode(
      () =>
        validateSelectOnly("UPDATE people SET name='x'", "postgres", {
          allowList: { tables: ["people"] },
        }),
      /NON_SELECT|FORBIDDEN_KEYWORD/,
    );
  });
});

// ── #882: parseDbConnectorAllowList contract ──────────────────────────────
describe("parseDbConnectorAllowList (#882)", () => {
  it("returns undefined (allow-all) when options is null/empty", async () => {
    const { parseDbConnectorAllowList } = await import("@metis/shared");
    expect(parseDbConnectorAllowList(null)).toBeUndefined();
    expect(parseDbConnectorAllowList("")).toBeUndefined();
    expect(parseDbConnectorAllowList("   ")).toBeUndefined();
  });

  it("returns undefined when the allowList key is absent", async () => {
    const { parseDbConnectorAllowList } = await import("@metis/shared");
    expect(parseDbConnectorAllowList(JSON.stringify({ poolMax: 5 }))).toBeUndefined();
  });

  it("parses a valid allow-list from the options JSON", async () => {
    const { parseDbConnectorAllowList } = await import("@metis/shared");
    const out = parseDbConnectorAllowList(
      JSON.stringify({ allowList: { tables: ["people"], columns: ["id"] } }),
    );
    expect(out).toEqual({ tables: ["people"], columns: ["id"] });
  });

  it("fails closed (empty tables) on a present-but-malformed allow-list", async () => {
    const { parseDbConnectorAllowList } = await import("@metis/shared");
    expect(parseDbConnectorAllowList(JSON.stringify({ allowList: { tables: "nope" } }))).toEqual({
      tables: [],
    });
  });

  it("fails closed (empty tables) when malformed-but-non-empty options is not valid JSON", async () => {
    const { parseDbConnectorAllowList } = await import("@metis/shared");
    // A corrupt-but-non-empty options blob must NOT silently widen access.
    expect(parseDbConnectorAllowList("{not json")).toEqual({ tables: [] });
  });

  it("fails closed (empty tables) when options parses to a non-object value", async () => {
    const { parseDbConnectorAllowList } = await import("@metis/shared");
    expect(parseDbConnectorAllowList("123")).toEqual({ tables: [] });
    expect(parseDbConnectorAllowList('"oops"')).toEqual({ tables: [] });
    expect(parseDbConnectorAllowList("null")).toEqual({ tables: [] });
    expect(parseDbConnectorAllowList("[1,2,3]")).toEqual({ tables: [] });
  });
});
