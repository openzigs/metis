/**
 * Issue #362 — "Generate GitHub Issues" on the Analysis page must not lead a
 * completed-but-unapproved run into a Publish error.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GenerateIssuesAction, type GenerateIssuesActionProps } from "./GenerateIssuesAction";

function renderAction(over: Partial<GenerateIssuesActionProps> = {}) {
  return render(
    <GenerateIssuesAction
      projectId="proj_1"
      analysisId="ana_1"
      status="completed"
      requirementCount={0}
      hasFindings
      ticketStatus={{ allowed: true, pendingCount: 0, rejectedCount: 0 }}
      {...over}
    />,
  );
}

describe("GenerateIssuesAction (#362)", () => {
  it("links to Publish for the run once requirements exist", () => {
    renderAction({ requirementCount: 2 });
    const link = screen.getByRole("link", { name: "Generate GitHub Issues" });
    expect(link).toHaveAttribute("href", "/projects/proj_1/publish?analysisId=ana_1");
    expect(screen.queryByTestId("generate-issues-reason")).not.toBeInTheDocument();
  });

  it("is disabled on a completed-but-unapproved run and names the pending approvals", () => {
    renderAction({ ticketStatus: { allowed: false, pendingCount: 3, rejectedCount: 0 } });

    expect(screen.queryByRole("link", { name: "Generate GitHub Issues" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Generate GitHub Issues" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/3 pending approval\(s\) must be resolved/);
    expect(screen.getByTestId("generate-issues-reason")).not.toHaveTextContent("rejected");
    expect(screen.getByRole("link", { name: "Go to approvals" })).toHaveAttribute(
      "href",
      "#approvals",
    );
  });

  // PR #404 panel — a rejection is final, so the remedy is a new run; sending
  // the user to the approvals panel would be a dead end.
  // #723 — a rejection is resolved (and can be reopened); only the pending
  // approval holds the gate, so point at the approvals, never at a re-run.
  it("points a run holding a rejection and a pending approval at the approvals, not a re-run", () => {
    renderAction({ ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 2 } });
    const reason = screen.getByTestId("generate-issues-reason");
    expect(reason).toHaveTextContent("1 pending approval(s) must be resolved");
    expect(reason).not.toHaveTextContent("Re-run");
    expect(screen.getByRole("link", { name: "Go to approvals" })).toBeInTheDocument();
  });

  it("explains the gate even on a run with no findings", () => {
    renderAction({
      hasFindings: false,
      ticketStatus: { allowed: false, pendingCount: 0, rejectedCount: 0 },
    });
    expect(screen.getByTestId("generate-issues-reason")).toHaveTextContent(
      "Approvals must be resolved before requirements exist.",
    );
  });

  // PR #404 review — while the gate is unknown the button must not claim
  // "No requirements", which is exactly the confusion #362 removes.
  it("says it is checking approvals, not 'no requirements', while the gate is loading", () => {
    renderAction({ ticketStatus: undefined, approvalsState: "loading" });
    expect(screen.getByRole("button", { name: "Generate GitHub Issues" })).toBeDisabled();
    expect(screen.getByTestId("generate-issues-reason")).toHaveTextContent("Checking approvals…");
    expect(screen.getByTestId("generate-issues-reason")).not.toHaveTextContent(/No requirements/);
  });

  it("says the gate could not be checked, and links to approvals, when the query failed", () => {
    renderAction({ ticketStatus: undefined, approvalsState: "error", hasFindings: false });
    expect(screen.getByRole("button", { name: "Generate GitHub Issues" })).toBeDisabled();
    expect(screen.getByTestId("generate-issues-reason")).toHaveTextContent(
      "Couldn't check the approval gate",
    );
    expect(screen.getByRole("link", { name: "Go to approvals" })).toHaveAttribute(
      "href",
      "#approvals",
    );
  });

  it("is disabled with a plain reason when findings exist but no requirements and no gate", () => {
    renderAction({ ticketStatus: undefined });
    expect(screen.getByRole("button", { name: "Generate GitHub Issues" })).toBeDisabled();
    expect(screen.getByTestId("generate-issues-reason")).toHaveTextContent(
      "No requirements to generate issues from.",
    );
    expect(screen.queryByRole("link", { name: "Go to approvals" })).not.toBeInTheDocument();
  });

  it("renders nothing for a run that has not completed, or has nothing to publish", () => {
    const { container, rerender } = renderAction({ status: "running", requirementCount: 4 });
    expect(container).toBeEmptyDOMElement();
    rerender(
      <GenerateIssuesAction
        projectId="proj_1"
        analysisId="ana_1"
        status="completed"
        requirementCount={0}
        hasFindings={false}
        ticketStatus={{ allowed: true, pendingCount: 0, rejectedCount: 0 }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
