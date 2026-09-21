/**
 * Epic #803 (Epic 09) — Domain Eval trend chart tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DomainTrendChart } from "@/components/eval/domain-trend-chart";
import type { DomainEvalRunSummary } from "@/lib/eval-api";

function mkRun(
  runId: string,
  corpusF1: number,
  startedAt: string,
  driftAlert = false,
): DomainEvalRunSummary {
  return {
    runId,
    schemaVersion: 1,
    model: "offline-stub",
    startedAt,
    completedAt: startedAt,
    itemCount: 20,
    corpusPrecision: corpusF1,
    corpusRecall: corpusF1,
    corpusF1,
    meanRougeL: 0.8,
    totalTokens: 1000,
    totalCostCents: 0,
    commit: "abc123",
    drift: {
      previousF1: driftAlert ? corpusF1 + 0.1 : null,
      deltaF1: driftAlert ? -0.1 : null,
      thresholdPct: 0.05,
      alert: driftAlert,
      reason: driftAlert ? "F1 dropped" : "NO_BASELINE",
      baselineRunId: null,
      baselineAgeDays: null,
      staleBaseline: false,
    },
    driftAlert,
  };
}

describe("DomainTrendChart", () => {
  it("shows an empty hint with fewer than two runs", () => {
    render(<DomainTrendChart runs={[mkRun("a", 0.9, "2026-05-01T00:00:00Z")]} />);
    expect(screen.getByTestId("domain-trend-empty")).toBeInTheDocument();
  });

  it("renders a point per run", () => {
    render(
      <DomainTrendChart
        runs={[mkRun("a", 0.9, "2026-05-01T00:00:00Z"), mkRun("b", 0.85, "2026-05-02T00:00:00Z")]}
      />,
    );
    expect(screen.getByTestId("domain-trend-chart")).toBeInTheDocument();
    expect(screen.getByTestId("domain-point-a")).toBeInTheDocument();
    expect(screen.getByTestId("domain-point-b")).toBeInTheDocument();
  });

  it("flags drift-alert runs with a distinct marker", () => {
    render(
      <DomainTrendChart
        runs={[
          mkRun("a", 0.9, "2026-05-01T00:00:00Z"),
          mkRun("b", 0.7, "2026-05-02T00:00:00Z", true),
        ]}
      />,
    );
    expect(screen.getByTestId("domain-point-b").getAttribute("data-drift-alert")).toBe("true");
    expect(screen.getByTestId("domain-point-a").getAttribute("data-drift-alert")).toBe("false");
  });

  it("clamps out-of-range F1 without throwing", () => {
    render(
      <DomainTrendChart
        runs={[
          mkRun("a", -1, "2026-05-01T00:00:00Z"),
          mkRun("b", 2, "2026-05-02T00:00:00Z"),
          mkRun("c", Number.NaN, "2026-05-03T00:00:00Z"),
        ]}
      />,
    );
    expect(screen.getByTestId("domain-trend-chart")).toBeInTheDocument();
  });
});
