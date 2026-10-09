/**
 * #977 — the analysis page's usage figures: the project's own budget, the
 * deployment-wide cap labelled as such, and a run's live ledger spend.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeploymentCapCard, ProjectBudgetCard, runSpendLabel } from "./analysis-usage-header";
import type { UsageSummary } from "@/lib/projects-api";

function usage(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    projectId: "p1",
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-09T00:00:00.000Z",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costCents: 1234,
    unpriced: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 },
    projectedMonthlyCostCents: 0,
    monthlyTokenBudget: 2_000_000,
    monthToDateTokens: 410_000,
    monthToDateUnpricedTokens: 0,
    byProvider: [],
    byDay: [],
    ...over,
  };
}

describe("ProjectBudgetCard (#977)", () => {
  it("shows the project's month-to-date tokens against its own budget, and its cost", () => {
    render(<ProjectBudgetCard usage={usage()} />);
    expect(screen.getByText("This project, this month")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-project-budget-tokens")).toHaveTextContent(
      "410.0k / 2.00M tokens",
    );
    expect(screen.getByTestId("analysis-project-budget-cost")).toHaveTextContent("$12.34");
    expect(screen.queryByText("project budget reached")).not.toBeInTheDocument();
  });

  it("says when the project has no budget, and flags a reached one", () => {
    const { unmount } = render(<ProjectBudgetCard usage={usage({ monthlyTokenBudget: null })} />);
    expect(screen.getByTestId("analysis-project-budget-tokens")).toHaveTextContent(
      "410.0k tokens · no project budget",
    );
    unmount();
    render(
      <ProjectBudgetCard
        usage={usage({
          monthlyTokenBudget: 400_000,
          unpriced: { inputTokens: 0, outputTokens: 0, totalTokens: 900, calls: 1 },
        })}
      />,
    );
    expect(screen.getByText("project budget reached")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-project-budget-cost")).toHaveTextContent(
      "$12.34 + 900 unpriced tokens",
    );
  });
});

describe("DeploymentCapCard (#977)", () => {
  it("labels the cap as deployment-wide", () => {
    render(
      <DeploymentCapCard
        cap={{
          monthlyCap: 5_000_000,
          monthlyUsed: 1_530_000,
          monthlyRemaining: 3_470_000,
          monthBucket: "2026-10",
          exceeded: false,
        }}
      />,
    );
    const card = screen.getByTestId("analysis-deployment-cap");
    expect(card).toHaveTextContent("Deployment-wide analysis cap (all projects)");
    expect(card).toHaveTextContent("1.53M / 5.00M");
  });

  it("shows an unlimited cap and an exceeded one", () => {
    const { unmount } = render(
      <DeploymentCapCard
        cap={{
          monthlyCap: 0,
          monthlyUsed: 10,
          monthlyRemaining: 0,
          monthBucket: "x",
          exceeded: false,
        }}
      />,
    );
    expect(screen.getByTestId("analysis-deployment-cap")).toHaveTextContent("10 / ∞");
    unmount();
    render(
      <DeploymentCapCard
        cap={{
          monthlyCap: 5,
          monthlyUsed: 9,
          monthlyRemaining: 0,
          monthBucket: "x",
          exceeded: true,
        }}
      />,
    );
    expect(screen.getByText("cap exceeded")).toBeInTheDocument();
  });
});

describe("runSpendLabel (#977)", () => {
  it("shows a running run's live ledger tokens and unrounded cost, not totalTokens = 0", () => {
    expect(
      runSpendLabel({
        totalTokens: 0,
        ledgerUsage: { totalTokens: 41_000, costUsd: 0.01234, unpricedTokens: 0 },
      }),
    ).toBe("41.0k tok · $0.0123");
  });

  it("names unpriced tokens, and reads unpriced when nothing was priced", () => {
    expect(
      runSpendLabel({
        totalTokens: 0,
        ledgerUsage: { totalTokens: 2_000, costUsd: 0.5, unpricedTokens: 900 },
      }),
    ).toBe("2.0k tok · $0.5000 + 900 unpriced tok");
    expect(
      runSpendLabel({
        totalTokens: 0,
        ledgerUsage: { totalTokens: 900, costUsd: null, unpricedTokens: 900 },
      }),
    ).toBe("900 tok · unpriced");
  });

  it("falls back to the run's own totalTokens when the ledger has none or is unreadable", () => {
    expect(
      runSpendLabel({
        totalTokens: 1_500,
        ledgerUsage: { totalTokens: 0, costUsd: 0, unpricedTokens: 0 },
      }),
    ).toBe("1.5k tok");
    expect(runSpendLabel({ totalTokens: 1_500, ledgerUsage: null })).toBe("1.5k tok");
    expect(runSpendLabel({ totalTokens: 1_500 })).toBe("1.5k tok");
  });
});
