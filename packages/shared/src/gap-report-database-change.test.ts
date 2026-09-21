/**
 * Issue #825 — the gap report `databaseChanges` section's shared zod contract.
 *
 * The gap report itself is a plain TypeScript interface (assembled server-side,
 * never re-validated), so `databaseChanges` is backward compatible at the type
 * level: a requirement persisted before this change simply omits the optional
 * field. What DOES carry a runtime contract is the per-object change shape — the
 * schema-impact row (#823) joined with its cross-project consumers (#822) — and
 * these tests pin its round-trip (parse → serialize) plus the optional-field
 * tolerance that keeps it forward/backward compatible.
 */
import { describe, it, expect } from "vitest";
import {
  gapReportDatabaseChangeSchema,
  gapReportSchemaConsumerSchema,
  type GapReportDatabaseChange,
} from "./analysis.js";

const fullChange: GapReportDatabaseChange = {
  tableName: "public.orders",
  columnName: "status",
  changeKind: "add-column",
  reconciliation: "matched",
  confidence: 0.85,
  suggestedDdl: "ALTER TABLE public.orders ADD COLUMN status text;",
  riskClass: "breaking",
  identityResolved: true,
  consumers: [
    {
      projectId: "p-2",
      projectName: "billing",
      usage: "readBy",
      objectQualifiedName: "public.orders",
    },
  ],
};

describe("gapReportDatabaseChangeSchema", () => {
  it("round-trips a fully-populated change (parse → serialize) losslessly", () => {
    const parsed = gapReportDatabaseChangeSchema.parse(fullChange);
    expect(parsed).toEqual(fullChange);
    // JSON round-trip is stable — the section persists + rehydrates unchanged.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(fullChange);
  });

  it("parses a change through a JSON string round-trip", () => {
    const serialized = JSON.stringify(fullChange);
    const parsed = gapReportDatabaseChangeSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(fullChange);
  });

  it("tolerates the optional riskClass and consumers being absent (unclassified)", () => {
    const minimal = {
      tableName: "public.orders",
      columnName: null,
      changeKind: "reference" as const,
      reconciliation: null,
      confidence: 0.6,
      suggestedDdl: null,
      identityResolved: false,
    };
    const parsed = gapReportDatabaseChangeSchema.parse(minimal);
    expect(parsed.riskClass).toBeUndefined();
    expect(parsed.consumers).toBeUndefined();
    expect(parsed.identityResolved).toBe(false);
  });

  it("accepts a resolved change with an EMPTY consumer list (distinct from unknown)", () => {
    const resolvedEmpty = gapReportDatabaseChangeSchema.parse({
      ...fullChange,
      riskClass: undefined,
      consumers: [],
    });
    expect(resolvedEmpty.identityResolved).toBe(true);
    expect(resolvedEmpty.consumers).toEqual([]);
  });

  it("rejects an unknown changeKind", () => {
    expect(() =>
      gapReportDatabaseChangeSchema.parse({ ...fullChange, changeKind: "drop-database" }),
    ).toThrow();
  });

  it("rejects an unknown reconciliation status", () => {
    expect(() =>
      gapReportDatabaseChangeSchema.parse({ ...fullChange, reconciliation: "maybe" }),
    ).toThrow();
  });

  it("rejects an unknown riskClass", () => {
    expect(() =>
      gapReportDatabaseChangeSchema.parse({ ...fullChange, riskClass: "catastrophic" }),
    ).toThrow();
  });

  it("requires identityResolved to be present", () => {
    const { identityResolved: _omit, ...withoutFlag } = fullChange;
    expect(() => gapReportDatabaseChangeSchema.parse(withoutFlag)).toThrow();
  });

  it("round-trips the 3b (#831) crossProjectBreaking escalation flag", () => {
    const escalated: GapReportDatabaseChange = { ...fullChange, crossProjectBreaking: true };
    const parsed = gapReportDatabaseChangeSchema.parse(escalated);
    expect(parsed.crossProjectBreaking).toBe(true);
    expect(parsed).toEqual(escalated);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(escalated);
  });

  it("tolerates crossProjectBreaking being absent (⇒ not escalated), backward compatible", () => {
    const parsed = gapReportDatabaseChangeSchema.parse(fullChange);
    expect(parsed.crossProjectBreaking).toBeUndefined();
  });

  it("rejects a non-boolean crossProjectBreaking", () => {
    expect(() =>
      gapReportDatabaseChangeSchema.parse({ ...fullChange, crossProjectBreaking: "yes" }),
    ).toThrow();
  });
});

describe("gapReportSchemaConsumerSchema", () => {
  it("round-trips a consumer losslessly", () => {
    const consumer = {
      projectId: "p-9",
      projectName: "reporting",
      usage: "writtenBy" as const,
      objectQualifiedName: "analytics.events",
    };
    expect(gapReportSchemaConsumerSchema.parse(consumer)).toEqual(consumer);
  });

  it("rejects an invalid usage value", () => {
    expect(() =>
      gapReportSchemaConsumerSchema.parse({
        projectId: "p-9",
        projectName: "reporting",
        usage: "deletedBy",
        objectQualifiedName: "analytics.events",
      }),
    ).toThrow();
  });
});
