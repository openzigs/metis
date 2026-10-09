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
import { AnalysisOutcomeCard, reconcileRequirementCount } from "./AnalysisOutcomeCard";

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

  it("states the stored count and corrects a summary that counts differently (#994)", () => {
    render(
      <AnalysisOutcomeCard
        status="completed"
        agentResults={agents("Ten requirements were derived from the spec. Two areas changed.")}
        requirementCount={8}
      />,
    );
    const card = screen.getByTestId("analysis-outcome-card");
    expect(card).toHaveTextContent("8 requirements were derived from the spec. Two areas changed.");
    expect(card).not.toHaveTextContent(/ten requirements/i);
    expect(screen.getByTestId("analysis-outcome-count")).toHaveTextContent(
      "8 requirements stored for this run.",
    );
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

describe("reconcileRequirementCount (#994)", () => {
  it("rewrites only the derived-requirement count, with matching grammar", () => {
    expect(reconcileRequirementCount("12 new requirements have been identified.", 1)).toBe(
      "1 new requirement was identified.",
    );
    expect(reconcileRequirementCount("One requirement was derived.", 3)).toBe(
      "3 requirements were derived.",
    );
    expect(reconcileRequirementCount("Ten requirements were synthesised.", 10)).toBe(
      "Ten requirements were synthesised.",
    );
  });

  it("leaves other numbers and unrelated phrasing alone", () => {
    const s =
      "Three areas changed; 4 findings were derived; requirements were derived from 2 docs.";
    expect(reconcileRequirementCount(s, 8)).toBe(s);
  });

  it("leaves subset claims alone (#994 review)", () => {
    const s = "3 security requirements were identified and 5 functional requirements were derived";
    expect(reconcileRequirementCount(s, 8)).toBe(s);
    const one = "3 security requirements were identified.";
    expect(reconcileRequirementCount(one, 8)).toBe(one);
  });

  it("leaves a summary with two count claims alone (#994 review)", () => {
    const s =
      "Ten requirements were derived; two requirements were identified as already implemented";
    expect(reconcileRequirementCount(s, 8)).toBe(s);
  });

  it("omits the stored-count line when no count is given", () => {
    render(<AnalysisOutcomeCard status="completed" agentResults={agents(SUMMARY)} />);
    expect(screen.queryByTestId("analysis-outcome-count")).toBeNull();
  });

  it("says requirement in the singular for one stored row", () => {
    render(
      <AnalysisOutcomeCard
        status="completed"
        agentResults={agents(SUMMARY)}
        requirementCount={1}
      />,
    );
    expect(screen.getByTestId("analysis-outcome-count")).toHaveTextContent(
      "1 requirement stored for this run.",
    );
  });
});
