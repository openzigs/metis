/**
 * Issue #1117 (findings B + C) — the notice that would have made the
 * verification walkthrough a one-line diagnosis instead of a database dig.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SynthesisDegradedNotice } from "@/components/analysis/SynthesisDegradedNotice";

const degraded = {
  reason: "non-json" as const,
  detail: "Expected double-quoted property name in JSON at position 2093",
  attempts: 2,
  requirementCount: 16,
  at: "2026-07-28T11:38:00.000Z",
};

describe("SynthesisDegradedNotice", () => {
  it("renders nothing on a healthy run", () => {
    expect(render(<SynthesisDegradedNotice metadata={{}} />).container).toBeEmptyDOMElement();
    expect(render(<SynthesisDegradedNotice metadata={null} />).container).toBeEmptyDOMElement();
    expect(
      render(<SynthesisDegradedNotice metadata={undefined} />).container,
    ).toBeEmptyDOMElement();
  });

  it("explains BOTH symptoms the walkthrough filed as separate defects", () => {
    render(<SynthesisDegradedNotice metadata={{ synthesisDegraded: degraded }} />);

    const notice = screen.getByTestId("synthesis-degraded");
    expect(notice).toHaveTextContent(/typed "feature"/);
    expect(notice).toHaveTextContent(/no acceptance criteria/);
    expect(notice).toHaveTextContent(/16 requirements/);
  });

  it("is an alert, so it is announced rather than merely present", () => {
    render(<SynthesisDegradedNotice metadata={{ synthesisDegraded: degraded }} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows the underlying parser/provider message when there is one", () => {
    render(<SynthesisDegradedNotice metadata={{ synthesisDegraded: degraded }} />);
    expect(screen.getByTestId("synthesis-degraded-detail")).toHaveTextContent(/position 2093/);
  });

  it("omits the detail line when the reason carried none", () => {
    render(
      <SynthesisDegradedNotice
        metadata={{ synthesisDegraded: { ...degraded, detail: undefined } }}
      />,
    );
    expect(screen.queryByTestId("synthesis-degraded-detail")).not.toBeInTheDocument();
  });

  it("tells the user what to do about it", () => {
    render(<SynthesisDegradedNotice metadata={{ synthesisDegraded: degraded }} />);
    expect(screen.getByTestId("synthesis-degraded")).toHaveTextContent(/Re-run the analysis/);
  });
});
