import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { ImpactAffectedTableView, ImpactItemView } from "@metis/shared";
import {
  affectedTableCountLabel,
  buildRequirementMatrix,
  RequirementImpactMatrix,
} from "@/components/impact/requirement-impact-matrix";

function affectedTable(over: Partial<ImpactAffectedTableView> = {}): ImpactAffectedTableView {
  return {
    id: "t-1",
    objectKind: "table",
    tableName: "orders",
    columnName: null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: null,
    source: "mybatis",
    reconciliation: null,
    confidence: 0.7,
    ...over,
  };
}

function item(over: Partial<ImpactItemView> = {}): ImpactItemView {
  return {
    id: "item-1",
    projectId: "project-001",
    requirementId: "req-1",
    requirementTitle: "Track order status",
    changeType: "modified",
    severity: "medium",
    impactScore: 0.55,
    confidence: 0.8,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedFileCount: 1,
    affectedSymbolCount: 1,
    affectedSymbols: [],
    affectedTables: [],
    affectedTablesSecondary: [],
    affectedTests: [],
    writePathGaps: [],
    feedback: [],
    summary: null,
    ...over,
  };
}

describe("affectedTableCountLabel (#985 #2)", () => {
  it("counts DISTINCT tables, not table+column rows", () => {
    // One table with 56 column-level rows should read "1 table", not "56 table(s)".
    const rows = Array.from({ length: 56 }, (_, i) =>
      affectedTable({ id: `c-${i}`, objectKind: "column", columnName: `col_${i}` }),
    );
    expect(affectedTableCountLabel(rows)).toBe("1 table · 56 objects");
  });

  it("counts multiple distinct tables correctly", () => {
    const rows = [
      affectedTable({ id: "a", tableName: "orders" }),
      affectedTable({ id: "b", tableName: "orders", objectKind: "column", columnName: "status" }),
      affectedTable({ id: "c", tableName: "order_items" }),
      affectedTable({ id: "d", tableName: "customers" }),
      affectedTable({ id: "e", tableName: "customers", objectKind: "column", columnName: "email" }),
    ];
    // 3 distinct tables (orders, order_items, customers), 5 total rows.
    expect(affectedTableCountLabel(rows)).toBe("3 tables · 5 objects");
  });

  it("never renders '1 tables' — singular pluralization for exactly one table", () => {
    expect(affectedTableCountLabel([affectedTable()])).toBe("1 table · 1 object");
  });

  it("renders '0 tables · 0 objects' for an empty list", () => {
    expect(affectedTableCountLabel([])).toBe("0 tables · 0 objects");
  });
});

describe("buildRequirementMatrix", () => {
  it("groups items by requirement key and ranks by aggregate score", () => {
    const rows = buildRequirementMatrix(
      [
        item({ id: "i1", requirementId: "req-1", projectId: "p1", impactScore: 0.2 }),
        item({ id: "i2", requirementId: "req-2", projectId: "p1", impactScore: 0.9 }),
      ],
      [{ id: "p1", name: "Alpha" }],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe("req-2");
    expect(rows[1].key).toBe("req-1");
  });

  it("keeps the stronger of two duplicate (requirement, project) items", () => {
    const rows = buildRequirementMatrix(
      [
        item({ id: "weak", requirementId: "req-1", projectId: "p1", impactScore: 0.2 }),
        item({ id: "strong", requirementId: "req-1", projectId: "p1", impactScore: 0.8 }),
      ],
      [{ id: "p1", name: "Alpha" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].itemsByProject["p1"]?.id).toBe("strong");
    expect(rows[0].aggregateScore).toBeCloseTo(0.8);
    expect(rows[0].impactedProjectCount).toBe(1);
  });
});

describe("RequirementImpactMatrix", () => {
  it("shows the empty state when there are no items", () => {
    render(<RequirementImpactMatrix items={[]} projects={[{ id: "p1", name: "Alpha" }]} />);
    expect(screen.getByTestId("requirement-matrix-empty")).toBeInTheDocument();
  });

  it("renders the distinct-table count chip in the single-project list view", () => {
    render(
      <RequirementImpactMatrix
        items={[
          item({
            affectedTables: [
              affectedTable({ id: "a", tableName: "orders" }),
              affectedTable({
                id: "b",
                tableName: "orders",
                objectKind: "column",
                columnName: "status",
              }),
            ],
          }),
        ]}
        projects={[{ id: "project-001", name: "Alpha" }]}
      />,
    );
    expect(screen.getByTestId("matrix-cell-tables")).toHaveTextContent("1 table · 2 objects");
  });

  it("opens the drilldown detail on row click and closes it", () => {
    render(
      <RequirementImpactMatrix
        items={[item()]}
        projects={[{ id: "project-001", name: "Alpha" }]}
      />,
    );
    fireEvent.click(screen.getByTestId("requirement-matrix-list-row"));
    expect(screen.getByTestId("requirement-matrix-drilldown")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("requirement-matrix-drilldown-close"));
    expect(screen.queryByTestId("requirement-matrix-drilldown")).not.toBeInTheDocument();
  });

  it("renders the multi-project table view with a chip per populated cell", () => {
    render(
      <RequirementImpactMatrix
        items={[
          item({
            id: "i1",
            projectId: "project-001",
            affectedTables: [affectedTable({ tableName: "orders" })],
          }),
          item({
            id: "i2",
            projectId: "project-002",
            affectedTables: [
              affectedTable({ tableName: "orders" }),
              affectedTable({ tableName: "order_items" }),
            ],
          }),
        ]}
        projects={[
          { id: "project-001", name: "Alpha" },
          { id: "project-002", name: "Beta" },
        ]}
      />,
    );
    const table = screen.getByTestId("requirement-matrix-table");
    const cells = within(table).getAllByTestId("matrix-cell-tables");
    expect(cells[0]).toHaveTextContent("1 table · 1 object");
    expect(cells[1]).toHaveTextContent("2 tables · 2 objects");
  });

  it("opens the drilldown from a multi-project table cell click", () => {
    render(
      <RequirementImpactMatrix
        items={[item({ id: "i1", projectId: "project-001" })]}
        projects={[
          { id: "project-001", name: "Alpha" },
          { id: "project-002", name: "Beta" },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("matrix-cell-button"));
    expect(screen.getByTestId("requirement-matrix-drilldown")).toBeInTheDocument();
  });

  it("renders an empty-dash cell for a project with no impact on that requirement", () => {
    render(
      <RequirementImpactMatrix
        items={[item({ id: "i1", projectId: "project-001" })]}
        projects={[
          { id: "project-001", name: "Alpha" },
          { id: "project-002", name: "Beta" },
        ]}
      />,
    );
    expect(screen.getByTestId("matrix-cell-empty")).toBeInTheDocument();
  });
});
