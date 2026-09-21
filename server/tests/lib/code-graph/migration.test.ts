/**
 * Issue #306 — CodeGraph data-model migration sanity.
 *
 * Reads the migration SQL and the two Prisma schema files and asserts the
 * documented tables, columns, and indexes are present.
 *
 * The MCP-tools sub-issue (#310) reads against these specific indexes; if any
 * disappear in a future refactor this test catches it before query plans
 * regress to full table scans.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const migrationSql = readFileSync(
  join(
    repoRoot,
    "server/prisma/migrations/20260507000000_add_code_graph_and_finding_provenance/migration.sql",
  ),
  "utf-8",
);
const sqliteSchema = readFileSync(join(repoRoot, "server/prisma/schema.prisma"), "utf-8");
const postgresSchema = readFileSync(
  join(repoRoot, "server/prisma/postgres/schema.prisma"),
  "utf-8",
);

describe("CodeGraph migration (#306)", () => {
  describe("tables", () => {
    it.each(["code_graphs", "code_symbols", "code_edges"])("creates the %s table", (table) => {
      expect(migrationSql).toMatch(new RegExp(`CREATE TABLE "${table}"`));
    });
  });

  describe("CodeSymbol indexes (#306 AC: who_calls, outline, defined_in)", () => {
    const required = [
      "code_symbols_projectId_kind_idx",
      "code_symbols_projectId_qualifiedName_idx",
      "code_symbols_codeGraphId_filePath_idx",
    ];
    it.each(required)("declares index %s", (idx) => {
      expect(migrationSql).toMatch(new RegExp(`CREATE INDEX "${idx}"`));
    });
  });

  describe("CodeEdge indexes (#306 AC: who_calls)", () => {
    const required = [
      "code_edges_fromSymbolId_kind_idx",
      "code_edges_toSymbolId_kind_idx",
      "code_edges_projectId_kind_idx",
      "code_edges_codeGraphId_filePath_idx",
    ];
    it.each(required)("declares index %s", (idx) => {
      expect(migrationSql).toMatch(new RegExp(`CREATE INDEX "${idx}"`));
    });
  });

  describe("Finding provenance columns (#309)", () => {
    // These columns exist in the Prisma schema but were removed from THIS
    // migration because they already exist from an earlier migration
    // (20260430145720_epic_396_speckit_features). Verify via schema instead.
    it("has derivation column with 'inferred' default in SQLite schema", () => {
      expect(sqliteSchema).toContain('derivation    String   @default("inferred")');
    });

    it("has confidence column with 0.7 default in SQLite schema", () => {
      expect(sqliteSchema).toContain("confidence    Float    @default(0.7)");
    });

    it("has nullable symbolId in SQLite schema", () => {
      expect(sqliteSchema).toMatch(/symbolId\s+String\?/);
    });

    it("has derivation column in Postgres schema", () => {
      expect(postgresSchema).toContain('derivation    String   @default("inferred")');
    });
  });

  describe("schema parity (SQLite ↔ Postgres)", () => {
    const requiredModels = ["model CodeGraph", "model CodeSymbol", "model CodeEdge"];

    it.each(requiredModels)("declares %s in SQLite schema", (model) => {
      expect(sqliteSchema).toContain(model);
    });

    it.each(requiredModels)("declares %s in Postgres schema", (model) => {
      expect(postgresSchema).toContain(model);
    });

    const requiredCols = [
      'derivation    String   @default("inferred")',
      "confidence    Float    @default(0.7)",
    ];

    it.each(requiredCols)("Finding has %s in SQLite schema", (col) => {
      expect(sqliteSchema).toContain(col);
    });

    it.each(requiredCols)("Finding has %s in Postgres schema", (col) => {
      expect(postgresSchema).toContain(col);
    });
  });

  describe("Foreign key cascades", () => {
    it("Project deletion cascades to CodeGraph", () => {
      expect(migrationSql).toMatch(
        /code_graphs_projectId_fkey.*REFERENCES "projects".*ON DELETE CASCADE/s,
      );
    });

    it("CodeSymbol deletion cascades fromEdges", () => {
      expect(migrationSql).toMatch(
        /code_edges_fromSymbolId_fkey.*REFERENCES "code_symbols".*ON DELETE CASCADE/s,
      );
    });

    it("CodeSymbol deletion nulls toSymbolId on inbound edges (preserves history)", () => {
      expect(migrationSql).toMatch(
        /code_edges_toSymbolId_fkey.*REFERENCES "code_symbols".*ON DELETE SET NULL/s,
      );
    });

    it("RepoConnection deletion nulls CodeGraph.repoConnectionId (graph survives)", () => {
      expect(migrationSql).toMatch(
        /code_graphs_repoConnectionId_fkey.*REFERENCES "repo_connections".*ON DELETE SET NULL/s,
      );
    });
  });
});
