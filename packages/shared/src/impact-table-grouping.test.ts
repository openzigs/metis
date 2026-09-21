import { describe, expect, it } from "vitest";
import type { ImpactAffectedTableView } from "./schema-impact.js";
import { groupImpactTables, groupRepresentative, tierRank } from "./impact-table-grouping.js";

/**
 * #1014 — this module is the SINGLE grouping/ordering implementation shared by
 * the UI (`affected-tables-section`) and the Markdown export (`analysis-export`).
 * Both delegate here, so identical input necessarily yields identical grouping and
 * the same representative row on both surfaces: the anti-drift guarantee is
 * structural (one implementation), and these tests pin its behaviour.
 */
function row(over: Partial<ImpactAffectedTableView> = {}): ImpactAffectedTableView {
  return {
    id: "r-1",
    objectKind: "table",
    tableName: "orders",
    columnName: null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: null,
    source: "mybatis",
    reconciliation: null,
    confidence: 0.5,
    ...over,
  };
}

describe("tierRank", () => {
  it("orders likely (0) < possible (1) < everything else (2)", () => {
    expect(tierRank("likely")).toBe(0);
    expect(tierRank("possible")).toBe(1);
    expect(tierRank("unlikely")).toBe(2);
    expect(tierRank(null)).toBe(2);
  });
});

describe("groupRepresentative", () => {
  it("prefers the table-level entry over the first column", () => {
    const tableEntry = row({ id: "t", columnName: null, relevanceTier: "likely" });
    const column = row({ id: "c", columnName: "orderid", relevanceTier: "possible" });
    expect(groupRepresentative({ tableName: "orders", tableEntry, columns: [column] })?.id).toBe(
      "t",
    );
  });

  it("falls back to the first column when there is no table-level entry", () => {
    const column = row({ id: "c1", columnName: "orderid" });
    expect(
      groupRepresentative({ tableName: "orders", tableEntry: null, columns: [column] })?.id,
    ).toBe("c1");
  });

  it("returns null for an empty group", () => {
    expect(groupRepresentative({ tableName: "x", tableEntry: null, columns: [] })).toBeNull();
  });
});

describe("groupImpactTables", () => {
  it("groups rows by physical table, table-level entry and its columns together", () => {
    const groups = groupImpactTables([
      row({ id: "o-t", tableName: "orders", columnName: null }),
      row({ id: "o-c", tableName: "orders", columnName: "orderid" }),
      row({ id: "a-c", tableName: "account", columnName: "userid" }),
    ]);
    const orders = groups.find((g) => g.tableName === "orders");
    expect(orders?.tableEntry?.id).toBe("o-t");
    expect(orders?.columns.map((c) => c.id)).toEqual(["o-c"]);
    const account = groups.find((g) => g.tableName === "account");
    expect(account?.tableEntry).toBeNull();
    expect(account?.columns.map((c) => c.id)).toEqual(["a-c"]);
  });

  it("orders likely before possible before the trailing bucket, ignoring name order", () => {
    const groups = groupImpactTables([
      row({ tableName: "z_unlikely", columnName: null, relevanceTier: "unlikely" }),
      row({ tableName: "a_possible", columnName: null, relevanceTier: "possible" }),
      row({ tableName: "m_likely", columnName: null, relevanceTier: "likely" }),
    ]);
    expect(groups.map((g) => g.tableName)).toEqual(["m_likely", "a_possible", "z_unlikely"]);
  });

  it("breaks ranked-bucket ties by confidence descending", () => {
    const groups = groupImpactTables([
      row({ tableName: "aaa", columnName: null, relevanceTier: "likely", confidence: 0.2 }),
      row({ tableName: "zzz", columnName: null, relevanceTier: "likely", confidence: 0.9 }),
    ]);
    expect(groups.map((g) => g.tableName)).toEqual(["zzz", "aaa"]);
  });

  it("keeps the trailing (unlikely/null) bucket in alphabetical order", () => {
    const groups = groupImpactTables([
      row({ tableName: "beta", columnName: null, relevanceTier: null, confidence: 0.9 }),
      row({ tableName: "alpha", columnName: null, relevanceTier: null, confidence: 0.1 }),
    ]);
    expect(groups.map((g) => g.tableName)).toEqual(["alpha", "beta"]);
  });

  it("resolves the #1014 divergence to FIRST-row-wins for duplicate table-level rows", () => {
    // Two columnName===null rows for one table: the FIRST is the representative
    // (the documented canonical choice), NOT the last. This is the exact behaviour
    // the UI (was last-wins) and the export (was first-wins) had to reconcile.
    const groups = groupImpactTables([
      row({ id: "first", tableName: "orders", columnName: null, relevanceRationale: "first" }),
      row({ id: "second", tableName: "orders", columnName: null, relevanceRationale: "second" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groupRepresentative(groups[0])?.id).toBe("first");
    expect(groupRepresentative(groups[0])?.relevanceRationale).toBe("first");
  });
});
