/**
 * #964 — RequirementImpactMatrix tests.
 *
 * Covers the pure `buildRequirementMatrix` grouping/ranking and the rendered
 * matrix: ranked requirements × projects, cell drill-down to the existing item
 * detail, and single-project degradation to a ranked list.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ImpactItemView } from "@metis/shared";
import {
  buildRequirementMatrix,
  RequirementImpactMatrix,
  type MatrixProject,
} from "./requirement-impact-matrix";

function item(overrides: Partial<ImpactItemView> = {}): ImpactItemView {
  return {
    id: "it-1",
    projectId: "p1",
    requirementId: null,
    requirementTitle: "Password reset",
    changeType: "added",
    severity: "medium",
    impactScore: 0.5,
    confidence: 0.5,
    matchQuality: "moderate",
    matchQualityReason: null,
    affectedFileCount: 1,
    affectedSymbolCount: 1,
    summary: null,
    affectedSymbols: [
      {
        id: `${overrides.id ?? "it-1"}-s1`,
        codeSymbolId: "cs1",
        filePath: "src/Foo.java",
        qualifiedName: "com.example.Foo.bar",
        startLine: 1,
        endLine: 2,
        relation: "direct",
        depth: 0,
        confidence: 0.5,
      },
    ],
    affectedTables: [],
    affectedTablesSecondary: [],
    affectedTests: [],
    writePathGaps: [],
    feedback: [],
    ...overrides,
  };
}

const P1: MatrixProject = { id: "p1", name: "Checkout" };
const P2: MatrixProject = { id: "p2", name: "Billing" };

describe("buildRequirementMatrix (#964)", () => {
  it("groups items by requirement across projects and aligns cells to columns", () => {
    const rows = buildRequirementMatrix(
      [
        item({ id: "a", projectId: "p1", requirementTitle: "Password reset", impactScore: 0.4 }),
        item({ id: "b", projectId: "p2", requirementTitle: "Password reset", impactScore: 0.3 }),
        item({ id: "c", projectId: "p1", requirementTitle: "Session timeout", impactScore: 0.9 }),
      ],
      [P1, P2],
    );
    expect(rows).toHaveLength(2);
    const pw = rows.find((r) => r.title === "Password reset")!;
    expect(pw.itemsByProject.p1?.id).toBe("a");
    expect(pw.itemsByProject.p2?.id).toBe("b");
    expect(pw.aggregateScore).toBeCloseTo(0.7);
    expect(pw.impactedProjectCount).toBe(2);
  });

  it("ranks rows by aggregate impact descending", () => {
    const rows = buildRequirementMatrix(
      [
        item({ id: "a", projectId: "p1", requirementTitle: "Low", impactScore: 0.2 }),
        item({ id: "b", projectId: "p1", requirementTitle: "High", impactScore: 0.9 }),
      ],
      [P1, P2],
    );
    expect(rows.map((r) => r.title)).toEqual(["High", "Low"]);
  });

  it("leaves a null cell for a project with no impact on that requirement", () => {
    const rows = buildRequirementMatrix(
      [item({ id: "a", projectId: "p1", requirementTitle: "Only P1", impactScore: 0.5 })],
      [P1, P2],
    );
    expect(rows[0].itemsByProject.p1?.id).toBe("a");
    expect(rows[0].itemsByProject.p2).toBeNull();
  });

  it("keeps the stronger item when a (requirement, project) pair is duplicated", () => {
    const rows = buildRequirementMatrix(
      [
        item({ id: "weak", projectId: "p1", requirementTitle: "Dup", impactScore: 0.2 }),
        item({ id: "strong", projectId: "p1", requirementTitle: "Dup", impactScore: 0.8 }),
      ],
      [P1],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].itemsByProject.p1?.id).toBe("strong");
    // Aggregate reflects the stronger score only, not the sum of both.
    expect(rows[0].aggregateScore).toBeCloseTo(0.8);
    expect(rows[0].impactedProjectCount).toBe(1);
  });

  it("groups by requirementId when present (title collisions stay distinct)", () => {
    const rows = buildRequirementMatrix(
      [
        item({ id: "a", projectId: "p1", requirementId: "R1", requirementTitle: "Same title" }),
        item({ id: "b", projectId: "p1", requirementId: "R2", requirementTitle: "Same title" }),
      ],
      [P1],
    );
    expect(rows).toHaveLength(2);
  });
});

describe("RequirementImpactMatrix (#964)", () => {
  it("renders a requirement×project table with a column per project", () => {
    render(
      <RequirementImpactMatrix
        items={[
          item({ id: "a", projectId: "p1", requirementTitle: "Password reset" }),
          item({ id: "b", projectId: "p2", requirementTitle: "Password reset" }),
        ]}
        projects={[P1, P2]}
      />,
    );
    expect(screen.getByTestId("requirement-matrix-table")).toBeInTheDocument();
    const headers = screen.getAllByTestId("matrix-project-header").map((h) => h.textContent);
    expect(headers).toEqual(["Checkout", "Billing"]);
    expect(screen.getAllByTestId("matrix-row")).toHaveLength(1);
  });

  it("drills a cell down to the existing per-item detail rendering", () => {
    render(
      <RequirementImpactMatrix
        items={[item({ id: "a", projectId: "p1", requirementTitle: "Password reset" })]}
        projects={[P1, P2]}
      />,
    );
    expect(screen.queryByTestId("requirement-matrix-drilldown")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId("matrix-cell-button")[0]);
    const drill = screen.getByTestId("requirement-matrix-drilldown");
    // Reuses ChangedRequirementGroup — not a duplicated detail UI.
    expect(within(drill).getByTestId("changed-requirement-group")).toBeInTheDocument();
    // Closing hides it again.
    fireEvent.click(screen.getByTestId("requirement-matrix-drilldown-close"));
    expect(screen.queryByTestId("requirement-matrix-drilldown")).not.toBeInTheDocument();
  });

  it("renders an empty cell for a project with no impact", () => {
    render(
      <RequirementImpactMatrix
        items={[item({ id: "a", projectId: "p1", requirementTitle: "Only P1" })]}
        projects={[P1, P2]}
      />,
    );
    expect(screen.getAllByTestId("matrix-cell-empty")).toHaveLength(1);
  });

  it("degrades to a ranked list for a single project", () => {
    render(
      <RequirementImpactMatrix
        items={[
          item({ id: "a", projectId: "p1", requirementTitle: "Low", impactScore: 0.2 }),
          item({ id: "b", projectId: "p1", requirementTitle: "High", impactScore: 0.9 }),
        ]}
        projects={[P1]}
      />,
    );
    expect(screen.queryByTestId("requirement-matrix-table")).not.toBeInTheDocument();
    const rows = screen.getAllByTestId("requirement-matrix-list-row");
    expect(rows).toHaveLength(2);
    // Ranked: High first.
    expect(rows[0].textContent).toMatch(/High/);
    // Drill-down works from the list too.
    fireEvent.click(rows[0]);
    expect(screen.getByTestId("requirement-matrix-drilldown")).toBeInTheDocument();
  });

  it("shows an empty state when there are no items", () => {
    render(<RequirementImpactMatrix items={[]} projects={[P1, P2]} />);
    expect(screen.getByTestId("requirement-matrix-empty")).toBeInTheDocument();
  });
});
