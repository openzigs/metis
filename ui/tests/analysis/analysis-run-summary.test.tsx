import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalysisRunSummary } from "@/components/analysis/analysis-run-summary";

describe("AnalysisRunSummary (#907)", () => {
  it("pluralises the document count and reports requirements as no", () => {
    render(<AnalysisRunSummary docCount={3} availableDocCount={5} hasRequirements={false} />);
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses 3 documents + requirements provided: no.",
    );
  });

  it("uses the singular form for one document and reports requirements as yes", () => {
    render(<AnalysisRunSummary docCount={1} availableDocCount={5} hasRequirements />);
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses 1 document + requirements provided: yes.",
    );
  });

  // #1749 — no selection sends no `documentIds`, so the run reads every ready document.
  it("says all documents when none is selected", () => {
    render(<AnalysisRunSummary docCount={0} availableDocCount={4} hasRequirements={false} />);
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses all 4 documents + requirements provided: no.",
    );
  });

  // The list is the first page only: a count from it would be wrong for a big project.
  it("drops the number when the loaded list is only the first page", () => {
    render(
      <AnalysisRunSummary
        docCount={0}
        availableDocCount={25}
        listIsPartial
        hasRequirements={false}
      />,
    );
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses all the project's documents + requirements provided: no.",
    );
    expect(screen.getByTestId("analysis-run-summary")).not.toHaveTextContent("25");
  });

  it("names the one document when the project has only one", () => {
    render(<AnalysisRunSummary docCount={0} availableDocCount={1} hasRequirements={false} />);
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses the project's 1 document + requirements provided: no.",
    );
  });

  it("says no documents only when the project has none ready", () => {
    render(<AnalysisRunSummary docCount={0} availableDocCount={0} hasRequirements />);
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses no documents + requirements provided: yes.",
    );
  });
});
