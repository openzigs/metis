/**
 * Tests for the deterministic DDL risk classifier (#830). The classifier is pure
 * and LLM-free, so these are exhaustive, property-style unit tests over the
 * `changeKind × type` matrix plus the type-narrowing vs widening branches.
 */
import { describe, it, expect } from "vitest";
import type { DdlChangeKind } from "@metis/shared";
import { DDL_CHANGE_KINDS } from "@metis/shared";
import { classifyDdlRisk, columnWidthDirection } from "./ddl-risk-classifier.js";

describe("classifyDdlRisk — changeKind mapping", () => {
  it("classifies drop-column as breaking (a contract operation)", () => {
    expect(classifyDdlRisk({ changeKind: "drop-column" })).toBe("breaking");
    expect(
      classifyDdlRisk({
        changeKind: "drop-column",
        suggestedDdl: "ALTER TABLE public.orders DROP COLUMN status;",
      }),
    ).toBe("breaking");
  });

  it("classifies add-table as expanding (a brand-new table breaks no consumer)", () => {
    expect(classifyDdlRisk({ changeKind: "add-table" })).toBe("expanding");
    // Even a NOT NULL column on a NEW table is safe — there are no existing rows.
    expect(
      classifyDdlRisk({
        changeKind: "add-table",
        suggestedDdl: "CREATE TABLE public.audit (id int NOT NULL);",
      }),
    ).toBe("expanding");
  });

  it("classifies reference as neutral (verify-only, no structural change)", () => {
    expect(classifyDdlRisk({ changeKind: "reference" })).toBe("neutral");
    expect(
      classifyDdlRisk({
        changeKind: "reference",
        reconciliation: "matched",
        suggestedDdl: "-- Verify column public.orders.status — referenced by impacted code",
      }),
    ).toBe("neutral");
  });

  it("classifies an unknown/ambiguous change kind conservatively as breaking", () => {
    // A future DdlChangeKind must never fall through to a silent neutral.
    expect(classifyDdlRisk({ changeKind: "totally-new-kind" as DdlChangeKind })).toBe("breaking");
  });

  it("maps every real DdlChangeKind to a documented, non-null risk class", () => {
    for (const changeKind of DDL_CHANGE_KINDS) {
      const risk = classifyDdlRisk({ changeKind });
      expect(["breaking", "expanding", "neutral"]).toContain(risk);
    }
  });
});

describe("classifyDdlRisk — add-column (additive vs NOT NULL without default)", () => {
  it("is expanding for a plain nullable add-column", () => {
    expect(
      classifyDdlRisk({
        changeKind: "add-column",
        suggestedDdl: "ALTER TABLE public.orders ADD COLUMN status text;",
      }),
    ).toBe("expanding");
  });

  it("is expanding when there is no suggestedDdl or type at all", () => {
    expect(classifyDdlRisk({ changeKind: "add-column" })).toBe("expanding");
  });

  it("is breaking for add-column NOT NULL without a default (breaks existing inserts)", () => {
    expect(
      classifyDdlRisk({
        changeKind: "add-column",
        suggestedDdl: "ALTER TABLE public.orders ADD COLUMN status text NOT NULL;",
      }),
    ).toBe("breaking");
  });

  it("detects NOT NULL from the columnTypeAfter as well as the DDL text", () => {
    expect(classifyDdlRisk({ changeKind: "add-column", columnTypeAfter: "text NOT NULL" })).toBe(
      "breaking",
    );
  });

  it("is expanding for add-column NOT NULL WITH a default (safe backfill)", () => {
    expect(
      classifyDdlRisk({
        changeKind: "add-column",
        suggestedDdl: "ALTER TABLE public.orders ADD COLUMN status text NOT NULL DEFAULT 'new';",
      }),
    ).toBe("expanding");
  });
});

describe("classifyDdlRisk — alter-column (narrow/tighten vs widen)", () => {
  it("is expanding when the type widens (int → bigint)", () => {
    expect(
      classifyDdlRisk({
        changeKind: "alter-column",
        columnTypeBefore: "int",
        columnTypeAfter: "bigint",
      }),
    ).toBe("expanding");
  });

  it("is breaking when the type narrows (bigint → int)", () => {
    expect(
      classifyDdlRisk({
        changeKind: "alter-column",
        columnTypeBefore: "bigint",
        columnTypeAfter: "int",
      }),
    ).toBe("breaking");
  });

  it("is expanding when the type is unchanged and nullability is not tightened", () => {
    expect(
      classifyDdlRisk({
        changeKind: "alter-column",
        columnTypeBefore: "varchar(50)",
        columnTypeAfter: "varchar(50)",
      }),
    ).toBe("expanding");
  });

  it("is breaking when before/after types are unknown (conservative default)", () => {
    expect(classifyDdlRisk({ changeKind: "alter-column" })).toBe("breaking");
    expect(classifyDdlRisk({ changeKind: "alter-column", columnTypeBefore: "int" })).toBe(
      "breaking",
    );
    expect(classifyDdlRisk({ changeKind: "alter-column", columnTypeAfter: "int" })).toBe(
      "breaking",
    );
  });

  it("is breaking when nullability tightens even if the type widens", () => {
    expect(
      classifyDdlRisk({
        changeKind: "alter-column",
        columnTypeBefore: "int",
        columnTypeAfter: "bigint NOT NULL",
      }),
    ).toBe("breaking");
  });

  it("is expanding when nullability RELAXES on the same type", () => {
    expect(
      classifyDdlRisk({
        changeKind: "alter-column",
        columnTypeBefore: "int NOT NULL",
        columnTypeAfter: "int",
      }),
    ).toBe("expanding");
  });

  it("is breaking for a cross-family type change (varchar → int)", () => {
    expect(
      classifyDdlRisk({
        changeKind: "alter-column",
        columnTypeBefore: "varchar(50)",
        columnTypeAfter: "int",
      }),
    ).toBe("breaking");
  });
});

