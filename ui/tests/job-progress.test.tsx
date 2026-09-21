import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JobProgress } from "@/components/realtime/job-progress";

/**
 * Unit tests for the shared #423 job-progress bar used by all three async
 * surfaces (embeddings reindex / overview regenerate / Spec Kit commands).
 */
describe("JobProgress", () => {
  it("renders a determinate bar with the percentage and aria-valuenow", () => {
    render(<JobProgress progress={42} message="Re-embedded 42/100 chunks" testId="jp" />);
    expect(screen.getByTestId("jp-message")).toHaveTextContent("Re-embedded 42/100 chunks");
    expect(screen.getByTestId("jp-pct")).toHaveTextContent("42%");
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByTestId("jp-bar")).toHaveStyle({ width: "42%" });
  });

  it("clamps progress into 0-100 and rounds", () => {
    const { rerender } = render(<JobProgress progress={150} testId="jp" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    rerender(<JobProgress progress={-5} testId="jp" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    rerender(<JobProgress progress={33.6} testId="jp" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "34");
  });

  it("renders an indeterminate bar with NO aria-valuenow (one-shot awaited ops)", () => {
    render(<JobProgress indeterminate message="Regenerating…" testId="jp" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    // No percentage label in indeterminate mode.
    expect(screen.queryByTestId("jp-pct")).not.toBeInTheDocument();
    expect(screen.getByTestId("jp-bar").className).toContain("animate-pulse");
  });

  it("omits the message row when no message is given", () => {
    render(<JobProgress progress={10} testId="jp" />);
    expect(screen.queryByTestId("jp-message")).not.toBeInTheDocument();
    // Bar still renders.
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("renders an empty (0-width) bar with no aria-valuenow when progress is absent", () => {
    render(<JobProgress message="Working…" testId="jp" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByTestId("jp-bar")).toHaveStyle({ width: "0%" });
  });

  it("uses the provided accessible label", () => {
    render(<JobProgress progress={5} label="Reindex progress" testId="jp" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-label", "Reindex progress");
  });
});
