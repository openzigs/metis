/**
 * Unit tests for the SQL rule miner (#274).
 *
 * SQL is NOT a code-graph-parsed language, so this miner operates on `.sql`
 * file content directly. Prove it surfaces schema-level business rules: CHECK
 * constraints, NOT NULL, UNIQUE, PRIMARY/FOREIGN KEY referential rules, DEFAULT
 * values, triggers, view WHERE logic, and stored-proc conditionals — while NOT
 * over-capturing ordinary DDL noise.
 */
import { describe, expect, it } from "vitest";
import {
  mineSqlRules,
  renderMinedSqlRules,
  sqlAstConstraintKinds,
  type MinedSqlRule,
} from "./sql-rule-miner.js";

const FILE = "db/schema.sql";

function kinds(rules: MinedSqlRule[]): Set<string> {
  return new Set(rules.map((r) => r.kind));
}
function byKind(rules: MinedSqlRule[], k: MinedSqlRule["kind"]): MinedSqlRule[] {
  return rules.filter((r) => r.kind === k);
}

describe("mineSqlRules", () => {
  it("mines CHECK constraints with their condition", () => {
    const src = [
      `CREATE TABLE accounts (`,
      `  balance NUMERIC CHECK (balance >= 0),`,
      `  age INT CHECK (age BETWEEN 18 AND 120)`,
      `);`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const c = byKind(rules, "check");
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c.some((r) => r.summary.includes("balance >= 0"))).toBe(true);
    expect(c.some((r) => /age BETWEEN 18 AND 120/i.test(r.summary))).toBe(true);
  });

  it("mines NOT NULL constraints", () => {
    const src = [`CREATE TABLE users (`, `  email VARCHAR(255) NOT NULL`, `);`].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const nn = byKind(rules, "not-null");
    expect(nn.length).toBeGreaterThanOrEqual(1);
    expect(nn[0].summary).toContain("email");
  });

  it("mines UNIQUE constraints", () => {
    const src = [`CREATE TABLE users (`, `  email VARCHAR(255) UNIQUE`, `);`].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    expect(byKind(rules, "unique").length).toBeGreaterThanOrEqual(1);
  });

  it("mines PRIMARY KEY and FOREIGN KEY referential rules", () => {
    const src = [
      `CREATE TABLE orders (`,
      `  id INT PRIMARY KEY,`,
      `  user_id INT REFERENCES users(id),`,
      `  FOREIGN KEY (dept_id) REFERENCES departments(id)`,
      `);`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    expect(byKind(rules, "primary-key").length).toBeGreaterThanOrEqual(1);
    const fk = byKind(rules, "foreign-key");
    expect(fk.length).toBeGreaterThanOrEqual(2);
    expect(fk.some((r) => /users/.test(r.summary))).toBe(true);
    expect(fk.some((r) => /departments/.test(r.summary))).toBe(true);
  });

  it("mines DEFAULT values", () => {
    const src = [`CREATE TABLE t (`, `  status VARCHAR(20) DEFAULT 'active'`, `);`].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const d = byKind(rules, "default");
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d[0].summary).toContain("active");
  });

  it("mines trigger definitions", () => {
    const src = [
      `CREATE TRIGGER audit_update`,
      `AFTER UPDATE ON accounts`,
      `FOR EACH ROW EXECUTE FUNCTION log_change();`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const t = byKind(rules, "trigger");
    expect(t.length).toBeGreaterThanOrEqual(1);
    expect(t[0].summary).toMatch(/audit_update/);
  });

  it("mines view WHERE logic", () => {
    const src = [
      `CREATE VIEW active_users AS`,
      `SELECT * FROM users WHERE status = 'active' AND deleted_at IS NULL;`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const v = byKind(rules, "view-filter");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].summary).toMatch(/status = 'active'/);
  });

  it("mines stored-procedure / function conditional logic (IF)", () => {
    const src = [
      `CREATE FUNCTION apply_discount(p NUMERIC) RETURNS NUMERIC AS $$`,
      `BEGIN`,
      `  IF p > 1000 THEN`,
      `    RETURN p * 0.9;`,
      `  END IF;`,
      `  RETURN p;`,
      `END;`,
      `$$ LANGUAGE plpgsql;`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const cond = byKind(rules, "proc-conditional");
    expect(cond.length).toBeGreaterThanOrEqual(1);
    expect(cond[0].summary).toMatch(/p > 1000/);
  });

  it("does NOT over-capture plain column declarations", () => {
    const src = [`CREATE TABLE t (`, `  id INT,`, `  name TEXT,`, `  notes TEXT`, `);`].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    // Plain columns with no constraint produce no rules.
    expect(rules).toHaveLength(0);
  });

  it("ignores comments and blank lines", () => {
    const src = [`-- a schema`, ``, `/* block */`].join("\n");
    expect(mineSqlRules(src, FILE, 1)).toHaveLength(0);
  });

  it("reports accurate line numbers offset from baseLine", () => {
    const src = [`CREATE TABLE t (`, `  age INT CHECK (age > 0)`, `);`].join("\n");
    const rules = mineSqlRules(src, FILE, 100);
    const c = byKind(rules, "check");
    expect(c[0].line).toBe(101);
  });

  it("truncates a runaway expression", () => {
    const long = `  c INT CHECK (${"a = 1 AND ".repeat(80)} b = 1)`;
    const src = [`CREATE TABLE t (`, long, `);`].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].expression.length).toBeLessThanOrEqual(200);
  });

  it("handles a realistic schema slice end to end", () => {
    const src = [
      `CREATE TABLE invoices (`,
      `  id SERIAL PRIMARY KEY,`,
      `  customer_id INT NOT NULL REFERENCES customers(id),`,
      `  amount NUMERIC(12,2) CHECK (amount > 0),`,
      `  status VARCHAR(20) DEFAULT 'draft',`,
      `  invoice_no VARCHAR(32) UNIQUE`,
      `);`,
      `CREATE VIEW paid_invoices AS`,
      `SELECT * FROM invoices WHERE status = 'paid';`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const ks = kinds(rules);
    expect(ks).toContain("primary-key");
    expect(ks).toContain("not-null");
    expect(ks).toContain("foreign-key");
    expect(ks).toContain("check");
    expect(ks).toContain("default");
    expect(ks).toContain("unique");
    expect(ks).toContain("view-filter");
  });

  it("does NOT mine DML data rows (INSERT/UPDATE) as rules (#278)", () => {
    // A file mixing DDL (which IS rule-bearing) with INSERT/UPDATE data rows
    // (which are NOT business rules — just seed data). Only the DDL must be
    // mined. Data values that happen to contain rule-ish words like
    // 'NOT NULL' or 'DEFAULT' inside string literals must NOT become rules.
    const src = [
      `CREATE TABLE products (`,
      `  id INT PRIMARY KEY,`,
      `  name VARCHAR(100) NOT NULL,`,
      `  price NUMERIC CHECK (price > 0)`,
      `);`,
      `INSERT INTO products (id, name, price) VALUES`,
      `  (1, 'Widget NOT NULL DEFAULT', 9.99),`,
      `  (2, 'Gadget UNIQUE PRIMARY KEY', 19.99);`,
      `UPDATE products SET name = 'Renamed NOT NULL' WHERE id = 1;`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    // DDL rules ARE mined.
    expect(byKind(rules, "primary-key").length).toBeGreaterThanOrEqual(1);
    expect(byKind(rules, "not-null").length).toBeGreaterThanOrEqual(1);
    expect(byKind(rules, "check").length).toBeGreaterThanOrEqual(1);
    // No rule may originate from the INSERT/UPDATE data lines (lines 6-9).
    const dmlLines = rules.filter((r) => r.line >= 6);
    expect(dmlLines).toHaveLength(0);
    // Specifically, the data-row string literals must not be mined.
    expect(rules.some((r) => /Widget|Gadget|Renamed/.test(r.expression))).toBe(false);
  });

  it("survives unparseable SQL via the literal fallback", () => {
    // Dialect-specific syntax node-sql-parser may reject — fallback still mines.
    const src = [
      `CREATE TABLE t (`,
      `  x INT CHECK (x > 0) /*+ HINT */,`,
      `  y INT NOT NULL`,
      `) ENGINE=InnoDB PARTITION BY HASH(x);`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    expect(kinds(rules)).toContain("check");
    expect(kinds(rules)).toContain("not-null");
  });
});

describe("sqlAstConstraintKinds", () => {
  it("recovers constraint kinds via the node-sql-parser AST", () => {
    const src = [
      `CREATE TABLE users (`,
      `  id INTEGER PRIMARY KEY,`,
      `  email VARCHAR(255) NOT NULL UNIQUE,`,
      `  age INT CHECK (age >= 18),`,
      `  status VARCHAR(20) DEFAULT 'active',`,
      `  dept_id INT REFERENCES departments(id)`,
      `);`,
    ].join("\n");
    const kinds = sqlAstConstraintKinds(src);
    expect(kinds.has("primary-key")).toBe(true);
    expect(kinds.has("not-null")).toBe(true);
    expect(kinds.has("unique")).toBe(true);
    expect(kinds.has("check")).toBe(true);
    expect(kinds.has("default")).toBe(true);
    expect(kinds.has("foreign-key")).toBe(true);
  });

  it("returns an empty set on unparseable SQL", () => {
    const kinds = sqlAstConstraintKinds(`THIS IS NOT SQL @@@ ;;;`);
    expect(kinds.size).toBe(0);
  });
});

describe("renderMinedSqlRules", () => {
  it("returns empty string for no rules", () => {
    expect(renderMinedSqlRules([])).toBe("");
  });

  it("groups rules under labelled headings", () => {
    const src = [
      `CREATE TABLE t (`,
      `  id INT PRIMARY KEY,`,
      `  e TEXT NOT NULL UNIQUE,`,
      `  a INT CHECK (a > 0),`,
      `  s TEXT DEFAULT 'x'`,
      `);`,
    ].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const out = renderMinedSqlRules(rules);
    expect(out).toMatch(/CHECK|NOT NULL|UNIQUE|Primary|Foreign|DEFAULT/);
  });

  it("honours the maxChars budget", () => {
    const cols = Array.from({ length: 200 }, (_, i) => `  c${i} INT CHECK (c${i} > 0),`).join("\n");
    const src = [`CREATE TABLE big (`, cols, `  last INT`, `);`].join("\n");
    const rules = mineSqlRules(src, FILE, 1);
    const out = renderMinedSqlRules(rules, 500);
    expect(out.length).toBeLessThan(700);
    expect(out).toMatch(/truncated for prompt budget/);
  });
});
