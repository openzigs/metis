/**
 * Issue #1232 — the synthesis summary is the one place a completed run states
 * its outcome, and it was never rendered.
 *
 * These assert the two halves of that: the summary's own words reach the page
 * when synthesis produced one, and NOTHING renders (no heading, no empty shell)
 * when it did not or the run has not finished.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalysisOutcomeCard } from "./AnalysisOutcomeCard";

const SUMMARY =
  "UC101 introduces Cross-Dock Transfer job processing across three areas. " +
  "No source could be retrieved for concrete class naming, which is a blocking context gap.";

function agents(summary: string | null) {
  return [
    { agentKey: "code" as const, summary: "code specialist summary" },
    { agentKey: "synthesis" as const, summary },
  ];
}

describe("AnalysisOutcomeCard (#1232)", () => {
  it("renders the synthesis summary for a completed run", () => {
    render(<AnalysisOutcomeCard status="completed" agentResults={agents(SUMMARY)} />);

    expect(screen.getByTestId("analysis-outcome-card")).toHaveTextContent(/blocking context gap/i);
    expect(screen.getByRole("heading", { name: /outcome/i })).toBeInTheDocument();
  });

  it("does not render a specialist summary in place of the synthesis one", () => {
    render(<AnalysisOutcomeCard status="completed" agentResults={agents(null)} />);

    expect(screen.queryByTestId("analysis-outcome-card")).not.toBeInTheDocument();
    expect(screen.queryByText(/code specialist summary/)).not.toBeInTheDocument();
  });

  it("renders nothing when the synthesis summary is null", () => {
    const { container } = render(
      <AnalysisOutcomeCard status="completed" agentResults={agents(null)} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the synthesis summary is whitespace only", () => {
    const { container } = render(
      <AnalysisOutcomeCard status="completed" agentResults={agents("   \n  ")} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no synthesis agent at all", () => {
    const { container } = render(
      <AnalysisOutcomeCard
        status="completed"
        agentResults={[{ agentKey: "code", summary: "something" }]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the run is still incomplete", () => {
    for (const status of ["running", "pending", "failed", "cancelled"]) {
      const { container } = render(
        <AnalysisOutcomeCard status={status} agentResults={agents(SUMMARY)} />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });
});
