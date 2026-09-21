/**
 * Epic #194 (C.5) — Leaderboard table tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeaderboardTable } from "@/components/eval/leaderboard-table";
import type { BenchRunSummary } from "@/lib/eval-api";

function mkRun(over: Partial<BenchRunSummary> = {}): BenchRunSummary {
  return {
    id: "r1",
    benchmark: "swe-bench-pro",
    model: "gpt-5",
    score: 0.5,
    totalTasks: 10,
    passedTasks: 5,
    meanTokens: 100,
    meanCostCents: 12,
    meanLatencyMs: 250,
    startedAt: "2026-04-25T10:00:00Z",
    completedAt: "2026-04-25T10:30:00Z",
    status: "completed",
    ...over,
  };
}

describe("LeaderboardTable", () => {
  it("renders an empty state when there are no runs", () => {
    render(<LeaderboardTable runs={[]} />);
    expect(screen.getByTestId("leaderboard-empty")).toBeInTheDocument();
  });

  it("renders one row per run with score + cost formatted", () => {
    render(
      <LeaderboardTable
        runs={[
          mkRun({ id: "r1", score: 0.42, meanCostCents: 99 }),
          mkRun({ id: "r2", benchmark: "tau-bench", score: 1, model: "claude" }),
        ]}
      />,
    );
    expect(screen.getByTestId("leaderboard-row-r1")).toBeInTheDocument();
    expect(screen.getByTestId("row-score-r1")).toHaveTextContent("42.0%");
    expect(screen.getByTestId("leaderboard-row-r2")).toBeInTheDocument();
    expect(screen.getByTestId("row-detail-link-r1")).toHaveAttribute(
      "href",
      "/eval/leaderboard/r1",
    );
    expect(screen.getByText("TAU-bench")).toBeInTheDocument();
  });

  it("falls back to the raw benchmark id for unknown values", () => {
    render(<LeaderboardTable runs={[mkRun({ id: "r3", benchmark: "weird-bench" })]} />);
    expect(screen.getByText("weird-bench")).toBeInTheDocument();
  });
});
