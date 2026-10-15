/**
 * Issue #1143 — a run whose agents failed was shown as a clean `completed`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunStatusBadge, StatusBadge } from "./analysis-status-badge";

describe("<RunStatusBadge /> (#1143)", () => {
  it("shows a completed run with failed agents as completed with errors, naming them", () => {
    render(<RunStatusBadge status="completed" failedAgents={["document", "code"]} />);
    expect(screen.getByText("completed with errors")).toHaveClass("text-warning");
    expect(screen.getByTestId("analysis-failed-agents")).toHaveTextContent(
      "Failed: document, code",
    );
    expect(screen.queryByText("completed")).toBeNull();
  });

  it("shows a clean completion as completed, with no failed-agent line", () => {
    render(<RunStatusBadge status="completed" failedAgents={[]} />);
    expect(screen.getByText("completed")).toHaveClass("text-success");
    expect(screen.queryByTestId("analysis-failed-agents")).toBeNull();
  });

  it("leaves other statuses as stored, and tolerates an older server without the field", () => {
    const { rerender } = render(<RunStatusBadge status="failed" failedAgents={["code"]} />);
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.queryByTestId("analysis-failed-agents")).toBeNull();
    rerender(<RunStatusBadge status="completed" />);
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it("colours an agent row's own status as before", () => {
    render(<StatusBadge status="cancelled" />);
    expect(screen.getByText("cancelled")).toHaveClass("bg-muted");
  });
});
