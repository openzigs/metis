import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ImpactDriftReport } from "@metis/shared";
import { ImpactDriftSection } from "@/components/impact/impact-drift-section";

function report(over: Partial<ImpactDriftReport> = {}): ImpactDriftReport {
  return {
    headAnalysisId: "head-1",
    baseAnalysisId: "base-1",
    requirements: [],
    summary: {
      requirementsAdded: 0,
      requirementsRemoved: 0,
      requirementsChanged: 0,
      requirementsUnchanged: 0,
      tablesAdded: 0,
      tablesRemoved: 0,
      symbolsAdded: 0,
      symbolsRemoved: 0,
    },
    ...over,
  };
}

describe("ImpactDriftSection — #965", () => {
  it("renders nothing when there is no report", () => {
    const { container } = render(<ImpactDriftSection report={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an original run (no base)", () => {
    const { container } = render(<ImpactDriftSection report={report({ baseAnalysisId: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an empty state when the impact is identical", () => {
    render(<ImpactDriftSection report={report()} />);
    expect(screen.getByTestId("impact-drift-empty")).toBeInTheDocument();
  });

  it("renders per-requirement added tables and code sites with a roll-up", () => {
    render(
      <ImpactDriftSection
        report={report({
          requirements: [
            {
              key: "p1|req:r1",
              projectId: "p1",
              requirementId: "r1",
              requirementTitle: "Account status handling",
              status: "changed",
              tablesAdded: ["account.status"],
              tablesRemoved: [],
              tablesTierChanged: [],
              symbolsAdded: ["C.ts::pkg.C"],
              symbolsRemoved: [],
              confidenceDelta: 0.2,
              severityChanged: { from: "low", to: "high" },
            },
          ],
          summary: {
            requirementsAdded: 0,
            requirementsRemoved: 0,
            requirementsChanged: 1,
            requirementsUnchanged: 0,
            tablesAdded: 1,
            tablesRemoved: 0,
            symbolsAdded: 1,
            symbolsRemoved: 0,
          },
        })}
      />,
    );
    expect(screen.getByTestId("impact-drift-req-label")).toHaveTextContent(
      "Account status handling",
    );
    expect(screen.getByTestId("impact-drift-req-status")).toHaveTextContent("changed");
    expect(screen.getByTestId("impact-drift-tables-added")).toHaveTextContent("account.status");
    expect(screen.getByTestId("impact-drift-symbols-added")).toHaveTextContent("pkg.C");
    expect(screen.getByTestId("impact-drift-confidence")).toHaveTextContent("+0.20");
    expect(screen.getByTestId("impact-drift-severity")).toHaveTextContent("low → high");
    expect(screen.getByTestId("impact-drift-summary")).toHaveTextContent("+1");
  });

  it("renders tier changes, removed code sites, and a negative confidence delta", () => {
    render(
      <ImpactDriftSection
        report={report({
          requirements: [
            {
              key: "p1|txt:abcd1234",
              projectId: "p1",
              requirementId: null,
              requirementTitle: "Signon flow",
              status: "changed",
              tablesAdded: [],
              tablesRemoved: [],
              tablesTierChanged: [
                {
                  tableName: "account",
                  columnName: "status",
                  fromTier: "possible",
                  toTier: "unlikely",
                },
                { tableName: "signon", columnName: null, fromTier: null, toTier: "likely" },
              ],
              symbolsAdded: [],
              symbolsRemoved: ["old.ts::pkg.old"],
              confidenceDelta: -0.15,
              severityChanged: null,
            },
          ],
        })}
      />,
    );
    const tier = screen.getByTestId("impact-drift-tier-changed");
    expect(tier).toHaveTextContent("account.status: possible → unlikely");
    expect(tier).toHaveTextContent("signon: — → likely");
    expect(screen.getByTestId("impact-drift-symbols-removed")).toHaveTextContent("pkg.old");
    expect(screen.getByTestId("impact-drift-confidence")).toHaveTextContent("-0.15");
    // No severity change ⇒ that chip is absent.
    expect(screen.queryByTestId("impact-drift-severity")).not.toBeInTheDocument();
  });

  it("shows a removed requirement's dropped table", () => {
    render(
      <ImpactDriftSection
        report={report({
          requirements: [
            {
              key: "p1|req:r2",
              projectId: "p1",
              requirementId: "r2",
              requirementTitle: null,
              status: "removed",
              tablesAdded: [],
              tablesRemoved: ["signon"],
              tablesTierChanged: [],
              symbolsAdded: [],
              symbolsRemoved: [],
              confidenceDelta: 0,
              severityChanged: null,
            },
          ],
          summary: {
            requirementsAdded: 0,
            requirementsRemoved: 1,
            requirementsChanged: 0,
            requirementsUnchanged: 0,
            tablesAdded: 0,
            tablesRemoved: 1,
            symbolsAdded: 0,
            symbolsRemoved: 0,
          },
        })}
      />,
    );
    expect(screen.getByTestId("impact-drift-req-status")).toHaveTextContent("removed");
    expect(screen.getByTestId("impact-drift-req-label")).toHaveTextContent("r2");
    expect(screen.getByTestId("impact-drift-tables-removed")).toHaveTextContent("signon");
  });
});
