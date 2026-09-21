/**
 * Tests for the PL/SQL DML pre-processor — Epic #881 (#892).
 *
 * Text-only: no PL/SQL is ever executed, no database driver or sidecar is
 * involved. Fixtures are real-shaped Oracle package/routine bodies covering
 * nested BEGIN/END blocks, IF + LOOP + CURSOR, multiple DML per member, a
 * SELECT INTO, an EXECUTE IMMEDIATE dynamic statement, and a
 * MERGE ... LOG ERRORS statement.
 */
import { describe, expect, it } from "vitest";
import { preprocessPlsqlBody } from "../src/lib/code-graph/plsql-preprocessor.js";

/**
 * A real-shaped Oracle package body exercising every required fixture shape
 * in one pass: nested BEGIN/END (member-level EXCEPTION + a nested inline
 * anonymous block with its own EXCEPTION), IF + LOOP + CURSOR, multiple DML
 * statements in one member, a SELECT ... INTO, an EXECUTE IMMEDIATE dynamic
 * statement, and a MERGE ... LOG ERRORS statement.
 */
const ORDER_PKG_BODY = `
CREATE PACKAGE BODY order_pkg AS

  PROCEDURE recalc_totals(p_order_id IN NUMBER) IS
    v_total NUMBER;
    CURSOR c_lines IS
      SELECT amount FROM order_lines WHERE order_id = p_order_id;
    v_amount order_lines.amount%TYPE;
  BEGIN
    OPEN c_lines;
    LOOP
      FETCH c_lines INTO v_amount;
      EXIT WHEN c_lines%NOTFOUND;
      IF v_amount > 0 THEN
        UPDATE order_lines SET reviewed = 1 WHERE order_id = p_order_id AND amount = v_amount;
      ELSE
        DELETE FROM order_lines WHERE order_id = p_order_id AND amount = v_amount;
      END IF;
    END LOOP;
    CLOSE c_lines;

    SELECT SUM(amount) INTO v_total FROM order_lines WHERE order_id = p_order_id;
    UPDATE orders SET total = v_total WHERE id = p_order_id;

    BEGIN
      INSERT INTO order_audit (order_id, action) VALUES (p_order_id, 'RECALC');
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      NULL;
  END recalc_totals;

  PROCEDURE archive_order(p_order_id IN NUMBER, p_table_name IN VARCHAR2) IS
  BEGIN
    EXECUTE IMMEDIATE 'INSERT INTO ' || p_table_name || ' SELECT * FROM orders WHERE id = :1' USING p_order_id;
    DELETE FROM orders WHERE id = p_order_id;
  END archive_order;

  FUNCTION sync_order_snapshot(p_order_id IN NUMBER) RETURN NUMBER IS
  BEGIN
    MERGE INTO order_snapshot tgt
    USING (SELECT id, total FROM orders WHERE id = p_order_id) src
    ON (tgt.id = src.id)
    WHEN MATCHED THEN
      UPDATE SET tgt.total = src.total
    WHEN NOT MATCHED THEN
      INSERT (id, total) VALUES (src.id, src.total)
    LOG ERRORS INTO err_order_snapshot ('SYNC') REJECT LIMIT UNLIMITED;
    RETURN 1;
  END sync_order_snapshot;

END order_pkg;
`;

