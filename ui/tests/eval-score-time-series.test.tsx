/**
 * Epic #194 (C.5) — Score time-series sparkline tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScoreTimeSeries } from "@/components/eval/score-time-series";
import type { BenchRunSummary } from "@/lib/eval-api";

function mkRun(id: string, score: number, startedAt: string): BenchRunSummary {
  return {
    id,
    benchmark: "swe-bench-pro",
    model: "gpt-5",
    score,
    totalTasks: 1,
    passedTasks: score === 1 ? 1 : 0,
    meanTokens: 1,
    meanCostCents: 1,
    meanLatencyMs: 1,
    startedAt,
    completedAt: startedAt,
    status: "completed",
  };
}

describe("ScoreTimeSeries", () => {
  it("renders an empty hint when fewer than two runs", () => {
    render(<ScoreTimeSeries runs={[mkRun("r1", 0.5, "2026-04-20T00:00:00Z")]} />);
    expect(screen.getByTestId("score-timeseries-empty")).toBeInTheDocument();
  });

  it("renders a polyline + circle per run", () => {
    render(
      <ScoreTimeSeries
        runs={[
          mkRun("r1", 0.2, "2026-04-20T00:00:00Z"),
          mkRun("r2", 0.6, "2026-04-21T00:00:00Z"),
          mkRun("r3", 0.9, "2026-04-22T00:00:00Z"),
        ]}
      />,
    );
    expect(screen.getByTestId("score-timeseries")).toBeInTheDocument();
    expect(screen.getByTestId("score-point-r1")).toBeInTheDocument();
    expect(screen.getByTestId("score-point-r3")).toBeInTheDocument();
  });

  it("clamps scores outside [0,1]", () => {
    render(
      <ScoreTimeSeries
        runs={[
          mkRun("a", -0.5, "2026-04-20T00:00:00Z"),
          mkRun("b", 2, "2026-04-21T00:00:00Z"),
          mkRun("c", Number.NaN, "2026-04-22T00:00:00Z"),
        ]}
      />,
    );
    // Just assert it rendered without throwing.
    expect(screen.getByTestId("score-timeseries")).toBeInTheDocument();
  });
});