describe("classifyDdlRisk — destructive DROP safety net", () => {
  it("is breaking for a DROP TABLE in the text regardless of changeKind", () => {
    expect(
      classifyDdlRisk({
        changeKind: "reference",
        suggestedDdl: "DROP TABLE public.orders;",
      }),
    ).toBe("breaking");
  });

  it("is breaking for a DROP COLUMN in the text even under add-column", () => {
    expect(
      classifyDdlRisk({
        changeKind: "add-column",
        suggestedDdl: "ALTER TABLE public.orders DROP COLUMN legacy;",
      }),
    ).toBe("breaking");
  });
});

describe("classifyDdlRisk — determinism & purity", () => {
  it("returns the same result for the same input (no hidden state)", () => {
    const input = {
      changeKind: "alter-column" as const,
      columnTypeBefore: "varchar(50)",
      columnTypeAfter: "varchar(100)",
    };
    const first = classifyDdlRisk(input);
    const second = classifyDdlRisk(input);
    expect(first).toBe("expanding");
    expect(second).toBe(first);
  });

  it("ignores the reconciliation field (changeKind already encodes it)", () => {
    const base = { changeKind: "reference" as const } as const;
    expect(classifyDdlRisk({ ...base, reconciliation: "matched" })).toBe("neutral");
    expect(classifyDdlRisk({ ...base, reconciliation: "table-not-found" })).toBe("neutral");
    expect(classifyDdlRisk({ ...base, reconciliation: null })).toBe("neutral");
  });
});

describe("columnWidthDirection — type comparison", () => {
  it("ranks integer widths (tinyint < smallint < int < bigint)", () => {
    expect(columnWidthDirection("smallint", "bigint")).toBe("widen");
    expect(columnWidthDirection("bigint", "smallint")).toBe("narrow");
    expect(columnWidthDirection("int", "integer")).toBe("same");
    expect(columnWidthDirection("tinyint", "int")).toBe("widen");
  });

  it("canonicalizes multiword and aliased spellings", () => {
    expect(columnWidthDirection("int4", "int8")).toBe("widen");
    expect(columnWidthDirection("float4", "double precision")).toBe("widen");
    expect(columnWidthDirection("character varying(10)", "character varying(20)")).toBe("widen");
  });

  it("compares string lengths and treats text/clob as unbounded", () => {
    expect(columnWidthDirection("varchar(50)", "varchar(100)")).toBe("widen");
    expect(columnWidthDirection("varchar(100)", "varchar(50)")).toBe("narrow");
    expect(columnWidthDirection("varchar(50)", "text")).toBe("widen");
    expect(columnWidthDirection("text", "varchar(50)")).toBe("narrow");
    expect(columnWidthDirection("char(10)", "char(10)")).toBe("same");
  });

  it("compares binary lengths and unbounded blobs", () => {
    expect(columnWidthDirection("varbinary(16)", "varbinary(32)")).toBe("widen");
    expect(columnWidthDirection("binary(32)", "bytea")).toBe("widen");
  });

  it("compares decimal precision and scale, and flags mixed changes as unknown", () => {
    expect(columnWidthDirection("numeric(10,2)", "numeric(12,2)")).toBe("widen");
    expect(columnWidthDirection("numeric(12,2)", "numeric(10,2)")).toBe("narrow");
    expect(columnWidthDirection("numeric(10,2)", "numeric(10,2)")).toBe("same");
    // Precision up but scale up so far the integer part shrinks ⇒ unknown.
    expect(columnWidthDirection("numeric(10,2)", "numeric(11,6)")).toBe("unknown");
  });

  it("is unknown for cross-family, empty, or unrecognized types", () => {
    expect(columnWidthDirection("varchar(50)", "int")).toBe("unknown");
    expect(columnWidthDirection("", "int")).toBe("unknown");
    expect(columnWidthDirection("int", null)).toBe("unknown");
    expect(columnWidthDirection("geometry", "geometry")).toBe("unknown");
  });

  it("strips trailing constraints before comparing the type shape", () => {
    expect(columnWidthDirection("int NOT NULL", "bigint NOT NULL")).toBe("widen");
    expect(columnWidthDirection("varchar(50) DEFAULT 'x'", "varchar(80) DEFAULT 'x'")).toBe(
      "widen",
    );
  });

  it("tolerates missing type arguments and a malformed unclosed paren", () => {
    // decimal precision only (no scale) — scale defaults to 0.
    expect(columnWidthDirection("numeric(10)", "numeric(12)")).toBe("widen");
    // a bounded type declared with no length is treated as unbounded (∞).
    expect(columnWidthDirection("varchar", "varchar(50)")).toBe("narrow");
    expect(columnWidthDirection("varbinary", "varbinary(16)")).toBe("narrow");
    // a malformed, unclosed paren still parses the leading number.
    expect(columnWidthDirection("varchar(50", "varchar(80")).toBe("widen");
  });
});
