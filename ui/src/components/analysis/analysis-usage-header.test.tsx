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

describe("runSpendLabel (#977, #1007)", () => {
  const ledger = (withoutCache: number, withCache: number, costUsd: number | null = 0.01234) => ({
    totalTokens: withCache,
    costUsd,
    unpricedTokens: 0,
    tokens: { withoutCache, withCache },
  });

  it("shows a running run's live ledger tokens, with and without cache, and unrounded cost", () => {
    expect(
      runSpendLabel({ totalTokens: 0, status: "running", ledgerUsage: ledger(41_000, 52_300) }),
    ).toBe("41.0k tok without cache · 52.3k with cache · $0.0123");
  });

  it("shows the handoff run's two ledger figures, never the total stored at finish (#1007)", () => {
    expect(
      runSpendLabel({
        totalTokens: 439_244,
        status: "completed",
        ledgerUsage: ledger(457_901, 545_197, 0.3352),
      }),
    ).toBe("457.9k tok without cache · 545.2k with cache · $0.3352");
  });

  it("names unpriced tokens, and reads unpriced when nothing was priced", () => {
    expect(
      runSpendLabel({
        totalTokens: 0,
        ledgerUsage: { ...ledger(2_000, 2_000, 0.5), unpricedTokens: 900 },
      }),
    ).toBe("2.0k tok without cache · 2.0k with cache · $0.5000 + 900 unpriced tok");
    expect(
      runSpendLabel({
        totalTokens: 0,
        ledgerUsage: { ...ledger(900, 900, null), unpricedTokens: 900 },
      }),
    ).toBe("900 tok without cache · 900 with cache · unpriced");
  });

  it("reads in progress, not 0 tok, for a run that is going with no ledger row yet", () => {
    for (const status of ["running", "pending"]) {
      expect(runSpendLabel({ totalTokens: 0, status, ledgerUsage: ledger(0, 0, 0) })).toBe(
        "in progress",
      );
      expect(runSpendLabel({ totalTokens: 0, status, ledgerUsage: null })).toBe("in progress");
    }
  });

  it("says a stored total is that, and WHY the ledger's figure is not shown", () => {
    // The ledger was read and holds no row for the run.
    const absent = "1.5k tok recorded at finish (not in the ledger)";
    expect(
      runSpendLabel({ totalTokens: 1_500, status: "completed", ledgerUsage: ledger(0, 0, 0) }),
    ).toBe(absent);
    // Read, empty, and sent without the two figures: still "not in the ledger".
    expect(
      runSpendLabel({
        totalTokens: 1_500,
        ledgerUsage: { totalTokens: 0, costUsd: 0, unpricedTokens: 0 },
      }),
    ).toBe(absent);
    // The ledger could not be read: its rows may well be there.
    const unread = "1.5k tok recorded at finish (ledger unavailable)";
    expect(runSpendLabel({ totalTokens: 1_500, ledgerUsage: null })).toBe(unread);
    expect(runSpendLabel({ totalTokens: 1_500 })).toBe(unread);
    expect(runSpendLabel({ totalTokens: 0, status: "cancelled" })).toBe("ledger unavailable");
    expect(
      runSpendLabel({ totalTokens: 0, status: "cancelled", ledgerUsage: ledger(0, 0, 0) }),
    ).toBe("0 tok");
  });

  it("labels a ledger total that came without the two figures as with cache", () => {
    expect(
      runSpendLabel({
        totalTokens: 0,
        ledgerUsage: { totalTokens: 41_000, costUsd: 0.01234, unpricedTokens: 0 },
      }),
    ).toBe("41.0k tok with cache · $0.0123");
  });
});
