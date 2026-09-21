import { describe, expect, it } from "vitest";
import {
  DDL_CHANGE_KINDS,
  impactAffectedTableSchema,
  isLiveSchemaSource,
  manualUsageOverrideSchema,
  schemaEdgeSchema,
  schemaSymbolSchema,
  SCHEMA_EDGE_KINDS,
  SCHEMA_RECONCILIATIONS,
  SCHEMA_SOURCE_PRECEDENCE,
  SCHEMA_SOURCES,
  SCHEMA_SYMBOL_KINDS,
} from "../src/schema-impact.js";

const validId = "clxxxxxxxx0000abcd1234efgh";
const otherId = "clyyyyyyyy0000abcd1234efgh";

describe("schema-impact domain", () => {
  describe("constants", () => {
    it("exposes schema symbol kinds (incl. procedure/function — Epic #293 #301)", () => {
      expect(SCHEMA_SYMBOL_KINDS).toEqual(["table", "column", "procedure", "function"]);
    });
    it("exposes schema edge kinds (incl. executes/calls — Epic #293 #301)", () => {
      expect(SCHEMA_EDGE_KINDS).toEqual(["reads", "writes", "persists-to", "executes", "calls"]);
    });
    it("exposes provenance sources (incl. sqlglot/manual/catalog-deps/jooq — Epic #294 #304, #881 #890, #883 #897)", () => {
      expect(SCHEMA_SOURCES).toEqual([
        "live-db",
        "mybatis",
        "orm",
        "ddl-file",
        "sqlglot",
        "manual",
        "catalog-deps",
        "jooq",
        "llm-recovery",
      ]);
    });
    it("exposes reconciliation states", () => {
      expect(SCHEMA_RECONCILIATIONS).toEqual(["matched", "table-not-found", "column-not-found"]);
    });
    it("ranks manual override above derived sources (#304)", () => {
      expect(SCHEMA_SOURCE_PRECEDENCE.manual).toBeGreaterThan(SCHEMA_SOURCE_PRECEDENCE["live-db"]);
      expect(SCHEMA_SOURCE_PRECEDENCE["live-db"]).toBeGreaterThan(SCHEMA_SOURCE_PRECEDENCE.sqlglot);
      expect(SCHEMA_SOURCE_PRECEDENCE.sqlglot).toBeGreaterThan(SCHEMA_SOURCE_PRECEDENCE.mybatis);
    });
    it("ranks Tier-1 catalog-deps below sqlglot (Tier-2 refines/overrides) and above static file-inferred sources (#890)", () => {
      expect(SCHEMA_SOURCE_PRECEDENCE.sqlglot).toBeGreaterThan(
        SCHEMA_SOURCE_PRECEDENCE["catalog-deps"],
      );
      expect(SCHEMA_SOURCE_PRECEDENCE["catalog-deps"]).toBeGreaterThan(
        SCHEMA_SOURCE_PRECEDENCE.mybatis,
      );
    });
    it("ranks the #1029 llm-recovery source below every parsed/live source", () => {
      expect(SCHEMA_SOURCE_PRECEDENCE.mybatis).toBeGreaterThan(
        SCHEMA_SOURCE_PRECEDENCE["llm-recovery"],
      );
    });
    it("exposes DDL change kinds", () => {
      expect(DDL_CHANGE_KINDS).toContain("add-column");
      expect(DDL_CHANGE_KINDS).toContain("reference");
    });
  });

  describe("schemaSymbolSchema", () => {
    it("accepts a table symbol", () => {
      const parsed = schemaSymbolSchema.parse({
        id: validId,
        projectId: otherId,
        kind: "table",
        name: "users",
        qualifiedName: "public.users",
        source: "live-db",
        columnType: null,
      });
      expect(parsed.kind).toBe("table");
    });
    it("accepts a column symbol with a live type", () => {
      const parsed = schemaSymbolSchema.parse({
        id: validId,
        projectId: otherId,
        kind: "column",
        name: "email",
        qualifiedName: "public.users.email",
        source: "live-db",
        columnType: "varchar(255)",
      });
      expect(parsed.columnType).toBe("varchar(255)");
    });
    it("rejects an unknown kind", () => {
      expect(() =>
        schemaSymbolSchema.parse({
          id: validId,
          projectId: otherId,
          kind: "view",
          name: "users",
          qualifiedName: "public.users",
          source: "live-db",
        }),
      ).toThrow();
    });
    it("rejects an empty name", () => {
      expect(() =>
        schemaSymbolSchema.parse({
          id: validId,
          projectId: otherId,
          kind: "table",
          name: "",
          qualifiedName: "public.users",
          source: "orm",
        }),
      ).toThrow();
    });
  });

  describe("schemaEdgeSchema", () => {
    it("accepts a writes edge to a resolved table", () => {
      const parsed = schemaEdgeSchema.parse({
        id: validId,
        projectId: otherId,
        kind: "writes",
        fromSymbolId: validId,
        toSymbolId: otherId,
        toQualifiedName: "public.users",
        source: "mybatis",
      });
      expect(parsed.kind).toBe("writes");
    });
    it("accepts an unresolved edge (null toSymbolId)", () => {
      const parsed = schemaEdgeSchema.parse({
        id: validId,
        projectId: otherId,
        kind: "reads",
        fromSymbolId: validId,
        toSymbolId: null,
        toQualifiedName: "public.users",
        source: "orm",
      });
      expect(parsed.toSymbolId).toBeNull();
    });
    it("rejects a non-schema code edge kind", () => {
      // `calls`/`executes` are now valid schema edge kinds (#301); use a pure
      // code-graph edge kind (`imports`) that is NOT part of the schema set.
      expect(() =>
        schemaEdgeSchema.parse({
          id: validId,
          projectId: otherId,
          kind: "imports",
          fromSymbolId: validId,
          toSymbolId: otherId,
          toQualifiedName: null,
          source: "orm",
        }),
      ).toThrow();
    });
  });

  describe("impactAffectedTableSchema", () => {
    it("accepts a table-level entry (null column)", () => {
      const parsed = impactAffectedTableSchema.parse({
        id: validId,
        impactItemId: otherId,
        tableName: "users",
        columnName: null,
        columnType: null,
        changeKind: "reference",
        suggestedDdl: null,
        source: "mybatis",
        reconciliation: null,
        confidence: 0.5,
      });
      expect(parsed.columnName).toBeNull();
    });
    it("accepts a column-level add with suggested DDL", () => {
      const parsed = impactAffectedTableSchema.parse({
        id: validId,
        impactItemId: otherId,
        tableName: "users",
        columnName: "last_login",
        columnType: "timestamp",
        changeKind: "add-column",
        suggestedDdl: "ALTER TABLE users ADD COLUMN last_login timestamp;",
        source: "live-db",
        reconciliation: "matched",
        confidence: 0.9,
      });
      expect(parsed.changeKind).toBe("add-column");
    });
    it("rejects a confidence above 1", () => {
      expect(() =>
        impactAffectedTableSchema.parse({
          id: validId,
          impactItemId: otherId,
          tableName: "users",
          columnName: null,
          columnType: null,
          changeKind: "reference",
          suggestedDdl: null,
          source: "mybatis",
          reconciliation: null,
          confidence: 1.5,
        }),
      ).toThrow();
    });
    it("rejects an empty table name", () => {
      expect(() =>
        impactAffectedTableSchema.parse({
          id: validId,
          impactItemId: otherId,
          tableName: "",
          columnName: null,
          columnType: null,
          changeKind: "reference",
          suggestedDdl: null,
          source: "mybatis",
          reconciliation: null,
          confidence: 0.5,
        }),
      ).toThrow();
    });
  });

  describe("isLiveSchemaSource", () => {
    it("is true only for live-db", () => {
      expect(isLiveSchemaSource("live-db")).toBe(true);
      expect(isLiveSchemaSource("mybatis")).toBe(false);
      expect(isLiveSchemaSource("orm")).toBe(false);
      expect(isLiveSchemaSource("ddl-file")).toBe(false);
    });
  });

  describe("manualUsageOverrideSchema (#304)", () => {
    it("accepts a column override and defaults access to reads", () => {
      const parsed = manualUsageOverrideSchema.parse({
        kind: "column",
        tableName: "orders",
        columnName: "total",
        usageClass: "used",
      });
      expect(parsed.access).toBe("reads");
      expect(parsed.columnName).toBe("total");
    });

    it("accepts a table override (no column)", () => {
      const parsed = manualUsageOverrideSchema.parse({
        kind: "table",
        tableName: "orders",
        usageClass: "unreferenced",
        access: "writes",
      });
      expect(parsed.access).toBe("writes");
    });

    it("rejects an unknown usage class", () => {
      expect(() =>
        manualUsageOverrideSchema.parse({
          kind: "table",
          tableName: "orders",
          usageClass: "bogus",
        }),
      ).toThrow();
    });

    it("rejects an empty table name", () => {
      expect(() =>
        manualUsageOverrideSchema.parse({ kind: "table", tableName: "", usageClass: "used" }),
      ).toThrow();
    });
  });
});
