/**
 * Issue #1143 — a run whose agents failed was shown as a clean `completed`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunStatusBadge, StatusBadge, runStatusText } from "./analysis-status-badge";

describe("runStatusText (#1155)", () => {
  it("reads a run-list row the way the run header does", () => {
    expect(runStatusText({ status: "completed" })).toBe("completed");
    expect(runStatusText({ status: "completed", failedAgents: ["code"] })).toBe(
      "completed with errors",
    );
    expect(
      runStatusText({
        status: "completed",
        failedAgents: [],
        droppedCitations: [{ agentKey: "code", count: 2 }],
      }),
    ).toBe("completed with warnings");
    expect(runStatusText({ status: "failed", failedAgents: ["code"] })).toBe("failed");
  });
});

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

  it("shows a completed run that only lost citations as completed with warnings, naming the agent and count", () => {
    render(
      <RunStatusBadge
        status="completed"
        failedAgents={[]}
        droppedCitations={[
          { agentKey: "document", count: 2 },
          { agentKey: "web", count: 0 },
        ]}
      />,
    );
    expect(screen.getByText("completed with warnings")).toHaveClass("text-warning");
    expect(screen.getByTestId("analysis-dropped-citations")).toHaveTextContent(
      "Citations dropped: document (2)",
    );
    expect(screen.getByTestId("analysis-dropped-citations").textContent).not.toContain("web");
  });

  it("names failed agents, not dropped citations, when a run has both", () => {
    render(
      <RunStatusBadge
        status="completed"
        failedAgents={["code"]}
        droppedCitations={[{ agentKey: "document", count: 1 }]}
      />,
    );
    expect(screen.getByText("completed with errors")).toBeInTheDocument();
    expect(screen.queryByTestId("analysis-dropped-citations")).toBeNull();
  });

  it("colours an agent row's own status as before", () => {
    render(<StatusBadge status="cancelled" />);
    expect(screen.getByText("cancelled")).toHaveClass("bg-muted");
  });
});
