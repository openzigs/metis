/**
 * Issue #1116 (AC3) — the UI must state what a clarification answer does, and
 * what it does not do. The live incident had the user answer 14 questions, watch
 * the approval panel improve, and receive published issues containing none of
 * it — with nothing on screen distinguishing the two outcomes.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClarificationImpactNote } from "@/components/analysis/EnhancementResults";

const base = {
  answeredCount: 14,
  appliedCount: 12,
  unattributedCount: 2,
  requirementsUpdated: 5,
  requirementsAvailable: true,
  updatedAt: "2026-07-28T00:00:00.000Z",
};

describe("ClarificationImpactNote", () => {
  it("renders nothing before any question is answered", () => {
    const { container } = render(<ClarificationImpactNote application={undefined} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<ClarificationImpactNote application={{ ...base, answeredCount: 0 }} />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it("says how many answers reached the requirements that get published", () => {
    render(<ClarificationImpactNote application={base} />);
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /12 of 14 answers were written into the saved requirements/,
    );
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(/published issues/);
  });

  it("names the answers that will NOT appear in a published issue", () => {
    render(<ClarificationImpactNote application={base} />);
    expect(screen.getByTestId("clarification-unattributed")).toHaveTextContent(
      /2 answers could not be matched to a saved requirement/,
    );
  });

  it("omits the exclusion warning when every answer landed", () => {
    render(
      <ClarificationImpactNote application={{ ...base, appliedCount: 14, unattributedCount: 0 }} />,
    );
    expect(screen.queryByTestId("clarification-unattributed")).toBeNull();
  });

  it("explains the wait instead of implying loss while approval withholds the rows", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          requirementsAvailable: false,
          appliedCount: 0,
          requirementsUpdated: 0,
        }}
      />,
    );
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /awaiting approval, and your answers are written into them when they are promoted/,
    );
  });

  it("states the enrichment that is deliberately NOT published", () => {
    render(<ClarificationImpactNote application={base} />);
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /is not copied into published issues — your answers are, verbatim/,
    );
  });

  it("uses singular wording for a single answer", () => {
    render(
      <ClarificationImpactNote
        application={{ ...base, answeredCount: 1, appliedCount: 1, unattributedCount: 0 }}
      />,
    );
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /1 of 1 answer was written/,
    );
  });
});
