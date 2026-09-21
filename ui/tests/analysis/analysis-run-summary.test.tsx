import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalysisRunSummary } from "@/components/analysis/analysis-run-summary";

describe("AnalysisRunSummary (#907)", () => {
  it("pluralises the document count and reports requirements as no", () => {
    render(<AnalysisRunSummary docCount={3} hasRequirements={false} />);
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses 3 documents + requirements provided: no.",
    );
  });

  it("uses the singular form for one document and reports requirements as yes", () => {
    render(<AnalysisRunSummary docCount={1} hasRequirements />);
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses 1 document + requirements provided: yes.",
    );
  });

  it("handles zero documents", () => {
    render(<AnalysisRunSummary docCount={0} hasRequirements={false} />);
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent("0 documents");
  });
});
