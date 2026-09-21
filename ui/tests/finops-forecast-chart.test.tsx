/**
 * Tests for the FinOps ForecastChart component (Epic #47 / Issue #54).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForecastChart } from "@/components/finops/ForecastChart";
import type { CostForecast } from "@/lib/finops-api";

function forecast(over: Partial<CostForecast> = {}): CostForecast {
  return {
    id: "cf1",
    workspaceId: "w1",
    projectId: null,
    scope: "workspace",
    monthToDateCents: 5000,
    projectedMonthEndCents: 9000,
    dailyRunRateCents: 300,
    slopeCentsPerDay: 1.2,
    ewmaCents: 290,
    sampleDays: 15,
    backtestMape: 0.08,
    computedAt: "2026-06-15T06:00:00Z",
    ...over,
  };
}

describe("ForecastChart", () => {
  it("shows an empty state when there is no forecast", () => {
    render(<ForecastChart forecast={null} budgetCents={10000} />);
    expect(screen.getByText(/No forecast computed yet/i)).toBeTruthy();
  });

  it("renders MTD, projected, and run-rate figures", () => {
    render(<ForecastChart forecast={forecast()} budgetCents={10000} />);
    expect(screen.getByText("$50.00")).toBeTruthy(); // MTD
    expect(screen.getByText("$90.00")).toBeTruthy(); // projected
    expect(screen.getByText("$3.00")).toBeTruthy(); // run-rate
  });

  it("shows on-track when projected is under budget", () => {
    render(<ForecastChart forecast={forecast()} budgetCents={20000} />);
    expect(screen.getByText("On track")).toBeTruthy();
  });

  it("shows over-budget when projected exceeds budget", () => {
    render(
      <ForecastChart forecast={forecast({ projectedMonthEndCents: 30000 })} budgetCents={10000} />,
    );
    expect(screen.getByText("Over budget")).toBeTruthy();
  });

  it("surfaces the backtest MAPE", () => {
    render(<ForecastChart forecast={forecast({ backtestMape: 0.123 })} budgetCents={null} />);
    expect(screen.getByText(/MAPE.*12\.3%/i)).toBeTruthy();
  });
});
