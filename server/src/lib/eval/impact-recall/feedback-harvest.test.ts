/**
 * Tests for the #966 feedback-harvest aggregation — pure function, no I/O.
 */
import { describe, it, expect } from "vitest";
import { buildFeedbackHarvest, type HarvestFeedbackRow } from "./feedback-harvest.js";

function row(over: Partial<HarvestFeedbackRow> = {}): HarvestFeedbackRow {
  return {
    impactItemId: "item-1",
    requirementTitle: "Add a discontinued flag to product",
    tableName: "product",
    verdict: "relevant",
    ...over,
  };
}

describe("buildFeedbackHarvest", () => {
  it("returns an empty report for no rows", () => {
    const report = buildFeedbackHarvest([]);
    expect(report).toMatchObject({
      version: 1,
      source: "feedback-harvest",
      requirementCount: 0,
      feedbackCount: 0,
      requirements: [],
    });
  });

  it("groups rows by impactItemId into one fragment", () => {
    const report = buildFeedbackHarvest([
      row({ tableName: "product" }),
      row({ tableName: "category" }),
    ]);
    expect(report.requirementCount).toBe(1);
    expect(report.feedbackCount).toBe(2);
    expect(report.requirements[0]).toMatchObject({
      id: "feedback:item-1",
      text: "Add a discontinued flag to product",
      expectedTables: ["category", "product"],
      notRelevantTables: [],
      markCount: 2,
    });
  });

  it("uses a fallback text when the item has no linked requirement", () => {
    const report = buildFeedbackHarvest([row({ requirementTitle: null })]);
    expect(report.requirements[0].text).toBe("Impact item item-1");
  });

  it("prefers the first non-null requirement title across rows of the same item", () => {
    const report = buildFeedbackHarvest([
      row({ requirementTitle: null, tableName: "a" }),
      row({ requirementTitle: "Real title", tableName: "b" }),
    ]);
    expect(report.requirements[0].text).toBe("Real title");
  });

  it("dedupes a table name marked relevant by multiple users into one entry", () => {
    const report = buildFeedbackHarvest([
      row({ tableName: "product" }),
      row({ tableName: "product" }),
    ]);
    expect(report.requirements[0].expectedTables).toEqual(["product"]);
    expect(report.requirements[0].markCount).toBe(2);
  });

  it("puts not-relevant marks into notRelevantTables, not expectedTables", () => {
    const report = buildFeedbackHarvest([row({ tableName: "audit_log", verdict: "not-relevant" })]);
    expect(report.requirements[0].expectedTables).toEqual([]);
    expect(report.requirements[0].notRelevantTables).toEqual(["audit_log"]);
  });

  it("keeps a disagreed-upon table in BOTH lists rather than silently resolving it", () => {
    const report = buildFeedbackHarvest([
      row({ tableName: "orders", verdict: "relevant" }),
      row({ tableName: "orders", verdict: "not-relevant" }),
    ]);
    expect(report.requirements[0].expectedTables).toEqual(["orders"]);
    expect(report.requirements[0].notRelevantTables).toEqual(["orders"]);
  });

  it("emits one fragment per distinct impactItemId, sorted deterministically", () => {
    const report = buildFeedbackHarvest([
      row({ impactItemId: "item-b", tableName: "b" }),
      row({ impactItemId: "item-a", tableName: "a" }),
    ]);
    expect(report.requirements.map((r) => r.id)).toEqual(["feedback:item-a", "feedback:item-b"]);
  });

  it("sorts expectedTables/notRelevantTables alphabetically", () => {
    const report = buildFeedbackHarvest([row({ tableName: "zebra" }), row({ tableName: "apple" })]);
    expect(report.requirements[0].expectedTables).toEqual(["apple", "zebra"]);
  });

  it("uses the caller-supplied generatedAt when provided", () => {
    const report = buildFeedbackHarvest([], { generatedAt: "2026-07-20T00:00:00.000Z" });
    expect(report.generatedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  it("includes a human-review note (never auto-merged)", () => {
    const report = buildFeedbackHarvest([]);
    expect(report.note).toMatch(/human/i);
    expect(report.note).toMatch(/CAPTURE-ONLY/i);
  });
});