describe("preprocessPlsqlBody", () => {
  it("isolates the exact set of DML statements for a member with nested BEGIN/END, IF/LOOP/CURSOR, and multiple DML statements", () => {
    const result = preprocessPlsqlBody(ORDER_PKG_BODY);
    const recalc = result.statements.filter((s) => s.memberName === "recalc_totals");
    expect(recalc.map((s) => s.dml)).toEqual([
      "UPDATE order_lines SET reviewed = 1 WHERE order_id = p_order_id AND amount = v_amount;",
      "DELETE FROM order_lines WHERE order_id = p_order_id AND amount = v_amount;",
      "SELECT SUM(amount) FROM order_lines WHERE order_id = p_order_id;",
      "UPDATE orders SET total = v_total WHERE id = p_order_id;",
      "INSERT INTO order_audit (order_id, action) VALUES (p_order_id, 'RECALC');",
    ]);
  });

  it("strips the cursor declaration's SELECT — it is never isolated as a DML statement", () => {
    const result = preprocessPlsqlBody(ORDER_PKG_BODY);
    const allDml = result.statements.map((s) => s.dml).join(" | ");
    expect(allDml).not.toContain("c_lines");
  });

  it("normalizes SELECT ... INTO <var> FROM ... to a plain SELECT ... FROM ... (PL/SQL-only clause dropped)", () => {
    const result = preprocessPlsqlBody(ORDER_PKG_BODY);
    const select = result.statements.find((s) => s.dml.startsWith("SELECT SUM"));
    expect(select?.dml).toBe("SELECT SUM(amount) FROM order_lines WHERE order_id = p_order_id;");
    expect(select?.dml).not.toContain("INTO");
  });

  it("flags EXECUTE IMMEDIATE dynamic SQL as unresolved (not dropped, not parsed as DML)", () => {
    const result = preprocessPlsqlBody(ORDER_PKG_BODY);
    const dynamic = result.unresolved.filter((u) => u.memberName === "archive_order");
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].reason).toBe("execute-immediate");
    expect(dynamic[0].placeholder).toContain("INSERT INTO");
    expect(dynamic[0].placeholder).toContain("p_table_name");
    // Never emitted as a parseable DML statement.
    expect(
      result.statements.some((s) => s.memberName === "archive_order" && s.dml.includes("EXECUTE")),
    ).toBe(false);
  });

  it("still isolates the concrete DELETE that follows the dynamic EXECUTE IMMEDIATE in the same member", () => {
    const result = preprocessPlsqlBody(ORDER_PKG_BODY);
    const archive = result.statements.filter((s) => s.memberName === "archive_order");
    expect(archive.map((s) => s.dml)).toEqual(["DELETE FROM orders WHERE id = p_order_id;"]);
  });

  it("recovers the MERGE target table by best-effort stripping the Oracle LOG ERRORS tail", () => {
    const result = preprocessPlsqlBody(ORDER_PKG_BODY);
    const merge = result.statements.find((s) => s.memberName === "sync_order_snapshot");
    expect(merge).toBeDefined();
    expect(merge?.dml.startsWith("MERGE INTO order_snapshot")).toBe(true);
    expect(merge?.dml).not.toContain("LOG ERRORS");
    expect(merge?.dml).not.toContain("REJECT LIMIT");
    expect(result.unresolved.some((u) => u.memberName === "sync_order_snapshot")).toBe(false);
  });

  it("is deterministic — repeated calls on the same input yield identical output", () => {
    const first = preprocessPlsqlBody(ORDER_PKG_BODY);
    const second = preprocessPlsqlBody(ORDER_PKG_BODY);
    expect(second).toEqual(first);
  });

  it("processes members in source order and never leaks a statement into the wrong member", () => {
    const result = preprocessPlsqlBody(ORDER_PKG_BODY);
    const memberOrder = [...new Set(result.statements.map((s) => s.memberName))];
    expect(memberOrder).toEqual(["recalc_totals", "archive_order", "sync_order_snapshot"]);
    expect(result.statements.every((s) => s.memberName !== "")).toBe(true);
  });

  it("handles a standalone routine body (no package wrapper, single member) the same way #316B's fetcher returns it", () => {
    const body =
      "CREATE PROCEDURE recalc AS BEGIN UPDATE orders SET total = 1 WHERE id = 7; END recalc;";
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      { memberName: "recalc", dml: "UPDATE orders SET total = 1 WHERE id = 7;" },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("emits an unresolved fact (not a dropped statement, not a crash) for a MERGE whose target cannot be recovered", () => {
    const body = `CREATE PROCEDURE bad_merge AS BEGIN MERGE LOG ERRORS REJECT LIMIT UNLIMITED; END bad_merge;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        memberName: "bad_merge",
        placeholder: "MERGE LOG ERRORS REJECT LIMIT UNLIMITED",
        reason: "unparseable-construct",
      },
    ]);
  });

  it("returns an empty result for an empty or whitespace-only body", () => {
    expect(preprocessPlsqlBody("")).toEqual({ statements: [], unresolved: [] });
    expect(preprocessPlsqlBody("   \n\t  ")).toEqual({ statements: [], unresolved: [] });
  });

  it("never treats text inside a single-quoted string literal as a statement terminator or keyword", () => {
    const body = `CREATE PROCEDURE log_it AS BEGIN INSERT INTO logs (msg) VALUES ('BEGIN; END; a semicolon; inside a string'); END log_it;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      {
        memberName: "log_it",
        dml: "INSERT INTO logs (msg) VALUES ('BEGIN; END; a semicolon; inside a string');",
      },
    ]);
  });

  it("preserves a SQL CASE expression embedded inside a kept DML statement (not treated as PL/SQL control flow)", () => {
    const body = `CREATE FUNCTION grade AS BEGIN UPDATE scores SET grade = CASE WHEN pct >= 90 THEN 'A' ELSE 'B' END WHERE id = 1; END grade;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      {
        memberName: "grade",
        dml: "UPDATE scores SET grade = CASE WHEN pct >= 90 THEN 'A' ELSE 'B' END WHERE id = 1;",
      },
    ]);
  });

  it("drops procedural scaffolding (assignments, RAISE, cursor OPEN/FETCH/CLOSE, NULL) without flagging it unresolved", () => {
    const body = `CREATE PROCEDURE noop_ish AS
      v_x NUMBER;
    BEGIN
      v_x := 1;
      IF v_x > 0 THEN
        NULL;
      END IF;
      RAISE_APPLICATION_ERROR(-20001, 'nope');
    END noop_ish;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("scopes DECLARE/BEGIN/EXCEPTION boundaries per member — a second member's statements never merge with the first's", () => {
    const body = `CREATE PACKAGE BODY p AS
      PROCEDURE a IS BEGIN INSERT INTO t1 (x) VALUES (1); END a;
      PROCEDURE b IS BEGIN INSERT INTO t2 (x) VALUES (2); END b;
    END p;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      { memberName: "a", dml: "INSERT INTO t1 (x) VALUES (1);" },
      { memberName: "b", dml: "INSERT INTO t2 (x) VALUES (2);" },
    ]);
  });

  it("strips -- line comments and /* block */ comments without misreading their contents as keywords", () => {
    const body = `CREATE PROCEDURE cmt AS
    BEGIN
      -- BEGIN this is just a comment, not a real nested block
      /* END IF; this is also just a comment, not a real statement terminator */
      INSERT INTO logs (msg) VALUES ('ok'); -- trailing note
    END cmt;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      { memberName: "cmt", dml: "INSERT INTO logs (msg) VALUES ('ok');" },
    ]);
  });

  it("handles an escaped '' single quote inside a string literal without breaking statement isolation", () => {
    const body = `CREATE PROCEDURE esc AS BEGIN INSERT INTO logs (msg) VALUES ('it''s fine'); END esc;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      { memberName: "esc", dml: "INSERT INTO logs (msg) VALUES ('it''s fine');" },
    ]);
  });

  it("skips a forward-declaration-only member with no body, and still correctly bounds/processes the next real member", () => {
    const body = `CREATE PACKAGE BODY p AS
      PROCEDURE forward_decl_only;
      PROCEDURE real_one IS BEGIN INSERT INTO t (x) VALUES (1); END real_one;
    END p;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      { memberName: "real_one", dml: "INSERT INTO t (x) VALUES (1);" },
    ]);
  });

  it("truncates a very long EXECUTE IMMEDIATE placeholder to a bounded length", () => {
    const longSql = "X".repeat(250);
    const body = `CREATE PROCEDURE longdyn AS BEGIN EXECUTE IMMEDIATE '${longSql}'; END longdyn;`;
    const result = preprocessPlsqlBody(body);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toBe("execute-immediate");
    expect(result.unresolved[0].placeholder.length).toBeLessThanOrEqual(203);
    expect(result.unresolved[0].placeholder.endsWith("...")).toBe(true);
  });

  it("treats a body with no PROCEDURE/FUNCTION header as one implicit, unnamed member", () => {
    const body = `BEGIN INSERT INTO logs (msg) VALUES ('anon'); END;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      { memberName: "", dml: "INSERT INTO logs (msg) VALUES ('anon');" },
    ]);
  });

  it("returns an empty result for a body with no PROCEDURE/FUNCTION header and no BEGIN either", () => {
    const result = preprocessPlsqlBody("PACKAGE BODY empty_pkg AS END empty_pkg;");
    expect(result).toEqual({ statements: [], unresolved: [] });
  });

  it("tolerates an empty statement (adjacent `;;`) without producing a spurious empty DML entry", () => {
    const body = `CREATE PROCEDURE dbl AS BEGIN INSERT INTO t (x) VALUES (1);; DELETE FROM t WHERE x = 1; END dbl;`;
    const result = preprocessPlsqlBody(body);
    expect(result.statements).toEqual([
      { memberName: "dbl", dml: "INSERT INTO t (x) VALUES (1);" },
      { memberName: "dbl", dml: "DELETE FROM t WHERE x = 1;" },
    ]);
  });
});
