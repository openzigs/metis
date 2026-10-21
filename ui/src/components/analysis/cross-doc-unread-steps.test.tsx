/**
 * Issue #1081 — a cross-document check whose model answer METIS could not read
 * must not render as "No cross-document contradictions or completeness gaps
 * detected". The server records `unreadAnalysisSteps`; this panel words it.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CrossDocFindingsPanel } from "@/components/analysis/CrossDocFindingsPanel";

const UNREAD = {
  steps: [
    { step: "completeness-check", reason: "unparseable", failedCalls: 1, totalCalls: 1 },
    { step: "contradiction-check", reason: "schema-invalid", failedCalls: 2, totalCalls: 5 },
  ],
  at: "2026-10-21T00:00:00.000Z",
};

describe("#1081 CrossDocFindingsPanel unread checks", () => {
  it("does not claim a clean result when a check could not be read", () => {
    render(
      <CrossDocFindingsPanel crossDocFindings={null} metadata={{ unreadAnalysisSteps: UNREAD }} />,
    );
    expect(
      screen.queryByText(/No cross-document contradictions or completeness gaps detected/),
    ).toBeNull();
    const notice = screen.getByTestId("cross-doc-unread-steps");
    expect(notice.textContent).toContain("The completeness check could not be read");
    expect(notice.textContent).toContain("no gaps listed here does not mean none are missing");
    expect(notice.textContent).toContain("2 of 5 contradiction checks");
    expect(screen.getByText("Nothing was found by the checks that could be read.")).toBeTruthy();
  });

  it("keeps the clean line when every check was read", () => {
    render(<CrossDocFindingsPanel crossDocFindings={null} metadata={{}} />);
    expect(
      screen.getByText("No cross-document contradictions or completeness gaps detected."),
    ).toBeTruthy();
    expect(screen.queryByTestId("cross-doc-unread-steps")).toBeNull();
  });

  it("shows the notice above real findings too", () => {
    render(
      <CrossDocFindingsPanel
        crossDocFindings={{
          findings: [
            {
              id: "f1",
              kind: "missing-nfr",
              severity: "medium",
              title: "No availability target",
              detail: "No uptime stated.",
              evidenceIds: [],
              scope: null,
            },
          ],
          contradictionCount: 0,
          completenessGapCount: 1,
          generatedAt: "2026-10-21T00:00:00.000Z",
        }}
        metadata={{ unreadAnalysisSteps: UNREAD }}
      />,
    );
    expect(screen.getByTestId("cross-doc-unread-steps")).toBeTruthy();
    expect(screen.getByText("No availability target")).toBeTruthy();
  });

  it("ignores a malformed marker rather than rendering undefined", () => {
    render(
      <CrossDocFindingsPanel
        crossDocFindings={null}
        metadata={{ unreadAnalysisSteps: { steps: [{ step: "bogus" }] } }}
      />,
    );
    expect(screen.queryByTestId("cross-doc-unread-steps")).toBeNull();
  });
});
